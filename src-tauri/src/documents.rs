//! Persistent annotation-document store.
//!
//! A "document" is an ongoing screenshot-annotation process (a tab in the UI),
//! distinct from the ephemeral capture cache (`$APPCACHE/captures`, which the OS
//! may purge). Each document lives in its own folder under
//! `$APPLOCALDATA/documents/<id>/` and is self-contained:
//!
//! - `base.png` / `base-<ts>-<seq>.png` — a copy of the working raster
//!   (capture, or the result of a crop/cut). Owned by the document, not the
//!   cache, so it survives a cache purge / restart. Re-basing writes a new
//!   file rather than overwriting (see `replace_document_base`); the manifest's
//!   `base_file` names the current one and stale ones are pruned at restore.
//! - `annotations.json` — the vector overlay. Opaque to Rust: the frontend owns
//!   the annotation schema; we store/serve the string as-is.
//! - `current.png` — the flattened render (base + annotations) the frontend
//!   produces via `renderFlattenedPng`. This is the artifact "copy path" / the
//!   thumbnail / export point at, so it always matches what the user sees.
//!
//! A top-level `index.json` manifest lists every document's metadata. The
//! frontend drives the lifecycle (create on capture, save on edit, delete on
//! consent) and orders the strip by `updatedAt`; Rust owns durability + path
//! trust. Document files live outside the default capture-trust root, so
//! `crate::capture::verify_capture_source` is extended to trust this root too,
//! and the asset-protocol scope is widened to it at startup.
//!
//! This module is the `AppHandle`-bound glue (path resolution, manifest
//! read/modify/write around each command); the manifest entry types, the
//! atomic-write primitive, and corruption recovery are pure logic split out
//! into `document_store` so they're unit-testable on Windows (see that
//! module's doc comment for why this module itself is excluded from Windows
//! `cargo test` builds).
//!
//! Manifest access (`read_manifest` -> mutate -> `write_manifest`) has no
//! synchronization of its own; every command below that does a manifest
//! read-modify-write acquires `MANIFEST_LOCK` across the whole span. Today
//! that's redundant with Tauri 2 serializing non-async commands on the IPC
//! thread, but that serialization is an implementation detail we don't
//! control, not a contract these commands are written against — the lock
//! makes correctness independent of it, so these commands stay safe if any of
//! them is ever made async.

use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager};

use crate::capture::{error_message, verify_capture_source};
use crate::document_store::{self, is_valid_doc_id, DocumentMeta, DocumentRecord};

/// Guards every manifest read-modify-write span (see the module doc comment).
static MANIFEST_LOCK: Mutex<()> = Mutex::new(());

/// Encoded-PNG size ceiling for a document's `current.png`, mirroring the
/// clipboard/export caps so a malformed payload can't drive a runaway write.
const MAX_DOCUMENT_PNG_BYTES: usize = 256 * 1024 * 1024;

static NEXT_DOC_SEQ: AtomicU64 = AtomicU64::new(1);

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Generate a filesystem-safe, collision-resistant document id. Timestamp keeps
/// ids unique across restarts (the in-process sequence resets); the sequence
/// disambiguates same-millisecond creates.
fn new_doc_id() -> String {
    let seq = NEXT_DOC_SEQ.fetch_add(1, Ordering::SeqCst);
    format!("doc-{}-{}", now_millis(), seq)
}

fn documents_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(error_message)?
        .join("documents");
    fs::create_dir_all(&dir).map_err(error_message)?;
    Ok(dir)
}

/// Widen the `asset:` protocol scope to the documents root so the webview can
/// render each document's `base.png` / `current.png` via `asset://`. The default
/// scope is `$APPCACHE/**` (tauri.conf.json); the store lives under
/// `$APPLOCALDATA`, so without this the editor's `<img>` loads are refused.
/// Best-effort, mirroring `settings::extend_asset_scope_for_save_directory`.
pub(crate) fn extend_asset_scope(app: &AppHandle) {
    let Ok(dir) = documents_root(app) else {
        return;
    };
    if let Err(err) = app.asset_protocol_scope().allow_directory(&dir, true) {
        log::warn!("could not extend asset scope for documents: {err}");
    }
}

/// Canonicalized documents root, used by the capture-trust check to accept this
/// store's files. `None` when the root doesn't exist yet (no documents created).
pub(crate) fn documents_root_canonical(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("documents"))
        .and_then(|d| d.canonicalize().ok())
}

fn doc_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !is_valid_doc_id(id) {
        return Err("Invalid document id.".to_string());
    }
    Ok(documents_root(app)?.join(id))
}

fn manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(documents_root(app)?.join("index.json"))
}

/// Read the manifest, recovering from corruption in place (see
/// `document_store::read_manifest_from`): a parse/read failure renames the bad
/// file aside and logs at `error` level *before* returning an empty list, and —
/// since an `AppHandle` is already in hand here — also surfaces a system
/// notification, mirroring `notify_settings_reset` in `lib.rs`. Every command
/// below reads through this wrapper, so the notification fires at most once per
/// corruption event: after the rename, the next call finds no manifest file at
/// all, which is the ordinary "no documents yet" case, not a recovery.
fn read_manifest(app: &AppHandle) -> Vec<DocumentMeta> {
    let Ok(path) = manifest_path(app) else {
        return Vec::new();
    };
    let (manifest, recovery) = document_store::read_manifest_from(&path);
    if let Some(recovery) = recovery {
        notify_manifest_recovery(app, &recovery);
    }
    manifest
}

/// Tell the user when the documents manifest had to be reset after corruption.
/// A silent reset would read as "ScreenPick lost my screenshots list for no
/// reason"; this explains what happened and where the bad file was preserved.
/// Best-effort — a notification failure must not affect recovery. Mirrors
/// `notify_settings_reset` in `lib.rs`.
fn notify_manifest_recovery(app: &AppHandle, recovery: &document_store::ManifestRecovery) {
    use tauri_plugin_notification::NotificationExt;

    let mut body = format!(
        "Your saved screenshots list {} and had to be reset. Existing document folders on disk were not deleted.",
        recovery.reason
    );
    if let Some(path) = &recovery.backup_path {
        body.push_str(&format!(" The previous file was kept at {path}."));
    }
    let _ = app
        .notification()
        .builder()
        .title("ScreenPick")
        .body(body)
        .show();
}

fn write_manifest(app: &AppHandle, manifest: &[DocumentMeta]) -> Result<(), String> {
    let path = manifest_path(app)?;
    document_store::write_manifest_to(&path, manifest)
}

/// Build the frontend-facing record for an existing manifest entry by attaching
/// its on-disk paths and loading its annotation JSON (defaulting to an empty
/// array if the file is missing/unreadable).
fn record_for(app: &AppHandle, meta: DocumentMeta) -> Result<DocumentRecord, String> {
    let dir = doc_dir(app, &meta.id)?;
    let base = dir.join(document_store::base_file_name(&meta));
    let current = dir.join("current.png");
    let annotations =
        fs::read_to_string(dir.join("annotations.json")).unwrap_or_else(|_| "[]".to_string());
    Ok(DocumentRecord {
        id: meta.id,
        mode: meta.mode,
        title: meta.title,
        width: meta.width,
        height: meta.height,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        dirty: meta.dirty,
        base_path: base.to_string_lossy().into_owned(),
        current_path: current.to_string_lossy().into_owned(),
        annotations,
    })
}

// List all persisted documents, newest-modified first (the strip's MRU order).
// Manifest entries whose folder has vanished are silently dropped.
//
// This is also where superseded base rasters get pruned: the frontend calls
// this command once, at startup restore, before any document is opened — the
// only moment no editor undo history can reference an older base file (see
// `DocumentMeta::base_file`). If a second call site ever appears, the pruning
// must move, not run there.
#[tauri::command]
#[specta::specta]
pub(crate) fn list_documents(app: AppHandle) -> Result<Vec<DocumentRecord>, String> {
    let mut manifest = read_manifest(&app);
    manifest.retain(|meta| {
        doc_dir(&app, &meta.id)
            .is_ok_and(|dir| dir.join(document_store::base_file_name(meta)).is_file())
    });
    for meta in &manifest {
        if let Ok(dir) = doc_dir(&app, &meta.id) {
            document_store::prune_stale_base_files(&dir, document_store::base_file_name(meta));
        }
    }
    manifest.sort_by_key(|meta| std::cmp::Reverse(meta.updated_at));
    manifest
        .into_iter()
        .map(|meta| record_for(&app, meta))
        .collect()
}

// Create a document from a freshly captured (and trust-verified) source image.
// Copies the raster into the document folder as both `base.png` and the initial
// `current.png`, seeds an empty annotation layer, and appends a manifest entry.
#[tauri::command]
#[specta::specta]
pub(crate) fn create_document(
    app: AppHandle,
    source_path: String,
    mode: String,
    title: String,
    width: u32,
    height: u32,
) -> Result<DocumentRecord, String> {
    let canonical_source = verify_capture_source(&app, &source_path)?;
    let id = new_doc_id();
    let dir = doc_dir(&app, &id)?;
    fs::create_dir_all(&dir).map_err(error_message)?;

    let base = dir.join("base.png");
    fs::copy(&canonical_source, &base).map_err(error_message)?;
    // current.png starts identical to the base — no annotations yet.
    fs::copy(&base, dir.join("current.png")).map_err(error_message)?;
    document_store::write_atomic(&dir.join("annotations.json"), b"[]")?;

    let now = now_millis();
    let meta = DocumentMeta {
        id,
        mode,
        title,
        width,
        height,
        created_at: now,
        updated_at: now,
        dirty: false,
        base_file: None,
    };
    let guard = MANIFEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut manifest = read_manifest(&app);
    manifest.push(meta.clone());
    write_manifest(&app, &manifest)?;
    drop(guard);
    record_for(&app, meta)
}

// Replace a document's working raster (crop/cut produce a new base image while
// the annotation process continues; undo/redo across a crop/cut re-bases back).
// Writes the raster to a NEW uniquely-named base file — never over the current
// one: for a document restored from disk, the editor's `capture.path` (and its
// undo history) points at the document's own base file, so overwriting in place
// would destroy the very raster an undo needs to re-base from. The manifest
// commits the switch (copy fully lands before `write_manifest`, so a failed
// copy leaves the old base in effect); superseded files are pruned at the next
// restore. Also updates the metadata dimensions/title and bumps `updated_at`.
// The caller follows up with `save_document` to write the transformed
// annotations + re-rendered current.
#[tauri::command]
#[specta::specta]
pub(crate) fn replace_document_base(
    app: AppHandle,
    id: String,
    source_path: String,
    title: String,
    width: u32,
    height: u32,
) -> Result<DocumentRecord, String> {
    let canonical_source = verify_capture_source(&app, &source_path)?;
    let dir = doc_dir(&app, &id)?;
    if !dir.is_dir() {
        return Err("Document not found.".to_string());
    }
    let base_file = document_store::new_base_file_name(
        now_millis(),
        NEXT_DOC_SEQ.fetch_add(1, Ordering::SeqCst),
    );
    fs::copy(&canonical_source, dir.join(&base_file)).map_err(error_message)?;

    let guard = MANIFEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut manifest = read_manifest(&app);
    let meta = manifest
        .iter_mut()
        .find(|meta| meta.id == id)
        .ok_or_else(|| "Document not found.".to_string())?;
    meta.title = title;
    meta.width = width;
    meta.height = height;
    meta.updated_at = now_millis();
    meta.base_file = Some(base_file);
    let updated = meta.clone();
    write_manifest(&app, &manifest)?;
    drop(guard);
    record_for(&app, updated)
}

// Persist a document's annotation layer and its flattened render, and update its
// dirty flag / `updated_at`. `current_png` is the frontend's `renderFlattenedPng`
// output for the current (base + annotations) state.
#[tauri::command]
#[specta::specta]
pub(crate) fn save_document(
    app: AppHandle,
    id: String,
    annotations: String,
    current_png: Vec<u8>,
    dirty: bool,
) -> Result<DocumentRecord, String> {
    if current_png.len() > MAX_DOCUMENT_PNG_BYTES {
        return Err("Rendered image is too large to save.".to_string());
    }
    let dir = doc_dir(&app, &id)?;
    if !dir.is_dir() {
        return Err("Document not found.".to_string());
    }
    document_store::write_atomic(&dir.join("annotations.json"), annotations.as_bytes())?;
    document_store::write_atomic(&dir.join("current.png"), &current_png)?;

    let guard = MANIFEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut manifest = read_manifest(&app);
    let meta = manifest
        .iter_mut()
        .find(|meta| meta.id == id)
        .ok_or_else(|| "Document not found.".to_string())?;
    meta.dirty = dirty;
    meta.updated_at = now_millis();
    let updated = meta.clone();
    write_manifest(&app, &manifest)?;
    drop(guard);
    record_for(&app, updated)
}

// Delete a document and its folder. Used both for consent-confirmed close of a
// dirty document and for automatic eviction of a clean one; the consent rule is
// enforced by the frontend, which only calls this once it's allowed to discard.
#[tauri::command]
#[specta::specta]
pub(crate) fn delete_document(app: AppHandle, id: String) -> Result<(), String> {
    let dir = doc_dir(&app, &id)?;
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(error_message)?;
    }
    let _guard = MANIFEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut manifest = read_manifest(&app);
    manifest.retain(|meta| meta.id != id);
    write_manifest(&app, &manifest)
}
