//! The app's one atomic-write primitive. Pure (no `AppHandle`), so it sits in
//! the ungated module group and is unit-tested on Windows like its siblings.
//! The document store and the settings store both write through it.

use std::{
    fs,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

/// Write bytes durably: a unique sibling temp file (pid + nanosecond timestamp,
/// so two concurrent writers — or a crash-and-retry — can't collide on the same
/// tmp name), `sync_all` before rename (so a power loss can't leave a
/// zero-length/half-written target on NTFS — the exact failure mode that used
/// to be able to feed the corrupt-manifest recovery path below), then rename
/// over the target — retrying once on Windows if the destination already
/// exists (see `rename_replacing`) — and finally, on POSIX, an fsync of the
/// containing directory (see `sync_parent_dir`). The tmp file is removed on any
/// failure so a write that doesn't complete doesn't litter the directory
/// forever. This is the single atomic-write primitive for the app: the document
/// store and settings.rs both call it rather than keeping their own copy.
///
/// What a returned `Ok` guarantees after a power loss: the target holds either
/// the complete new bytes or the complete previous ones, never a mix — that is
/// the file `sync_all`. On POSIX it now also guarantees the *new* bytes, since
/// the rename that publishes them has been flushed too; before the directory
/// sync, a crash could roll a completed save back to the previous content. On
/// Windows the directory sync is skipped (see `sync_parent_dir`), so the
/// torn-file guarantee holds there and the roll-back window does not close.
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
    sync_parent_dir(parent);
    Ok(())
}

/// Flush the directory entry the rename in `write_atomic` just created.
///
/// On POSIX filesystems the file's own `sync_all` makes its CONTENT durable,
/// but the rename that publishes it under the target name is a change to the
/// *directory*, and that is not on disk until the directory itself is synced.
/// Without this, a power loss immediately after a save can come back with the
/// previous file content — never a torn file, but a silently rolled-back one,
/// under a call that had already reported success.
///
/// Best-effort and non-fatal, matching how `document_store` treats secondary
/// failures (`prune_stale_base_files`, `backup_corrupt_file`): the
/// rename has already landed, so returning an error here would tell the caller
/// nothing was written when the new content is in fact in place — and on the
/// save path that error reaches the user as "could not save".
#[cfg(not(windows))]
fn sync_parent_dir(parent: &Path) {
    match fs::File::open(parent) {
        Ok(dir) => {
            if let Err(err) = dir.sync_all() {
                log::warn!(
                    "could not flush directory {} after an atomic write: {err}",
                    parent.display()
                );
            }
        }
        Err(err) => log::warn!(
            "could not open directory {} to flush it after an atomic write: {err}",
            parent.display()
        ),
    }
}

/// No-op on Windows: a directory can't be opened as a file to be synced this
/// way, and NTFS metadata ordering is not the POSIX rename problem above. The
/// Windows-specific hazard `write_atomic` does have to handle — a rename onto
/// an existing destination failing — is dealt with by `rename_replacing`.
#[cfg(windows)]
fn sync_parent_dir(_parent: &Path) {}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir_for(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "screenpick-atomic-write-test-{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        path
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
}
