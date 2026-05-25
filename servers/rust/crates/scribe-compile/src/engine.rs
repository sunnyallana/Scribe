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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_name_canonical_values() {
        assert_eq!(EngineKind::parse_name("tectonic"), Some(EngineKind::Tectonic));
        assert_eq!(EngineKind::parse_name("latexmk"), Some(EngineKind::Latexmk));
    }

    #[test]
    fn parse_name_accepts_overleaf_alias() {
        // Operators coming from Overleaf often think of the latexmk
        // pipeline as "the Overleaf engine"; we accept it as a synonym
        // so `COMPILE_ENGINE=overleaf` Just Works.
        assert_eq!(EngineKind::parse_name("overleaf"), Some(EngineKind::Latexmk));
    }

    #[test]
    fn parse_name_is_case_and_whitespace_insensitive() {
        for input in ["TECTONIC", "Tectonic", "  tectonic  ", "\ttectonic\n"] {
            assert_eq!(
                EngineKind::parse_name(input),
                Some(EngineKind::Tectonic),
                "input '{input}' should normalise to Tectonic"
            );
        }
    }

    #[test]
    fn parse_name_rejects_unknown() {
        for input in ["", "pdflatex", "xelatex", "garbage", "tectonic-overleaf"] {
            assert_eq!(
                EngineKind::parse_name(input),
                None,
                "input '{input}' must not parse"
            );
        }
    }

    #[test]
    fn default_kind_is_tectonic() {
        // The "no LaTeX install required" promise depends on this.
        assert_eq!(EngineKind::default(), EngineKind::Tectonic);
    }

    #[test]
    fn name_round_trips_parse() {
        for engine in [EngineKind::Tectonic, EngineKind::Latexmk] {
            assert_eq!(EngineKind::parse_name(engine.name()), Some(engine));
        }
    }

    #[test]
    fn engine_config_default_picks_tectonic() {
        let config = EngineConfig::default();
        assert_eq!(config.kind, EngineKind::Tectonic);
    }
}
