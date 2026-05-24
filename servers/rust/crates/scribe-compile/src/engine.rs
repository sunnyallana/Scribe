//! Engine dispatch: choose between Tectonic (default; single binary,
//! auto-fetched packages) and latexmk (Overleaf-style; needs local TeX
//! Live or MiKTeX but compiles 3-4× faster on warm caches).
//!
//! Both engines produce the same `CompileOutcome` so the worker can
//! treat them identically.

use std::path::Path;

use crate::latexmk::{run_latexmk, LatexmkConfig};
use crate::tectonic::{run_tectonic, CompileOutcome, TectonicConfig};

/// Top-level engine selector. Surfaced in the server config as
/// `compile_engine = "tectonic" | "latexmk"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EngineKind {
    /// Single static binary, auto-fetches CTAN packages, deterministic
    /// builds. Slower (~4 s per warm compile on a modern dev box) but
    /// trivial to deploy.
    #[default]
    Tectonic,
    /// Overleaf-style: latexmk wrapping pdflatex/xelatex/lualatex from
    /// a local TeX Live or MiKTeX install. Faster (~1.2 s warm) but
    /// requires the distribution to be present on the host.
    Latexmk,
}

impl EngineKind {
    pub fn parse_name(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "tectonic" => Some(Self::Tectonic),
            "latexmk" | "overleaf" => Some(Self::Latexmk),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Tectonic => "tectonic",
            Self::Latexmk => "latexmk",
        }
    }
}

/// All knobs the worker needs to drive *whichever* engine is selected.
/// Holds both engine configs so switching at runtime is a one-line
/// change rather than a re-wire.
#[derive(Debug, Clone, Default)]
pub struct EngineConfig {
    pub kind: EngineKind,
    pub tectonic: TectonicConfig,
    pub latexmk: LatexmkConfig,
}

/// Single dispatch entry point used by the worker. Picks the right
/// underlying runner based on `config.kind`.
pub async fn run_compile(
    config: &EngineConfig,
    workdir: &Path,
    main_file: &str,
) -> CompileOutcome {
    match config.kind {
        EngineKind::Tectonic => run_tectonic(&config.tectonic, workdir, main_file).await,
        EngineKind::Latexmk => run_latexmk(&config.latexmk, workdir, main_file).await,
    }
}
