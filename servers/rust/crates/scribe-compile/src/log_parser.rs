//! Minimal LaTeX log parser.
//!
//! Extracts the entries the editor displays in its lint gutter and the
//! footer compile-state badge. The TS version in
//! `packages/compiler-client/log-parser.ts` is more thorough; this is a
//! deliberately small port that handles the common cases:
//!
//!   * `! <message>`          → error
//!   * `LaTeX Warning: <msg>` → warning
//!   * `LaTeX Error: <msg>`   → error
//!   * `Overfull \\hbox …`    → warning (informational, but useful)
//!   * `Underfull \\hbox …`   → warning
//!
//! Line/file context, when easy to extract from the `l.N` and
//! `(./path.tex` pattern, is attached. Anything more sophisticated
//! (badly-spaced citations, nested file inclusion tracking) is left to
//! the client-side parser in `packages/compiler-client`, which still
//! runs on the raw log we upload to storage.

use scribe_shared::{CompileLogEntry, CompileLogLevel};

const MAX_ENTRIES: usize = 200;

pub fn parse(log: &str) -> Vec<CompileLogEntry> {
    let mut entries: Vec<CompileLogEntry> = Vec::new();
    let mut current_file: Option<String> = None;

    for raw_line in log.lines() {
        if entries.len() >= MAX_ENTRIES {
            break;
        }
        let line = raw_line.trim_end();

        if let Some(file) = scan_file_token(line) {
            current_file = Some(file);
        }

        if let Some(rest) = line.strip_prefix("! ") {
            entries.push(CompileLogEntry {
                level: CompileLogLevel::Error,
                message: rest.to_string(),
                file: current_file.clone(),
                line: None,
                raw: Some(raw_line.to_string()),
            });
            continue;
        }

        if let Some(rest) = line.strip_prefix("LaTeX Error: ") {
            entries.push(CompileLogEntry {
                level: CompileLogLevel::Error,
                message: rest.to_string(),
                file: current_file.clone(),
                line: None,
                raw: Some(raw_line.to_string()),
            });
            continue;
        }

        if let Some(rest) = line.strip_prefix("LaTeX Warning: ") {
            entries.push(CompileLogEntry {
                level: CompileLogLevel::Warning,
                message: rest.to_string(),
                file: current_file.clone(),
                line: extract_line_suffix(rest),
                raw: Some(raw_line.to_string()),
            });
            continue;
        }

        if line.starts_with("Overfull \\hbox") || line.starts_with("Underfull \\hbox") {
            entries.push(CompileLogEntry {
                level: CompileLogLevel::Warning,
                message: line.to_string(),
                file: current_file.clone(),
                line: None,
                raw: Some(raw_line.to_string()),
            });
            continue;
        }

        // `l.NN <text>` is the line-pointer that often follows a `!` error.
        if let Some(rest) = line.strip_prefix("l.") {
            if let Some((num_str, _)) = rest.split_once(' ') {
                if let Ok(n) = num_str.parse::<i32>() {
                    if let Some(last) = entries.last_mut() {
                        if last.line.is_none() {
                            last.line = Some(n);
                        }
                    }
                }
            }
        }
    }

    entries
}

/// Match patterns like `(./chapters/intro.tex` that LaTeX prints when
/// entering a file. We snapshot the path so subsequent errors get the
/// file attached.
fn scan_file_token(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let after_paren = trimmed.strip_prefix('(')?;
    let path: String = after_paren.chars().take_while(|c| !c.is_whitespace() && *c != ')').collect();
    if path.is_empty() || !path.contains('.') {
        return None;
    }
    Some(path)
}

/// Trailing ` on input line 42.` style suffix on a LaTeX Warning.
fn extract_line_suffix(msg: &str) -> Option<i32> {
    let idx = msg.rfind("on input line ")?;
    let rest = &msg[idx + "on input line ".len()..];
    let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    num_str.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_up_bang_error() {
        let log = "! Undefined control sequence.\n";
        let entries = parse(log);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message, "Undefined control sequence.");
        assert!(matches!(entries[0].level, CompileLogLevel::Error));
    }

    #[test]
    fn attaches_line_number_from_l_marker() {
        let log = "! Undefined control sequence.\nl.42 \\foo\n";
        let entries = parse(log);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].line, Some(42));
    }

    #[test]
    fn warning_with_input_line() {
        let log = "LaTeX Warning: Reference `eq:foo' on input line 7 undefined.\n";
        let entries = parse(log);
        assert_eq!(entries.len(), 1);
        assert!(matches!(entries[0].level, CompileLogLevel::Warning));
        assert_eq!(entries[0].line, Some(7));
    }

    #[test]
    fn file_token_carries_to_next_error() {
        let log = "(./chapters/intro.tex\n! Missing \\begin{document}.\n";
        let entries = parse(log);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file.as_deref(), Some("./chapters/intro.tex"));
    }
}
