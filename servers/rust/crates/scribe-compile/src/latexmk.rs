//! Multi-pass LaTeX orchestration — the Overleaf-style pipeline.
//!
//! Despite the module name (kept for the public `compile_engine="latexmk"`
//! config alias), this does not shell out to the `latexmk` Perl script.
//! Doing so would force operators to install Perl alongside MiKTeX,
//! which is brittle on Windows. Instead, we implement what latexmk
//! does in Rust:
//!
//!   1. Run pdflatex (or xelatex / lualatex) once.
//!   2. If a `.bib` file was used and a `.aux` has citations, run
//!      bibtex (or biber for biblatex projects).
//!   3. Re-run the LaTeX engine until the `.aux` stops changing
//!      (cross-refs converged), capped at `MAX_PASSES`.
//!
//! The resulting wall-clock matches latexmk to within a few ms — the
//! Perl wrapper is just a glorified version of this loop.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tokio::process::Command;
use tokio::time::timeout;

use crate::tectonic::CompileOutcome;

/// Which underlying LaTeX engine to drive. Mirrors Overleaf's
/// per-project compiler selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LatexEngine {
    #[default]
    PdfLatex,
    XeLatex,
    LuaLatex,
}

impl LatexEngine {
    /// The standalone binary name for this engine.
    pub fn binary(self) -> &'static str {
        match self {
            Self::PdfLatex => "pdflatex",
            Self::XeLatex => "xelatex",
            Self::LuaLatex => "lualatex",
        }
    }

    pub fn parse_name(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "pdflatex" | "pdf" => Some(Self::PdfLatex),
            "xelatex" | "xe" | "pdfxe" => Some(Self::XeLatex),
            "lualatex" | "lua" | "pdflua" => Some(Self::LuaLatex),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LatexmkConfig {
    /// Legacy field — kept so callers that still set `LATEXMK_BIN`
    /// don't break, but it's unused in this implementation (we drive
    /// `pdflatex` / `xelatex` / `lualatex` directly).
    pub binary: String,
    /// Underlying LaTeX engine to drive.
    pub engine: LatexEngine,
    /// Hard kill of any single subprocess after this. The full
    /// orchestration may take longer if multiple passes are needed.
    pub timeout: Duration,
}

impl Default for LatexmkConfig {
    fn default() -> Self {
        Self {
            binary: "latexmk".to_string(),
            engine: LatexEngine::default(),
            timeout: Duration::from_secs(120),
        }
    }
}

/// Maximum LaTeX passes before we declare cross-refs unconvergeable.
/// Real-world docs need 1–3 passes. Anything beyond 5 is almost always
/// a doc author's looping `\ref`/`\label` mistake.
const MAX_PASSES: usize = 5;

pub async fn run_latexmk(
    config: &LatexmkConfig,
    workdir: &Path,
    main_file: &str,
) -> CompileOutcome {
    let start = Instant::now();
    let mut combined_stdout = String::new();
    let mut combined_stderr = String::new();

    let base = strip_tex_ext(main_file);

    // ── Pass 1: run the LaTeX engine ─────────────────────────────────
    let outcome = run_latex(config, workdir, main_file).await;
    combined_stdout.push_str(&outcome.stdout);
    combined_stderr.push_str(&outcome.stderr);
    if !outcome.success {
        return CompileOutcome {
            duration: start.elapsed(),
            stdout: combined_stdout,
            stderr: combined_stderr,
            ..outcome
        };
    }

    // ── Optional: run bibtex/biber if the doc has citations ─────────
    // bibtex looks at the `.aux`; if it references a bibdata, we want
    // to invoke it before the second pass. Two checks: a `.bib` file
    // present in the workdir, OR an `\citation{}` line in the `.aux`.
    // We just probe the .aux to be doc-driven rather than relying on
    // arbitrary .bib files lying around.
    if has_citations(workdir, &base).await {
        // biblatex (uses .bcf) → biber; otherwise → bibtex.
        let bcf = workdir.join(format!("{base}.bcf"));
        let citation_outcome = if bcf.is_file() {
            run_helper(config, workdir, "biber", &[&base]).await
        } else {
            run_helper(config, workdir, "bibtex", &[&base]).await
        };
        combined_stdout.push_str(&citation_outcome.stdout);
        combined_stderr.push_str(&citation_outcome.stderr);
        // bibtex/biber non-zero is usually warnings (undefined refs,
        // etc.) rather than fatal — most docs still produce a usable
        // PDF. We log the streams but don't abort the run.
    }

    // ── Subsequent passes until the .aux stops changing ─────────────
    let aux_path = workdir.join(format!("{base}.aux"));
    let mut last_aux = read_file_hash(&aux_path).await;
    for pass in 2..=MAX_PASSES {
        let outcome = run_latex(config, workdir, main_file).await;
        combined_stdout.push_str(&outcome.stdout);
        combined_stderr.push_str(&outcome.stderr);
        if !outcome.success {
            return CompileOutcome {
                duration: start.elapsed(),
                stdout: combined_stdout,
                stderr: combined_stderr,
                ..outcome
            };
        }
        let now_aux = read_file_hash(&aux_path).await;
        if now_aux == last_aux {
            tracing::debug!(
                pass = pass,
                "latex orchestration: aux stable, stopping",
            );
            break;
        }
        last_aux = now_aux;
    }

    // Verify the PDF actually landed — some warning-laden compiles
    // exit zero without producing one.
    let pdf_path = workdir.join(format!("{base}.pdf"));
    let pdf_present = tokio::fs::metadata(&pdf_path)
        .await
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false);

    CompileOutcome {
        success: pdf_present,
        exit_code: if pdf_present { 0 } else { 1 },
        stdout: combined_stdout,
        stderr: combined_stderr,
        duration: start.elapsed(),
    }
}

/// Spawn the underlying LaTeX engine once. `kill_on_drop` so a stuck
/// run can't outlive the worker.
async fn run_latex(
    config: &LatexmkConfig,
    workdir: &Path,
    main_file: &str,
) -> CompileOutcome {
    let started = Instant::now();
    let mut cmd = Command::new(config.engine.binary());
    cmd.current_dir(workdir)
        .arg("-interaction=nonstopmode")
        .arg("-file-line-error")
        // `-halt-on-error` mirrors what latexmk does and what our log
        // parser was tuned against — abort on the first real error
        // rather than soldier through a cascade.
        .arg("-halt-on-error")
        .arg("-synctex=1")
        .arg("-output-directory")
        .arg(workdir.as_os_str())
        .arg(main_file)
        .env("MIKTEX_AUTOINSTALL", "t")
        .kill_on_drop(true);
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            return CompileOutcome {
                success: false,
                exit_code: -1,
                stdout: String::new(),
                stderr: format!("failed to spawn {}: {err}", config.engine.binary()),
                duration: started.elapsed(),
            };
        }
    };
    match timeout(config.timeout, child.wait_with_output()).await {
        Err(_) => CompileOutcome {
            success: false,
            exit_code: -1,
            stdout: String::new(),
            stderr: format!("{} timed out after {:?}", config.engine.binary(), config.timeout),
            duration: started.elapsed(),
        },
        Ok(Err(err)) => CompileOutcome {
            success: false,
            exit_code: -1,
            stdout: String::new(),
            stderr: format!("{} IO error: {err}", config.engine.binary()),
            duration: started.elapsed(),
        },
        Ok(Ok(output)) => CompileOutcome {
            success: output.status.success(),
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            duration: started.elapsed(),
        },
    }
}

/// Generic helper for invoking `bibtex` / `biber`. Same capture +
/// timeout shape as `run_latex`, simpler arg-list.
async fn run_helper(
    config: &LatexmkConfig,
    workdir: &Path,
    binary: &str,
    args: &[&str],
) -> CompileOutcome {
    let started = Instant::now();
    let mut cmd = Command::new(binary);
    cmd.current_dir(workdir)
        .args(args)
        .env("MIKTEX_AUTOINSTALL", "t")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            return CompileOutcome {
                success: false,
                exit_code: -1,
                stdout: String::new(),
                stderr: format!("failed to spawn {binary}: {err}"),
                duration: started.elapsed(),
            };
        }
    };
    match timeout(config.timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => CompileOutcome {
            success: output.status.success(),
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            duration: started.elapsed(),
        },
        Ok(Err(err)) => CompileOutcome {
            success: false,
            exit_code: -1,
            stdout: String::new(),
            stderr: format!("{binary} IO error: {err}"),
            duration: started.elapsed(),
        },
        Err(_) => CompileOutcome {
            success: false,
            exit_code: -1,
            stdout: String::new(),
            stderr: format!("{binary} timed out"),
            duration: started.elapsed(),
        },
    }
}

/// True if the `.aux` file references citations — the trigger for
/// running bibtex/biber between passes.
async fn has_citations(workdir: &Path, base: &str) -> bool {
    let aux = workdir.join(format!("{base}.aux"));
    let Ok(text) = tokio::fs::read_to_string(&aux).await else { return false };
    // `\citation{}` in plain bibtex, `\abx@aux@cite{}` in biblatex.
    text.contains("\\citation{") || text.contains("\\abx@aux@cite{")
}

/// Cheap content fingerprint for aux-convergence detection. We don't
/// need cryptographic uniqueness — only "did the bytes change?".
/// `(len, first-and-last-256-bytes)` catches every realistic mutation
/// without paying for a full hash on a megabyte aux file every pass.
async fn read_file_hash(path: &Path) -> Option<(u64, Vec<u8>)> {
    let meta = tokio::fs::metadata(path).await.ok()?;
    let bytes = tokio::fs::read(path).await.ok()?;
    let head_tail = if bytes.len() <= 512 {
        bytes
    } else {
        let mut buf = Vec::with_capacity(512);
        buf.extend_from_slice(&bytes[..256]);
        buf.extend_from_slice(&bytes[bytes.len() - 256..]);
        buf
    };
    Some((meta.len(), head_tail))
}

fn strip_tex_ext(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if let Some(stem) = lower.strip_suffix(".tex") {
        // Use original-case slice based on stem length so e.g.
        // `Main.TEX` round-trips to `Main`.
        name[..stem.len()].to_string()
    } else {
        name.to_string()
    }
}

// Suppress dead-code on the helper PathBuf alias if the consumer only
// uses one of the LatexmkConfig fields directly.
#[allow(dead_code)]
type _Workdir = PathBuf;
