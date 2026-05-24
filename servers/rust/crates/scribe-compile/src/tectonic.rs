//! Tectonic subprocess invocation.
//!
//! Mirrors the args the Node worker uses:
//!   `tectonic --synctex --keep-logs --outdir <workdir> <mainFile>`
//!
//! Output streams are captured to in-memory buffers so we can both
//! return them for log persistence AND publish them to Redis pub/sub.
//! For a v1 the buffer-the-whole-thing approach is fine — compile
//! output is bounded and we want to apply the LaTeX log parser to the
//! full text anyway.

use std::path::Path;
use std::time::{Duration, Instant};

use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug)]
pub struct CompileOutcome {
    pub success: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration: Duration,
}

#[derive(Debug, Clone)]
pub struct TectonicConfig {
    /// Path to the tectonic binary, or just "tectonic" to use $PATH.
    pub binary: String,
    /// Hard kill after this. Matches the Node `COMPILE_TIMEOUT_MS` default.
    pub timeout: Duration,
    /// Persistent cache directory. When set, tectonic reuses its
    /// downloaded-package cache between compiles — a fresh project's
    /// first compile drops from 5–30 s (CTAN fetches) to 1–2 s.
    /// Falls back to tectonic's default (`XDG_CACHE_HOME` on Unix,
    /// `%LOCALAPPDATA%` on Windows) when None.
    pub cache_dir: Option<std::path::PathBuf>,
    /// Pass `--only-cached` to tectonic, which skips the per-compile
    /// freshness check against the CTAN bundle (saves 1-3 s on warm
    /// runs). Defaults to true because:
    ///   • the bundle's already cached after the first compile, and
    ///   • the worker has a fallback engine to handle the rare case
    ///     where a needed package isn't cached yet.
    /// Set to false to force tectonic to revalidate against the
    /// network on every compile.
    pub only_cached: bool,
}

impl Default for TectonicConfig {
    fn default() -> Self {
        Self {
            binary: "tectonic".to_string(),
            timeout: Duration::from_secs(120),
            cache_dir: None,
            only_cached: true,
        }
    }
}

pub async fn run_tectonic(
    config: &TectonicConfig,
    workdir: &Path,
    main_file: &str,
) -> CompileOutcome {
    let start = Instant::now();
    let mut cmd = Command::new(&config.binary);
    cmd.current_dir(workdir)
        .arg("--synctex")
        .arg("--keep-logs")
        .arg("--outdir")
        .arg(workdir.as_os_str());
    // `--only-cached` skips the bundle freshness handshake on every
    // compile. Big win on warm runs (1-3 s). Place BEFORE the main
    // file argument; tectonic's CLI takes the file as positional.
    if config.only_cached {
        cmd.arg("--only-cached");
    }
    cmd.arg(main_file).kill_on_drop(true);

    // Point tectonic at a persistent cache so package downloads from
    // CTAN are reused between compiles. tectonic respects
    // `TECTONIC_CACHE_DIR` (and falls back to platform defaults).
    if let Some(dir) = config.cache_dir.as_deref() {
        cmd.env("TECTONIC_CACHE_DIR", dir);
        // On Unix tectonic uses XDG; mirror it so the same flag works
        // there too without surprises.
        cmd.env("XDG_CACHE_HOME", dir);
    }

    // Capture both streams; we feed them through the log parser AND
    // upload the combined text as compile.log.
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return CompileOutcome {
                success: false,
                exit_code: -1,
                stdout: String::new(),
                stderr: format!("failed to spawn tectonic: {err}"),
                duration: start.elapsed(),
            };
        }
    };

    let output_future = child.wait_with_output();
    let result = timeout(config.timeout, output_future).await;

    match result {
        Err(_) => CompileOutcome {
            success: false,
            exit_code: -1,
            stdout: String::new(),
            stderr: format!("tectonic timed out after {:?}", config.timeout),
            duration: start.elapsed(),
        },
        Ok(Err(err)) => CompileOutcome {
            success: false,
            exit_code: -1,
            stdout: String::new(),
            stderr: format!("tectonic IO error: {err}"),
            duration: start.elapsed(),
        },
        Ok(Ok(output)) => {
            let exit_code = output.status.code().unwrap_or(-1);
            CompileOutcome {
                success: output.status.success(),
                exit_code,
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                duration: start.elapsed(),
            }
        }
    }
}
