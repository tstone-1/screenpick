//! The app's one atomic-write primitive. Pure (no `AppHandle`), so it sits in
//! the ungated module group and is unit-tested on Windows like its siblings.
//! The document store, the settings store, the PNG export and the command-line
//! capture all write through it.

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
/// to be able to feed the corrupt-manifest recovery path in `document_store`),
/// then rename over the target (`fs::rename` replaces an existing destination
/// on both Unix and Windows) and finally, on POSIX, an fsync of the
/// containing directory (see `sync_parent_dir`). The tmp file is removed on any
/// failure so a write that doesn't complete doesn't litter the directory
/// forever. This is the single atomic-write primitive for the app: the document
/// store, settings.rs, the PNG export and the CLI capture all call it rather
/// than keeping their own copy. A bare file name is written in the current
/// directory (see `parent_or_dot`).
///
/// What a returned `Ok` guarantees after a power loss: the target holds either
/// the complete new bytes or the complete previous ones, never a mix — that is
/// the file `sync_all`. On POSIX it now also guarantees the *new* bytes, since
/// the rename that publishes them has been flushed too; before the directory
/// sync, a crash could roll a completed save back to the previous content. On
/// Windows the directory sync is skipped (see `sync_parent_dir`), so the
/// torn-file guarantee holds there and the roll-back window does not close.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = parent_or_dot(path);
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
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    sync_parent_dir(parent);
    Ok(())
}

/// The directory `path` lives in. `Path::parent` returns an empty path, not
/// `None`, for a bare file name such as `shot.png`, and an empty path cannot be
/// opened for the directory sync, so both cases mean the current directory.
fn parent_or_dot(path: &Path) -> &Path {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    }
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
/// way, and NTFS metadata ordering is not the POSIX rename problem above.
#[cfg(windows)]
fn sync_parent_dir(_parent: &Path) {}

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

    // `fs::rename` replaces an existing destination on Windows
    // (MOVEFILE_REPLACE_EXISTING) as well as on Unix, so an overwrite needs no
    // remove-and-retry: the second write wins and no tmp file is left.
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

    // The export and the CLI rely on this: the old file is replaced by a
    // rename, never opened and truncated, so a write that fails halfway cannot
    // damage it. A second hard link to the old file tells the two apart: a
    // write through the file would change what the link reads, a rename only
    // moves the name.
    #[test]
    fn an_overwrite_replaces_the_file_and_never_writes_into_it() {
        let dir = temp_dir_for("write-atomic-replaces");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("shot.png");
        let other_link = dir.join("other-link.png");
        fs::write(&target, b"old").unwrap();
        fs::hard_link(&target, &other_link).unwrap();

        write_atomic(&target, b"new").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read(&other_link).unwrap(), b"old");

        fs::remove_dir_all(&dir).ok();
    }

    // `screenpick capture screen -o shot.png` passes a bare name. The temp file
    // and the directory sync must both use the current directory then, not an
    // empty path. Tested on the helper so no test changes the working directory
    // of the shared test process.
    #[test]
    fn a_bare_file_name_lives_in_the_current_directory() {
        assert_eq!(parent_or_dot(Path::new("shot.png")), Path::new("."));
        assert_eq!(parent_or_dot(Path::new("")), Path::new("."));
        assert_eq!(
            parent_or_dot(Path::new("out").join("shot.png").as_path()),
            Path::new("out")
        );
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
