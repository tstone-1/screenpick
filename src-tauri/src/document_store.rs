//! Pure (`AppHandle`-free) core of the documents manifest store: the manifest
//! entry type, atomic-write primitive, and corruption recovery. Split out from
//! `documents.rs` — which imports `tauri::AppHandle` and is therefore excluded
//! from Windows `cargo test` builds (see the `cfg` gate in `lib.rs`) — so this
//! logic can be unit-tested where development actually happens. Same pattern as
//! `capture_modes` / `capture_trust` / `export_validation` / `monitor_pairing` /
//! `shortcut_config`. `documents.rs` is a thin `AppHandle`-plumbing wrapper
//! around the functions here.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use specta::Type;

/// Persisted metadata for one document, as stored in `index.json`. Paths and
/// annotation contents are derived/loaded separately (by `documents.rs`, which
/// has the `AppHandle` needed to resolve them) so the manifest stays small and
/// is the single ordering/source-of-truth list.
#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentMeta {
    pub(crate) id: String,
    pub(crate) mode: String,
    pub(crate) title: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    // Epoch-millis timestamps. Specta forbids exporting u64 (BigInt) to TS, so
    // type them as f64 — ms timestamps stay well under 2^53, exact in a JS number.
    #[specta(type = f64)]
    pub(crate) created_at: u64,
    #[specta(type = f64)]
    pub(crate) updated_at: u64,
    /// True once the document carries annotation work. Drives the
    /// consent-on-close rule (clean documents auto-evict; dirty ones don't).
    pub(crate) dirty: bool,
    /// File name of the document's current base raster inside its folder.
    /// `None` means the original `base.png` (also the value for manifests
    /// written before re-basing became versioned — `#[serde(default)]` keeps
    /// them loading). Each `replace_document_base` writes a NEW uniquely-named
    /// base file instead of overwriting: the editor's undo history holds
    /// captures whose `path` may point at an older base (a document restored
    /// from disk starts with `path` = its own base file), so overwriting in
    /// place would corrupt the raster that history re-bases from. Superseded
    /// base files are pruned at restore time, when no undo history can
    /// reference them yet.
    #[serde(default)]
    pub(crate) base_file: Option<String>,
}

// A document as handed to the frontend: its metadata plus the on-disk paths and
// the current annotation JSON, so the editor can render and reference it without
// reconstructing paths itself. Flat (no `#[serde(flatten)]`) so the specta
// TypeScript export stays a plain object type. Plain `//` comments (not `///`):
// `///` on a specta-exposed item emits JSDoc into bindings.ts and drifts the
// generated contract from the committed file.
#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentRecord {
    pub(crate) id: String,
    pub(crate) mode: String,
    pub(crate) title: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    #[specta(type = f64)]
    pub(crate) created_at: u64,
    #[specta(type = f64)]
    pub(crate) updated_at: u64,
    pub(crate) dirty: bool,
    pub(crate) base_path: String,
    pub(crate) current_path: String,
    // The `annotations.json` contents verbatim (a JSON-encoded `Annotation[]`).
    pub(crate) annotations: String,
}

/// The file name of `meta`'s current base raster (see `DocumentMeta::base_file`).
pub(crate) fn base_file_name(meta: &DocumentMeta) -> &str {
    meta.base_file.as_deref().unwrap_or("base.png")
}

/// Unique name for a re-based raster. Timestamp + sequence mirrors the doc-id
/// scheme: unique across restarts and within a same-millisecond burst.
pub(crate) fn new_base_file_name(now_ms: u64, seq: u64) -> String {
    format!("base-{now_ms}-{seq}.png")
}

/// Delete superseded base rasters (`base.png` / `base-*.png` other than `keep`)
/// from a document folder. Only safe when no editor session holds undo history
/// into this document — i.e. at restore time, before the document is opened.
/// Best-effort: a file that can't be removed is left behind (it costs disk, not
/// correctness) and logged at `warn`.
pub(crate) fn prune_stale_base_files(dir: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let is_base = name == "base.png" || (name.starts_with("base-") && name.ends_with(".png"));
        if is_base && name != keep {
            if let Err(err) = fs::remove_file(entry.path()) {
                log::warn!(
                    "could not prune superseded base raster {}: {err}",
                    entry.path().display()
                );
            }
        }
    }
}

/// Strictly validate an id received from the frontend before it is used to build
/// a filesystem path, so a crafted id can never escape the documents root
/// (path traversal / separator injection).
pub(crate) fn is_valid_doc_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.starts_with("doc-")
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Write bytes durably: a unique sibling temp file (pid + nanosecond timestamp,
/// so two concurrent writers — or a crash-and-retry — can't collide on the same
/// tmp name), `sync_all` before rename (so a power loss can't leave a
/// zero-length/half-written target on NTFS — the exact failure mode that used
/// to be able to feed the corrupt-manifest recovery path below), then rename
/// over the target — retrying once on Windows if the destination already
/// exists (see `rename_replacing`). The tmp file is removed on any failure so a
/// write that doesn't complete doesn't litter the directory forever. This is
/// the single atomic-write primitive for the app (settings.rs calls into this
/// pure module rather than keeping its own copy — see the code review that
/// unified them).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("tmp");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(".{file_name}.tmp-{}-{ts}", std::process::id()));

    let write_result = fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    if let Err(err) = rename_replacing(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    Ok(())
}

/// Rename `tmp` onto `path`, retrying once on Windows when the destination
/// already exists. Unix `rename` always replaces an existing destination, but
/// on Windows it can fail with `AlreadyExists`; removing the destination and
/// retrying resolves it. The narrow window this opens (destination briefly
/// absent) is safe here because `tmp` has already been durably written by the
/// caller, so the retry can only ever land the new content, never a
/// half-written one.
fn rename_replacing(tmp: &Path, path: &Path) -> std::io::Result<()> {
    match fs::rename(tmp, path) {
        Ok(()) => Ok(()),
        Err(err) if cfg!(windows) && err.kind() == std::io::ErrorKind::AlreadyExists => {
            fs::remove_file(path)?;
            fs::rename(tmp, path)
        }
        Err(err) => Err(err),
    }
}

/// Serialize `manifest` and write it atomically to `path`.
pub(crate) fn write_manifest_to(path: &Path, manifest: &[DocumentMeta]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    write_atomic(path, &bytes)
}

/// A manifest recovery: the on-disk file couldn't be read/parsed and was
/// renamed aside so the next write starts from a clean slate rather than
/// permanently orphaning every other document's folder against a manifest that
/// silently lost them. Mirrors `settings::SettingsRecovery`. Internal-only —
/// never crosses the IPC boundary.
#[derive(Clone, Debug)]
pub(crate) struct ManifestRecovery {
    pub(crate) reason: String,
    pub(crate) backup_path: Option<String>,
}

/// Read and parse the manifest at `path`. A missing file is the common
/// first-run case (empty list, no recovery — not an error). An unreadable or
/// corrupt file is renamed aside to `<file-name>.corrupt-<unix-ms>`, logged at
/// `error` level, and only THEN is an empty list returned — so a caller that
/// goes on to write a fresh manifest can never do so against a corrupt file
/// still sitting at the canonical path (the orphaning bug this replaces).
pub(crate) fn read_manifest_from(path: &Path) -> (Vec<DocumentMeta>, Option<ManifestRecovery>) {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return (Vec::new(), None),
        Err(err) => {
            log::error!(
                "could not read documents manifest at {}: {err}",
                path.display()
            );
            let backup_path = backup_corrupt_manifest(path).map(|p| p.display().to_string());
            return (
                Vec::new(),
                Some(ManifestRecovery {
                    reason: "could not be read".to_string(),
                    backup_path,
                }),
            );
        }
    };
    match serde_json::from_str::<Vec<DocumentMeta>>(&text) {
        Ok(manifest) => (manifest, None),
        Err(err) => {
            log::error!(
                "invalid documents manifest JSON at {}; renaming aside and starting empty: {err}",
                path.display()
            );
            let backup_path = backup_corrupt_manifest(path).map(|p| p.display().to_string());
            (
                Vec::new(),
                Some(ManifestRecovery {
                    reason: "was corrupted".to_string(),
                    backup_path,
                }),
            )
        }
    }
}

/// Move the unreadable/corrupt manifest aside so the next write doesn't happen
/// against a file that's still sitting at the canonical path. Best-effort —
/// returns the backup path on success, or `None` (after logging) if the move
/// itself failed; the caller proceeds with an empty list either way.
fn backup_corrupt_manifest(path: &Path) -> Option<PathBuf> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("index.json");
    let mut backup = path.to_path_buf();
    backup.set_file_name(format!("{file_name}.corrupt-{ts}"));
    match fs::rename(path, &backup) {
        Ok(()) => Some(backup),
        Err(err) => {
            log::error!(
                "could not back up corrupt documents manifest at {}: {err}",
                path.display()
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir_for(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "screenpick-document-store-test-{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        path
    }

    fn sample_meta(id: &str) -> DocumentMeta {
        DocumentMeta {
            id: id.to_string(),
            mode: "region".to_string(),
            title: "Region - Display".to_string(),
            width: 800,
            height: 600,
            created_at: 10,
            updated_at: 20,
            dirty: false,
            base_file: None,
        }
    }

    #[test]
    fn doc_id_validation_rejects_traversal_and_separators() {
        assert!(is_valid_doc_id("doc-1700000000000-1"));
        assert!(is_valid_doc_id("doc-42-7"));
        assert!(!is_valid_doc_id(""));
        assert!(!is_valid_doc_id("doc-../etc"));
        assert!(!is_valid_doc_id("doc-1/2"));
        assert!(!is_valid_doc_id(r"doc-1\2"));
        assert!(!is_valid_doc_id("notdoc-1"));
        assert!(!is_valid_doc_id("doc-ABC")); // uppercase not allowed
        assert!(!is_valid_doc_id(&format!("doc-{}", "9".repeat(100))));
    }

    #[test]
    fn record_serializes_to_camel_case_json() {
        let record = DocumentRecord {
            id: "doc-1-1".to_string(),
            mode: "region".to_string(),
            title: "Region - Display".to_string(),
            width: 800,
            height: 600,
            created_at: 10,
            updated_at: 20,
            dirty: true,
            base_path: "/docs/doc-1-1/base.png".to_string(),
            current_path: "/docs/doc-1-1/current.png".to_string(),
            annotations: "[]".to_string(),
        };
        let json = serde_json::to_value(&record).expect("serialize");
        assert_eq!(json["id"], "doc-1-1");
        assert_eq!(json["createdAt"], 10);
        assert_eq!(json["updatedAt"], 20);
        assert_eq!(json["dirty"], true);
        assert_eq!(json["currentPath"], "/docs/doc-1-1/current.png");
        assert_eq!(json["annotations"], "[]");
    }

    // Also covers the merged Windows `AlreadyExists`-retry path in
    // `rename_replacing`: whichever way the OS's `rename` handles overwriting
    // an existing destination (direct replace, or the remove-and-retry
    // fallback), the observable contract asserted here — second write wins,
    // no leftover tmp file — must hold either way.
    #[test]
    fn write_atomic_roundtrips_and_overwrites() {
        let dir = temp_dir_for("write-atomic-roundtrip");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("payload.bin");

        write_atomic(&target, b"first").expect("first write");
        assert_eq!(fs::read(&target).unwrap(), b"first");

        write_atomic(&target, b"second-longer-payload").expect("overwrite");
        assert_eq!(fs::read(&target).unwrap(), b"second-longer-payload");

        // No leftover tmp files after successful writes.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "expected no leftover tmp files");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_atomic_cleans_up_tmp_on_failed_rename() {
        let dir = temp_dir_for("write-atomic-failure");
        fs::create_dir_all(&dir).unwrap();
        // A target that is itself an existing directory makes the final rename
        // fail (a file can't be renamed onto a directory) after the tmp file has
        // already been written — exercising the cleanup path.
        let target = dir.join("target-is-a-dir");
        fs::create_dir_all(&target).unwrap();

        let result = write_atomic(&target, b"data");
        assert!(result.is_err(), "expected rename onto a directory to fail");

        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "expected the tmp file to be cleaned up after a failed rename, found {leftovers:?}"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn base_file_name_defaults_to_original_base() {
        let mut meta = sample_meta("doc-1-1");
        assert_eq!(base_file_name(&meta), "base.png");
        meta.base_file = Some("base-99-3.png".to_string());
        assert_eq!(base_file_name(&meta), "base-99-3.png");
        assert_eq!(new_base_file_name(99, 3), "base-99-3.png");
    }

    // Manifests written before base rasters became versioned have no `baseFile`
    // key; they must keep loading (as the original `base.png`), not be treated
    // as corrupt.
    #[test]
    fn manifest_without_base_file_key_still_parses() {
        let json = r#"[{"id":"doc-1-1","mode":"region","title":"T","width":8,"height":6,
            "createdAt":10,"updatedAt":20,"dirty":false}]"#;
        let manifest: Vec<DocumentMeta> = serde_json::from_str(json).expect("legacy manifest");
        assert_eq!(manifest.len(), 1);
        assert!(manifest[0].base_file.is_none());
        assert_eq!(base_file_name(&manifest[0]), "base.png");
    }

    #[test]
    fn prune_stale_base_files_keeps_current_and_non_base_files() {
        let dir = temp_dir_for("prune-bases");
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "base.png",
            "base-1-1.png",
            "base-2-1.png",
            "current.png",
            "annotations.json",
        ] {
            fs::write(dir.join(name), b"x").unwrap();
        }

        prune_stale_base_files(&dir, "base-2-1.png");

        assert!(!dir.join("base.png").exists());
        assert!(!dir.join("base-1-1.png").exists());
        assert!(dir.join("base-2-1.png").exists());
        assert!(dir.join("current.png").exists());
        assert!(dir.join("annotations.json").exists());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn manifest_write_read_roundtrip() {
        let dir = temp_dir_for("manifest-roundtrip");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("index.json");
        let manifest = vec![sample_meta("doc-1-1"), sample_meta("doc-2-1")];

        write_manifest_to(&path, &manifest).expect("write manifest");
        let (read_back, recovery) = read_manifest_from(&path);
        assert!(
            recovery.is_none(),
            "a freshly written manifest is not a recovery"
        );
        assert_eq!(read_back.len(), 2);
        assert_eq!(read_back[0].id, "doc-1-1");
        assert_eq!(read_back[1].id, "doc-2-1");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_manifest_from_missing_file_returns_empty_without_recovery() {
        let dir = temp_dir_for("manifest-missing");
        let path = dir.join("index.json"); // dir itself doesn't exist yet
        let (manifest, recovery) = read_manifest_from(&path);
        assert!(manifest.is_empty());
        assert!(recovery.is_none(), "a missing file is not a recovery");
    }

    // A corrupt manifest must not be silently emptied in place — the corrupt
    // file has to be renamed aside (so it isn't clobbered by the next write) and
    // the caller told a recovery happened, not just handed a quiet empty Vec.
    #[test]
    fn corrupt_manifest_is_not_silently_emptied() {
        let dir = temp_dir_for("manifest-corrupt");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("index.json");
        fs::write(&path, "not json at all").unwrap();

        let (manifest, recovery) = read_manifest_from(&path);

        assert!(manifest.is_empty());
        let recovery = recovery.expect("a corrupt manifest should report a recovery");
        assert_eq!(recovery.reason, "was corrupted");
        assert!(
            !path.exists(),
            "expected the corrupt manifest to be renamed aside, still present at {:?}",
            path
        );
        let backup_path = recovery
            .backup_path
            .expect("recovery should point at the preserved backup");
        let backup = PathBuf::from(&backup_path);
        assert!(
            backup.exists(),
            "expected the renamed-aside corrupt file to exist at {:?}",
            backup
        );
        assert!(backup_path.contains("index.json.corrupt-"));

        fs::remove_dir_all(&dir).ok();
    }
}
