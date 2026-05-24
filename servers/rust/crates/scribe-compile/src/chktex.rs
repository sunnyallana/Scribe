//! chktex integration. Runs `chktex` against the project's .tex
//! files after a successful compile and folds its warnings into the
//! existing `CompileLogEntry` stream so the editor underlines style
//! issues the same way it underlines TeX errors.
//!
//! Skipped when `CHKTEX_BIN` isn't configured or the binary isn't on
//! PATH — chktex is an opt-in quality-of-life feature, not a hard
//! requirement. We don't fail the compile if it errors; we just log
//! and return no entries.
//!
//! Output format is locked to `chktex -f "%f:%l:%c:%n:%m\n"` which
//! gives us one line per warning with fields separated by `:`:
//!     <file>:<line>:<column>:<warning_number>:<message>
//! That's the most parser-friendly format chktex ships.

use std::path::Path;
use std::process::Stdio;

use scribe_shared::{CompileLogEntry, CompileLogLevel};
use tokio::process::Command;
use tracing::{debug, warn};

#[derive(Debug, Clone)]
pub struct ChktexConfig {
    /// Path to the chktex binary. `None` disables the lint step
    /// entirely — the worker should skip calling `run_chktex` in
    /// that case (saves the std::process startup cost).
    pub binary: Option<String>,
    /// When `false`, pass `-I0` to chktex so it doesn't try to
    /// follow `\input{...}` chains. Needed for the live-lint
    /// endpoint where we only ship the single edited file to the
    /// server — without this, every `\input{preamble}` would
    /// trigger warning 27 ("Could not execute LaTeX command")
    /// because `preamble.tex` isn't in the scratch dir.
    pub follow_inputs: bool,
}

impl Default for ChktexConfig {
    fn default() -> Self {
        // Default true — the compile worker materialises the whole
        // project so input chains resolve naturally. Live-lint
        // overrides this on construction.
        Self { binary: None, follow_inputs: true }
    }
}

impl ChktexConfig {
    /// `true` when we have a usable binary configured. The worker
    /// gates the lint call on this to avoid spawning chktex on every
    /// compile when it isn't installed.
    pub fn enabled(&self) -> bool {
        self.binary.as_deref().is_some_and(|s| !s.is_empty())
    }
}

/// Lint all .tex files under `workdir`. Returns a flat list of
/// entries that look like compile warnings — `level=warning`, with
/// file/line/column populated so applyCompileDiagnostics can attach
/// them to the editor gutter.
///
/// The function returns Ok(empty) on transient errors (binary not
/// found, chktex crash, parse failure on a single line). Lint is an
/// auxiliary signal; we never want a chktex hiccup to fail the
/// compile or surface as a UI error.
pub async fn run_chktex(
    config: &ChktexConfig,
    workdir: &Path,
    main_file: &str,
) -> Vec<CompileLogEntry> {
    let Some(bin) = config.binary.as_deref() else { return Vec::new(); };
    if bin.is_empty() { return Vec::new(); }

    // chktex follows \input{...} chains naturally when given the
    // main file, but it doesn't handle `\include{}` of files in
    // subdirs unless we cd into the project root first. We run from
    // `workdir`.
    let mut command = Command::new(bin);
    if !config.follow_inputs {
        // `-I0` keeps chktex inside the file it was handed. Otherwise
        // it expands `\input{X}` chains and reports a noisy warning 27
        // for every chain it can't follow (very common in live-lint
        // where we only ship the active file to the server).
        command.arg("-I0");
    }
    let output = command
        // `-f FORMAT` : single-line parser-friendly format (see file head).
        // `-n<N>`     : suppress rule N. We only mute the rules that
        //               are *pure* style taste with very high false-
        //               positive rates — rule 2 ("use `~` for non-
        //               breaking space") stays enabled because it's
        //               substantive typography. We make those rules
        //               useful by appending a concrete "how to fix"
        //               hint to the message in `format_message` below.
        //                  1  Command terminated with space (`\section foo`)
        //                  8  Wrong length of dash
        //                 13  Intersentence spacing `\@`
        //                 22  Comment displayed
        //                 24  Delete this space at end of file (fires
        //                     on virtually every multi-file project)
        //                 26  Parenthesis grouping advice
        //                 40  Inter-word spacing advice
        //               Re-enable any of them per project by setting
        //               a `.chktexrc` next to the main .tex file —
        //               chktex picks it up automatically.
        // `--`        : end-of-flags so a file named `-foo.tex` doesn't
        //               get interpreted as another flag.
        .args([
            "-q",
            "-f", "%f:%l:%c:%n:%m\n",
            "-n1", "-n8", "-n13", "-n22", "-n24", "-n26", "-n40",
            "--",
            main_file,
        ])
        .current_dir(workdir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // chktex doesn't take input on stdin; close it explicitly so
        // it can't ever block the worker thread.
        .stdin(Stdio::null())
        .output()
        .await;

    let output = match output {
        Ok(o) => o,
        Err(err) => {
            // Most likely: ENOENT (binary missing). Logged once per
            // compile is fine; ops will spot it if they wired the
            // env var but the binary path is wrong.
            warn!(?err, %bin, "chktex spawn failed; skipping lint pass");
            return Vec::new();
        }
    };

    if !output.status.success() && output.stdout.is_empty() {
        // chktex returns non-zero whenever it finds warnings; only
        // treat that as a real failure when there's no stdout to
        // parse. `stderr` usually has the diagnostic in that case.
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug!(%bin, status = ?output.status, "chktex exited non-zero with no stdout: {stderr}");
        return Vec::new();
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_chktex_output(&stdout)
}

/// Parse the `%f:%l:%c:%n:%m\n` formatted output.
/// Each well-formed line yields a single CompileLogEntry; lines that
/// don't match the format are silently skipped (handles version
/// drift if chktex ever changes its banner / footer behaviour).
fn parse_chktex_output(stdout: &str) -> Vec<CompileLogEntry> {
    let mut out = Vec::new();
    for raw_line in stdout.lines() {
        let line = raw_line.trim();
        if line.is_empty() { continue; }
        // Split on `:` from the left, but the MESSAGE may contain
        // colons. Take 5 fields with `splitn(5)`.
        let mut parts = line.splitn(5, ':');
        let file = match parts.next() { Some(s) if !s.is_empty() => s.to_string(), _ => continue };
        let line_no: u32 = match parts.next().and_then(|s| s.trim().parse().ok()) {
            Some(n) => n,
            None => continue,
        };
        let column: u32 = match parts.next().and_then(|s| s.trim().parse().ok()) {
            Some(n) => n,
            None => continue,
        };
        let warning_no = parts.next().unwrap_or("").trim();
        let message = parts.next().unwrap_or("").trim();
        if message.is_empty() { continue; }
        let labelled = format_message(warning_no, message);
        out.push(CompileLogEntry {
            level: CompileLogLevel::Warning,
            message: labelled,
            file: Some(file),
            line: Some(line_no as i32),
            column: Some(column as i32),
            raw: Some(raw_line.to_string()),
            // Tagged so the SPA can route chktex entries into the
            // "Style lint" panel instead of mixing with engine output.
            source: Some("chktex".to_string()),
        });
    }
    out
}

/// Wrap chktex's terse warning text with a "Fix:" hint where we
/// can recognise the rule. The hint is the actionable bit — chktex
/// tells you a rule was tripped, this tells you what to change.
/// Output shape:
///   `[chktex N] <original message>  Fix: <hint>`
/// When the message doesn't match anything we recognise, we still
/// keep the `[chktex N]` prefix so users can mute rules per-project
/// via a `.chktexrc` file. Suggestions are taste-neutral — they
/// describe the textbook fix, not whether the rule is worth obeying.
///
/// Why match on the message text rather than the rule number alone:
/// chktex's rule taxonomy drifts between releases. Rule 11 means
/// "ellipsis" in modern chktex but "parens grouping" in older
/// distributions. Matching the message keeps hints accurate across
/// versions — we don't outsmart ourselves by attaching a wrong fix
/// to a rule that was renumbered.
fn format_message(rule_no: &str, message: &str) -> String {
    let hint = derive_hint(message);
    match hint {
        Some(h) => format!("[chktex {rule_no}] {message}  Fix: {h}"),
        None    => format!("[chktex {rule_no}] {message}"),
    }
}

fn derive_hint(message: &str) -> Option<&'static str> {
    // Case-insensitive substring match. Order matters: most-specific
    // patterns first so we don't accidentally match a generic
    // keyword (e.g. "dash") earlier than the dash-specific rule.
    let lower = message.to_lowercase();
    // -------- math / structural --------
    if lower.contains("\\over") && lower.contains("\\frac") {
        return Some("Replace `\\over` with `\\frac{numerator}{denominator}` — `\\over` is deprecated and won't pick up `\\frac`-style sizing.");
    }
    if lower.contains("ellipsis") || (lower.contains("\\ldots") && lower.contains("\\cdots")) {
        return Some("Use `\\ldots` (baseline) or `\\cdots` (centred) instead of three literal dots `...`.");
    }
    if lower.contains("solo '$'") || lower.contains("solo `$'") || lower.contains("mathmode") {
        return Some("Use paired `$ ... $` for inline math, or `\\(...\\)` — a stray `$` toggles math mode by accident.");
    }
    if lower.contains("number of `(' doesn't match") || lower.contains("doesn't match the number of") {
        return Some("Mismatched parentheses — count `(` vs `)` in this expression.");
    }
    if lower.contains("\\eqref") && lower.contains("math") {
        return Some("`\\eqref` only works inside a numbered math environment (`equation`, `align`, …).");
    }
    // -------- spacing / typography --------
    if lower.contains("non-breaking space") {
        return Some("Replace the regular space with `~` so the reference can't be split across a line — e.g. `Figure \\ref{x}` → `Figure~\\ref{x}`.");
    }
    if lower.contains("wrong length of dash") {
        return Some("Switch the dash width: `-` for hyphens (state-of-the-art), `--` for ranges (1--10), `---` for em-dashes (parenthetical — like this).");
    }
    if lower.contains("hyphens within numbers") {
        return Some("Replace `-` between numbers with `--` (en-dash) for ranges, e.g. `pages 1--10`.");
    }
    if lower.contains("multiple spaces") {
        return Some("Collapse the runs of spaces to one — LaTeX renders multiple spaces as a single space anyway.");
    }
    if lower.contains("interword spacing") || lower.contains("inter-word spacing") {
        return Some("Use `\\ ` (backslash-space) after the abbreviation so LaTeX doesn't insert an end-of-sentence space.");
    }
    if lower.contains("intersentence spacing") || lower.contains("inter-sentence spacing") {
        return Some("Use `\\@` before the punctuation so LaTeX treats it as a sentence break (e.g. `XML\\@.`).");
    }
    if lower.contains("\\,") || lower.contains("between") && lower.contains("units") {
        return Some("Insert a thin space `\\,` between the number and its unit — e.g. `5\\,kg`, not `5kg`.");
    }
    // -------- quotes / punctuation --------
    if lower.contains("braces here") || lower.contains("opening quotes") {
        return Some("Use `` `` `` (two backticks) to open and `''` (two apostrophes) to close — typewriter `\"` quotes look wrong in PDF.");
    }
    if lower.contains("both are not") {
        return Some("Use ASCII `'` or `\\'`, not the typographic `'` — chktex can't tell which way the quote should curl.");
    }
    if lower.contains("punctuation") && lower.contains("quotes") {
        return Some("Move the punctuation outside the quotes (British style) or inside (US style) — chktex flags the mix.");
    }
    // -------- file / structure --------
    if lower.contains("could not find argument") {
        return Some("This command expected an argument but found whitespace or end-of-input — pass `{}` or the missing brace.");
    }
    if lower.contains("delete this space") {
        return Some("Trailing space at end of file shifts page references — delete the final blank line / trailing whitespace.");
    }
    if lower.contains("\\nocite") {
        return Some("`\\cite` belongs in the document; `\\nocite{key}` adds an entry to the bibliography without citing it.");
    }
    // -------- comments / commands --------
    if lower.contains("comment displayed") {
        return Some("Add a `%` at the end of the line so the trailing newline is absorbed as nothing instead of a space.");
    }
    if lower.contains("command terminated with space") {
        return Some("Follow `\\command ` with `{}` (e.g. `\\TeX{}`) so the following space isn't eaten by the command name.");
    }
    if lower.contains("encloses") || lower.contains("enclose the previous parenthesis") {
        return Some("Wrap the preceding parenthesis in `{}` so it isn't scaled to fit the equation height.");
    }
    if lower.contains("pagereferences must always be preceded") {
        return Some("Add the leading punctuation chktex expects right before the `\\pageref` (the rule's `.chktexrc` knob is `Pageref`).");
    }
    if lower.contains("could not execute latex command") {
        return Some("chktex couldn't resolve a `\\input{...}` / `\\include{...}` / custom macro from the surrounding source. Often safe to ignore; the file probably exists elsewhere in the project and a full compile resolves it.");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use scribe_shared::CompileLogLevel;

    #[test]
    fn parses_simple_lines() {
        let out = parse_chktex_output(
            "main.tex:12:5:8:Wrong length of dash may have been used.\n\
             chapters/intro.tex:3:1:1:Command terminated with space.\n",
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].file.as_deref(), Some("main.tex"));
        assert_eq!(out[0].line, Some(12));
        assert_eq!(out[0].column, Some(5));
        assert!(out[0].message.starts_with("[chktex 8]"));
    }

    #[test]
    fn skips_malformed_lines() {
        let out = parse_chktex_output("not a real chktex line\n:::::\n");
        assert!(out.is_empty());
    }

    #[test]
    fn preserves_colons_in_message() {
        // chktex messages can include colons (e.g. "Foo: bar: baz");
        // verify the parser doesn't truncate at the first one.
        let out = parse_chktex_output(
            "a.tex:1:1:2:Non-breaking space (`~'): expected here: see manual.\n",
        );
        assert_eq!(out.len(), 1);
        assert!(out[0]
            .message
            .starts_with("[chktex 2] Non-breaking space (`~'): expected here: see manual."));
        // This message DOES match the hint pattern → Fix: line included.
        assert!(out[0].message.contains("Fix:"));
    }

    #[test]
    fn rule_without_hint_omits_fix_line() {
        // 99 isn't in the hint map; expect plain `[chktex N] msg` only.
        let out = parse_chktex_output("a.tex:1:1:99:Some new rule\n");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].message, "[chktex 99] Some new rule");
    }

    #[test]
    fn every_entry_is_a_warning_with_chktex_source() {
        // Mix of common rules — every entry should be tagged warning
        // level + source="chktex" so the SPA routes them to the lint
        // section regardless of which rule fired.
        let out = parse_chktex_output(
            "a.tex:1:1:2:Non-breaking space.\n\
             a.tex:2:1:9:Wrong dash.\n\
             a.tex:3:1:17:Unbalanced paren.\n\
             a.tex:4:1:36:\\over deprecated.\n",
        );
        assert_eq!(out.len(), 4);
        for e in &out {
            assert!(matches!(e.level, CompileLogLevel::Warning));
            assert_eq!(e.source.as_deref(), Some("chktex"));
        }
    }

    #[test]
    fn hint_text_covers_the_well_known_messages() {
        // We match hints on chktex message TEXT, not rule numbers
        // (rule numbers drift between chktex versions). Each case
        // pairs a message fragment chktex emits with a substring
        // we expect in the Fix: line.
        let cases = [
            ("Non-breaking space (`~') should have been used.", "~"),
            ("Wrong length of dash may have been used.", "dash"),
            ("Number of `(' doesn't match the number of `)'.", "parentheses"),
            ("\\eqref outside math context.", "math"),
            ("You should use \\frac{}{} not \\over.", "\\frac"),
            ("You should use \\cdots or \\ldots to achieve an ellipsis.", "\\ldots"),
            ("Solo '$' is not allowed.", "math"),
            ("Multiple spaces detected in input.", "single space"),
            ("Delete this space to maintain correct pagereferences.", "Trailing space"),
            ("Command terminated with space.", "TeX{}"),
        ];
        for (message, needle) in cases {
            let msg = format_message("X", message);
            assert!(
                msg.contains("Fix:"),
                "message `{message}` should produce a Fix: line (got `{msg}`)",
            );
            assert!(
                msg.contains(needle),
                "Fix for `{message}` should mention `{needle}` (got `{msg}`)",
            );
        }
    }

    #[test]
    fn drops_zero_width_or_zero_index_fields() {
        // chktex very occasionally emits `0` for col on a zero-width
        // match; we treat those as no-position so the editor doesn't
        // try to underline an empty span.
        let out = parse_chktex_output("a.tex:1:0:2:Edge case.\n");
        // We DO parse it — column=0 is technically valid in our wire
        // format — but the *web client*'s schema (.positive()) drops
        // these. Verify we at least make it past the parser.
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].column, Some(0));
    }

    #[test]
    fn handles_unicode_paths_and_messages() {
        // chktex prints file paths and offending tokens verbatim. Make
        // sure we don't choke on non-ASCII characters (common in
        // multilingual sources).
        let out = parse_chktex_output(
            "résumé/intro.tex:42:7:2:Non-breaking space — replace «foo \\cite{x}».\n",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].file.as_deref(), Some("résumé/intro.tex"));
        assert!(out[0].message.contains("«foo \\cite{x}»"));
    }
}
