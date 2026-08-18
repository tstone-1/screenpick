//! `AppHandle`-bound half of the capture-trust gate: it resolves *where* the
//! trusted roots live on this machine and hands them to the policy in
//! `capture_trust`, which decides what they mean.
//!
//! Keep it that way. This module is `AppHandle`-bound, so it is excluded from
//! `cargo test` on Windows (see `lib.rs`) — a trust check written here is a
//! check no Windows test run can see, while `capture_trust` is pure and covered.
//! Nothing below may accept or reject a path; it may only look roots up.
//!
//! The gate lives in its own module because both of its callers own one of its
//! roots: `capture`'s commands need it, `documents`' commands need it, and the
//! documents root belongs to `documents`. Hosting it in either one made the two
//! modules import each other.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::capture_trust::{canonicalize_capture_source, ensure_capture_source_trusted};
use crate::errors::error_message;

/// Resolve a webview-supplied source path and verify it names a ScreenPick
/// capture. Returns the canonical path so callers read the file they checked
/// rather than re-resolving the string they were given.
pub(crate) fn verify_capture_source(app: &AppHandle, source_path: &str) -> Result<PathBuf, String> {
    // The source is resolved before the roots: a path that does not exist
    // reports its own error, never one from a root that was only looked up in
    // order to judge it.
    let canonical_source = canonicalize_capture_source(source_path)?;

    let trusted_files = app
        .try_state::<crate::settings::SettingsState>()
        .map(|state| state.trusted_capture_files())
        .unwrap_or_default();
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(error_message)?
        .join("captures")
        .canonicalize()
        .ok();
    let documents_root = crate::documents::documents_root_canonical(app);

    ensure_capture_source_trusted(
        &canonical_source,
        &trusted_files,
        cache_root.as_deref(),
        documents_root.as_deref(),
    )?;
    Ok(canonical_source)
}
