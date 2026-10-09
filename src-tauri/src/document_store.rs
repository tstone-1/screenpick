//! Pure (`AppHandle`-free) core of the documents manifest store: the manifest
//! entry type and corruption recovery. Split out from
//! `documents.rs` — which imports `tauri::AppHandle` and is therefore excluded
//! from Windows `cargo test` builds (see the `cfg` gate in `lib.rs`) — so this
//! logic can be unit-tested where development actually happens. Same pattern as
//! `capture_modes` / `capture_trust` / `export_validation` / `monitor_pairing` /
//! `shortcut_config`. `documents.rs` is a thin `AppHandle`-plumbing wrapper
//! around the functions here.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::atomic_write::write_atomic;

/// Hard ceiling for the size of `index.json` we'll attempt to parse. Mirrors
/// `settings::MAX_SETTINGS_BYTES` and exists for the same reason: the manifest
/// is read on the startup restore path, so a corrupted or hostile file must not
/// be able to OOM the app before anything gets a chance to reject it. Entries
/// are a few hundred bytes each, so this still allows a five-figure document
/// count — far past anything the strip can usefully show.
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

/// Hard ceiling for one document's `annotations.json`, applied on both the read
/// and the write side (see `annotations_within_limit`). `list_documents` loads
/// every document's layer in a single pass at startup, so the same OOM argument
/// as the manifest applies once per document. A heavy annotation layer — pen
/// strokes carry a point per sample — is a few hundred KiB, so this is generous
/// headroom rather than a limit a real document approaches.
const MAX_ANNOTATIONS_BYTES: u64 = 8 * 1024 * 1024;

/// The empty annotation layer: what a document with no annotation work stores,
/// and what a read falls back to.
const EMPTY_ANNOTATIONS: &str = "[]";

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

/// Which direct children of the documents root are orphaned document folders:
/// names that look exactly like a document id but that no manifest entry
/// claims. `create_document` writes the folder, its rasters and its annotation
/// layer before appending the manifest entry, so a failure in that window
/// leaves a folder nothing will ever look at again — `list_documents` prunes
/// stale files of KNOWN entries and never sees an unknown folder at all.
///
/// The caller quarantines these folders: a healthy replacement manifest may
/// follow an earlier recovery, so absence is never evidence that deletion is safe.
///
/// A name that is not a valid document id is never returned. `is_valid_doc_id`
/// is reused rather than a looser `doc-*` glob, so the quarantine can only ever
/// name a folder `create_document` could itself have created. A manifest that
/// could not be read must not reach this function; the caller returns its
/// recovery first, because an unreadable manifest is not evidence about any folder.
pub(crate) fn orphan_document_folders(
    folder_names: &[String],
    manifest_ids: &[String],
) -> Vec<String> {
    let known: HashSet<&str> = manifest_ids.iter().map(String::as_str).collect();
    folder_names
        .iter()
        .filter(|name| is_valid_doc_id(name) && !known.contains(name.as_str()))
        .cloned()
        .collect()
}

// Unknown folders can contain a complete document from a recovered index.
// Keep their contents outside the active store, without overwriting an earlier
// recovery. Failed/incomplete creates use the same path and are preserved too.
pub(crate) fn quarantine_document(root: &Path, id: &str) -> Result<(), String> {
    if !is_valid_doc_id(id) {
        return Err("Invalid document id.".into());
    }
    let recovered = root.join("recovered");
    fs::create_dir_all(&recovered).map_err(|e| e.to_string())?;
    let destination = recovered.join(id);
    if destination.exists() {
        return Err("A recovered folder already exists; original left in place.".into());
    }
    fs::rename(root.join(id), destination).map_err(|e| e.to_string())
}

// Called under the manifest lock at startup. Keep the entire filesystem
// lifecycle here so tests exercise the same recovery and sweep as the app.
pub(crate) fn quarantine_unindexed_documents(
    root: &Path,
) -> Result<Option<ManifestRecovery>, String> {
    let path = root.join("index.json");
    if !path.is_file() {
        return Ok(None);
    }
    let (manifest, recovery) = read_manifest_from(&path);
    if recovery.is_some() {
        return Ok(recovery);
    }
    let entries = fs::read_dir(root).map_err(|e| e.to_string())?;
    let folders = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect::<Vec<_>>();
    let ids = manifest
        .iter()
        .map(|meta| meta.id.clone())
        .collect::<Vec<_>>();
    for id in orphan_document_folders(&folders, &ids) {
        match quarantine_document(root, &id) {
            Ok(()) => log::warn!("preserved unindexed document {id} in documents/recovered"),
            Err(err) => log::warn!("could not quarantine unindexed document {id}: {err}"),
        }
    }
    Ok(None)
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
    // Size-gate before reading. A failed `metadata` call is deliberately NOT
    // treated as an answer here — it falls through to the read below, which
    // classifies "missing" and "unreadable" apart from each other.
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > MAX_MANIFEST_BYTES {
            log::error!(
                "documents manifest at {} is oversized ({} bytes > {} max); renaming aside and starting empty",
                path.display(),
                metadata.len(),
                MAX_MANIFEST_BYTES
            );
            let backup_path = backup_corrupt_file(path).map(|p| p.display().to_string());
            return (
                Vec::new(),
                Some(ManifestRecovery {
                    reason: "was too large to read".to_string(),
                    backup_path,
                }),
            );
        }
    }
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return (Vec::new(), None),
        Err(err) => {
            log::error!(
                "could not read documents manifest at {}: {err}",
                path.display()
            );
            let backup_path = backup_corrupt_file(path).map(|p| p.display().to_string());
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
            let backup_path = backup_corrupt_file(path).map(|p| p.display().to_string());
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

/// Read a document's annotation layer, falling back to the empty layer when the
/// file is missing or unreadable — a document whose overlay can't be loaded must
/// still open on its base raster rather than disappearing from the strip.
///
/// An oversized file is renamed aside first, matching how the manifest treats a
/// file it can't use: the fallback is followed by the document's next save,
/// which would otherwise overwrite the very file the user would need to repair
/// it by hand. Nothing the app writes can reach the ceiling — `save_document`
/// rejects an over-limit layer through `annotations_within_limit` — so this only
/// fires for a hand-edited or foreign file.
pub(crate) fn read_annotations_from(path: &Path) -> String {
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > MAX_ANNOTATIONS_BYTES {
            log::error!(
                "annotation layer at {} is oversized ({} bytes > {} max); renaming aside and starting empty",
                path.display(),
                metadata.len(),
                MAX_ANNOTATIONS_BYTES
            );
            backup_corrupt_file(path);
            return EMPTY_ANNOTATIONS.to_string();
        }
    }
    fs::read_to_string(path).unwrap_or_else(|_| EMPTY_ANNOTATIONS.to_string())
}

/// Whether an incoming annotation layer is small enough to store. Checked on the
/// save path against the same ceiling `read_annotations_from` enforces, so the
/// store can never hold a layer it will later refuse to read back — an
/// asymmetric pair would accept an edit and then silently serve an empty layer
/// on the next open.
pub(crate) fn annotations_within_limit(annotations: &str) -> bool {
    annotations.len() as u64 <= MAX_ANNOTATIONS_BYTES
}

/// Move an unusable file aside so the next write doesn't happen against a file
/// that's still sitting at the canonical path. Best-effort — returns the backup
/// path on success, or `None` (after logging) if the move itself failed; the
/// caller proceeds with its empty default either way.
fn backup_corrupt_file(path: &Path) -> Option<PathBuf> {
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
                "could not back up unusable file at {}: {err}",
                path.display()
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_survives_a_new_manifest_and_later_startup_sweeps() {
        let root = temp_dir_for("recovery-restart");
        let old = root.join("doc-1-1");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("base.png"), b"original image").unwrap();
        fs::write(old.join("annotations.json"), b"original annotations").unwrap();
        let index = root.join("index.json");
        fs::write(&index, b"broken JSON").unwrap();
        assert!(quarantine_unindexed_documents(&root).unwrap().is_some());
        assert!(old.join("base.png").is_file());
        // A subsequent capture creates a valid replacement index. Recovery
        // information is no longer returned by read_manifest_from.
        let new = sample_meta("doc-2-1");
        fs::create_dir_all(root.join(&new.id)).unwrap();
        write_atomic(&index, &serde_json::to_vec(&vec![new]).unwrap()).unwrap();
        let (_, recovery) = read_manifest_from(&index);
        assert!(recovery.is_none());
        quarantine_unindexed_documents(&root).unwrap();
        quarantine_unindexed_documents(&root).unwrap();
        let recovered = root.join("recovered/doc-1-1");
        assert_eq!(
            fs::read(recovered.join("base.png")).unwrap(),
            b"original image"
        );
        assert_eq!(
            fs::read(recovered.join("annotations.json")).unwrap(),
            b"original annotations"
        );
        assert!(root.join("doc-2-1").is_dir());
        // Incomplete creates are quarantined as well; an earlier recovery is
        // never replaced if the same ID unexpectedly appears again.
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("base.png"), b"other image").unwrap();
        assert!(quarantine_document(&root, "doc-1-1").is_err());
        assert_eq!(fs::read(old.join("base.png")).unwrap(), b"other image");
        assert_eq!(
            fs::read(recovered.join("base.png")).unwrap(),
            b"original image"
        );
        fs::remove_dir_all(root).unwrap();
    }

    // The folder exists, so a missing source cannot explain the error: only the
    // id check stands between this call and a rename out of the documents root.
    #[test]
    fn quarantine_refuses_an_id_that_escapes_the_root() {
        let base = temp_dir_for("quarantine-traversal");
        let root = base.join("documents");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"keep").unwrap();

        assert!(quarantine_document(&root, "../outside").is_err());

        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"keep");
        assert!(!root.join("outside").exists());
        fs::remove_dir_all(base).unwrap();
    }

    // A recovery target that already exists is never overwritten or merged into.
    #[test]
    fn quarantine_does_not_touch_an_existing_recovery_target() {
        let root = temp_dir_for("quarantine-existing-target");
        let source = root.join("doc-5-1");
        let target = root.join("recovered").join("doc-5-1");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("base.png"), b"new").unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("base.png"), b"earlier").unwrap();

        // The message is asserted because the OS refuses a rename onto a
        // non-empty directory on its own; only the guard says "already exists".
        let err = quarantine_document(&root, "doc-5-1").unwrap_err();
        assert!(err.contains("already exists"), "unexpected error: {err}");

        assert_eq!(fs::read(target.join("base.png")).unwrap(), b"earlier");
        assert_eq!(fs::read(source.join("base.png")).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }

    // Without an index the store cannot tell what is unindexed, so nothing moves.
    #[test]
    fn quarantine_moves_nothing_when_there_is_no_index() {
        let root = temp_dir_for("quarantine-no-index");
        fs::create_dir_all(root.join("doc-6-1")).unwrap();
        fs::write(root.join("doc-6-1").join("base.png"), b"img").unwrap();

        assert!(quarantine_unindexed_documents(&root).unwrap().is_none());

        assert!(root.join("doc-6-1").join("base.png").is_file());
        assert!(!root.join("recovered").exists());
        fs::remove_dir_all(root).unwrap();
    }

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

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    // N2 in the 2026-08 code review: a create_document that failed between
    // writing its folder and appending its manifest entry left the folder
    // behind forever — list_documents prunes stale files of known entries and
    // never looks at an unknown folder.
    #[test]
    fn orphan_sweep_names_only_unreferenced_document_folders() {
        let folders = names(&["doc-1-1", "doc-2-1", "doc-3-1"]);
        let manifest = names(&["doc-2-1"]);

        let orphans = orphan_document_folders(&folders, &manifest);

        assert_eq!(orphans, names(&["doc-1-1", "doc-3-1"]));
        assert!(
            !orphans.contains(&"doc-2-1".to_string()),
            "a folder the manifest still references must never be quarantined"
        );
    }

    // The quarantine moves what this returns, so anything that isn't shaped
    // exactly like a document id has to be invisible to it, including the
    // manifest itself and the files a corruption recovery leaves beside it.
    #[test]
    fn orphan_sweep_ignores_names_that_are_not_document_ids() {
        let folders = names(&[
            "index.json",
            "index.json.corrupt-1700000000000",
            "doc-../etc",
            "documents",
            "Doc-1-1",
            "doc-1-1",
        ]);

        assert_eq!(
            orphan_document_folders(&folders, &[]),
            names(&["doc-1-1"]),
            "only the well-formed document id is a quarantine candidate"
        );
    }

    // A manifest that loaded but is empty leaves every folder unindexed. A
    // manifest that could not be read never reaches this function:
    // quarantine_unindexed_documents returns the recovery before listing folders.
    #[test]
    fn orphan_sweep_names_every_folder_for_an_empty_loaded_manifest() {
        let folders = names(&["doc-1-1", "doc-2-1"]);

        assert_eq!(orphan_document_folders(&folders, &[]), folders);
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

    // The oversized manifest here is VALID JSON (one entry plus padding), so a
    // missing size gate wouldn't fail the parse and quietly look correct — it
    // would return the entry and no recovery. Asserting the empty list *and* the
    // size-specific reason is what separates the two.
    #[test]
    fn oversized_manifest_is_backed_up_and_not_parsed() {
        let dir = temp_dir_for("manifest-oversized");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("index.json");
        let mut json = serde_json::to_string(&vec![sample_meta("doc-1-1")]).unwrap();
        // Trailing whitespace keeps the payload parseable while pushing it past
        // the ceiling.
        json.push_str(&" ".repeat((MAX_MANIFEST_BYTES as usize) + 1 - json.len()));
        assert!(json.len() as u64 > MAX_MANIFEST_BYTES);
        assert!(
            serde_json::from_str::<Vec<DocumentMeta>>(&json).is_ok(),
            "the oversized payload must be parseable, or the test proves nothing"
        );
        fs::write(&path, json.as_bytes()).unwrap();

        let (manifest, recovery) = read_manifest_from(&path);

        assert!(
            manifest.is_empty(),
            "an oversized manifest must not be read"
        );
        let recovery = recovery.expect("an oversized manifest should report a recovery");
        assert_eq!(recovery.reason, "was too large to read");
        assert!(
            !path.exists(),
            "expected the oversized manifest to be renamed aside"
        );
        let backup_path = recovery
            .backup_path
            .expect("recovery should point at the preserved backup");
        assert!(PathBuf::from(&backup_path).exists());
        assert!(backup_path.contains("index.json.corrupt-"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn annotations_read_falls_back_to_empty_layer_when_missing() {
        let dir = temp_dir_for("annotations-missing");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("annotations.json");
        assert_eq!(read_annotations_from(&path), "[]");

        fs::write(&path, br#"[{"kind":"pen","id":1}]"#).unwrap();
        assert_eq!(read_annotations_from(&path), r#"[{"kind":"pen","id":1}]"#);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversized_annotations_file_is_backed_up_and_not_read() {
        let dir = temp_dir_for("annotations-oversized");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("annotations.json");
        fs::write(&path, vec![b'x'; (MAX_ANNOTATIONS_BYTES as usize) + 1]).unwrap();

        assert_eq!(read_annotations_from(&path), "[]");
        assert!(
            !path.exists(),
            "expected the oversized annotation layer to be renamed aside"
        );
        let preserved = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).any(|e| {
            e.file_name()
                .to_string_lossy()
                .contains("annotations.json.corrupt-")
        });
        assert!(preserved, "expected the oversized file to be preserved");

        fs::remove_dir_all(&dir).ok();
    }

    // The save-side half of the ceiling: what `save_document` rejects must be
    // exactly what `read_annotations_from` would refuse to read back.
    #[test]
    fn annotations_within_limit_matches_the_read_ceiling() {
        assert!(annotations_within_limit("[]"));
        assert!(annotations_within_limit(
            &"x".repeat(MAX_ANNOTATIONS_BYTES as usize)
        ));
        assert!(!annotations_within_limit(
            &"x".repeat((MAX_ANNOTATIONS_BYTES as usize) + 1)
        ));
    }
}
