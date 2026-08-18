//! Capture-trust policy: which filesystem paths a webview-supplied argument is
//! allowed to name. Every command that takes a path from the frontend
//! (clipboard copy, reveal, crop, cut, document create/re-base) is gated by it.
//!
//! Pure and parameter-driven — the trust roots arrive as arguments, no
//! `AppHandle` — so it sits in the ungated pure-logic module group (alongside
//! `capture_modes` / `export_validation` / `monitor_pairing` / `path_utils` /
//! `shortcut_config` / `document_store`) and is unit-tested on Windows, where
//! development happens and where the `AppHandle`-bound modules are excluded
//! from `cargo test` (see `lib.rs`). Resolving *where* the roots are on this
//! machine is the job of `capture_trust_roots`; deciding what they mean is the
//! job of this file. Keep new checks on this side of that line, or no Windows
//! test run can see them.

use std::path::{Path, PathBuf};

/// Resolve a webview-supplied path before any trust comparison. Part of the
/// policy rather than a convenience: the containment checks below are path
/// prefix comparisons, so `..` segments and symlinks have to be resolved first
/// or a path outside every trusted root could spell itself as one inside. A
/// path that does not resolve (no such file, unreadable parent) is rejected
/// with the OS error rather than the trust message — the caller never learns
/// anything about trust for a path that does not exist.
pub(crate) fn canonicalize_capture_source(source_path: &str) -> Result<PathBuf, String> {
    Path::new(source_path)
        .canonicalize()
        .map_err(|error| error.to_string())
}

/// Compose the trust roots into the accept/reject decision for one already
/// canonicalized source path.
///
/// Three roots, each supplied by whichever module owns it:
/// - `trusted_files` — individual files this session created (canonicalized
///   here, so a caller can pass them exactly as recorded). They stay trusted
///   after the save directory changes, which is why they are a set of files
///   and not a root.
/// - `cache_root` — the ephemeral capture cache (`$APPCACHE/captures`).
/// - `documents_root` — the persistent document store
///   (`$APPLOCALDATA/documents`). It lives outside the capture cache, but its
///   base.png / current.png are app-managed ScreenPick images that copy-path,
///   reveal, and re-crop legitimately act on, so trust them too. Canonicalized
///   by the caller so `..` / symlinks can't smuggle in an outside path.
///
/// With no trusted files and neither root resolvable, every source is rejected:
/// this gate fails closed. Nothing here falls back to allowing the path (unlike
/// `export_validation::verify_export_destination`, which deliberately does) —
/// the roots being unresolvable means no capture could have been written in the
/// first place.
pub(crate) fn ensure_capture_source_trusted(
    canonical_source: &Path,
    trusted_files: &[PathBuf],
    cache_root: Option<&Path>,
    documents_root: Option<&Path>,
) -> Result<(), String> {
    let canonical_trusted_files = trusted_files
        .iter()
        .filter_map(|file| file.canonicalize().ok())
        .collect::<Vec<_>>();
    let trusted_in_documents =
        documents_root.is_some_and(|root| canonical_source.starts_with(root));

    if !trusted_in_documents
        && !is_capture_source_trusted(canonical_source, &canonical_trusted_files, cache_root)
    {
        return Err("Source must be a ScreenPick capture.".to_string());
    }
    Ok(())
}

pub(crate) fn is_capture_source_trusted(
    canonical_source: &Path,
    trusted_files: &[PathBuf],
    default_root: Option<&Path>,
) -> bool {
    let trusted_file = trusted_files.iter().any(|file| canonical_source == file);
    let trusted_default_root = default_root.is_some_and(|root| canonical_source.starts_with(root));
    trusted_file || trusted_default_root
}

#[cfg(test)]
mod tests {
    use super::{
        canonicalize_capture_source, ensure_capture_source_trusted, is_capture_source_trusted,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    const REJECTION: &str = "Source must be a ScreenPick capture.";

    fn temp_dir_for(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "screenpick-capture-trust-test-{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        path
    }

    // The composition works on canonical paths, so the roots a test hands it
    // have to be canonicalized exactly as the caller does — on Windows that
    // also normalizes them to the `\\?\` verbatim form both sides must share.
    fn canonical(path: &Path) -> PathBuf {
        path.canonicalize().unwrap()
    }

    fn make_file(dir: &Path, name: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, b"not-really-a-png").unwrap();
        path
    }

    #[test]
    fn rejects_non_capture_path() {
        let tmp = std::env::temp_dir();
        let source = tmp.join("not-a-capture.png");
        let root = tmp.join("captures");

        assert!(!is_capture_source_trusted(&source, &[], Some(&root)));
    }

    #[test]
    fn accepts_default_root() {
        let root = PathBuf::from("/tmp/captures");
        let source = root.join("screenpick-screen-42-1.png");

        assert!(is_capture_source_trusted(&source, &[], Some(&root)));
    }

    #[test]
    fn accepts_session_trusted_files() {
        let source = PathBuf::from("/somewhere/capture.png");
        let trusted = vec![source.clone()];

        assert!(is_capture_source_trusted(&source, &trusted, None));
    }

    #[test]
    fn accepts_session_trusted_file_after_save_dir_change() {
        let old_dir = PathBuf::from("/tmp/old-captures");
        let new_dir = PathBuf::from("/tmp/new-captures");
        let source = old_dir.join("screenpick-screen-100-2.png");
        let trusted = vec![source.clone()];

        assert!(is_capture_source_trusted(&source, &trusted, Some(&new_dir)));
    }

    #[test]
    fn rejects_untrusted_file_inside_configured_save_dir() {
        let configured_dir = PathBuf::from("/tmp/my-pictures");
        let source = configured_dir.join("not-created-by-screenpick.png");

        assert!(!is_capture_source_trusted(&source, &[], None));
    }

    #[test]
    fn rejects_partial_path_match() {
        let root = PathBuf::from("/tmp/captures");
        let source = PathBuf::from("/tmp/captures-malicious/shot.png");

        assert!(!is_capture_source_trusted(&source, &[], Some(&root)));
    }

    #[test]
    fn rejects_root_file() {
        let source = PathBuf::from("/");
        let root = PathBuf::from("/tmp/captures");

        assert!(!is_capture_source_trusted(&source, &[], Some(&root)));
    }

    #[test]
    fn ensure_accepts_file_inside_documents_root() {
        let root = temp_dir_for("documents-root");
        let source = make_file(&root.join("doc-1-1"), "base.png");
        let documents_root = canonical(&root);

        assert_eq!(
            ensure_capture_source_trusted(&canonical(&source), &[], None, Some(&documents_root)),
            Ok(())
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_accepts_file_inside_cache_root() {
        let root = temp_dir_for("cache-root");
        let source = make_file(&root, "screenpick-screen-42-1.png");
        let cache_root = canonical(&root);

        assert_eq!(
            ensure_capture_source_trusted(&canonical(&source), &[], Some(&cache_root), None),
            Ok(())
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_accepts_trusted_file_outside_every_root() {
        // The session trust set is what keeps a capture usable after the save
        // directory moves out from under it, so it must win with no root at all.
        let dir = temp_dir_for("trusted-file");
        let source = make_file(&dir, "screenpick-region-7-3.png");
        let trusted = vec![source.clone()];

        assert_eq!(
            ensure_capture_source_trusted(&canonical(&source), &trusted, None, None),
            Ok(())
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_canonicalizes_the_trusted_file_set() {
        // Callers pass the files exactly as recorded; a trusted entry reached
        // through `..` still has to match the canonical source.
        let dir = temp_dir_for("trusted-file-traversal");
        let source = make_file(&dir.join("nested"), "shot.png");
        let recorded = dir.join("nested").join("sub").join("..").join("shot.png");
        fs::create_dir_all(dir.join("nested").join("sub")).unwrap();

        assert_eq!(
            ensure_capture_source_trusted(&canonical(&source), &[recorded], None, None),
            Ok(())
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_rejects_file_outside_every_root() {
        let dir = temp_dir_for("outside-roots");
        let source = make_file(&dir, "someone-elses.png");
        let cache_root = canonical(&make_dir_only(&dir.join("captures")));
        let documents_root = canonical(&make_dir_only(&dir.join("documents")));

        assert_eq!(
            ensure_capture_source_trusted(
                &canonical(&source),
                &[],
                Some(&cache_root),
                Some(&documents_root),
            ),
            Err(REJECTION.to_string())
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_rejects_traversal_out_of_the_documents_root() {
        // The whole reason canonicalization is part of the policy: spelled as a
        // path under the documents root, resolving to one above it.
        let dir = temp_dir_for("documents-traversal");
        let outside = make_file(&dir, "outside.png");
        let documents_root = canonical(&make_dir_only(&dir.join("documents")));
        let doc_dir = make_dir_only(&documents_root.join("doc-1-1"));
        let spelled = doc_dir.join("..").join("..").join("outside.png");

        let canonical_source = canonicalize_capture_source(&spelled.to_string_lossy()).unwrap();
        assert_eq!(canonical_source, canonical(&outside));
        assert_eq!(
            ensure_capture_source_trusted(&canonical_source, &[], None, Some(&documents_root)),
            Err(REJECTION.to_string())
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_rejects_everything_when_no_root_resolves() {
        // Fail closed: a host where neither root could be resolved and nothing
        // was captured this session trusts no path at all.
        let dir = temp_dir_for("no-roots");
        let source = make_file(&dir, "screenpick-screen-1-1.png");

        assert_eq!(
            ensure_capture_source_trusted(&canonical(&source), &[], None, None),
            Err(REJECTION.to_string())
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn canonicalize_rejects_a_path_that_does_not_exist() {
        let missing = temp_dir_for("missing").join("nothing-here.png");

        let error = canonicalize_capture_source(&missing.to_string_lossy())
            .expect_err("a nonexistent path cannot be canonicalized");
        // The OS error passes through rather than the trust message: nothing
        // about the trust roots is revealed for a path that does not exist.
        assert_ne!(error, REJECTION);
    }

    fn make_dir_only(dir: &Path) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        dir.to_path_buf()
    }
}
