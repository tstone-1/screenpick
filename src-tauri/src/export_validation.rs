use std::path::{Path, PathBuf};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_EXPORT_BYTES: usize = 256 * 1024 * 1024;

pub(crate) fn validate_png_export(dest_path: &str, bytes: &[u8]) -> Result<(), String> {
    if !has_png_extension(dest_path) {
        return Err("Export destination must be a .png file.".to_string());
    }
    if bytes.is_empty() {
        return Err("Export image is empty.".to_string());
    }
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err("Export image is too large.".to_string());
    }
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("Export image must be valid PNG data.".to_string());
    }
    Ok(())
}

/// Check that `dest_path`'s parent resolves to a directory inside one of the
/// `allowed_roots`. Defends against the renderer pointing the export at an
/// arbitrary `.png`-suffixed path (e.g. `~/Library/LaunchAgents/foo.png`,
/// `~/.bashrc.png`) even though the in-app flow only writes paths the user
/// picked via the save dialog. Each root is canonicalised; the destination's
/// parent is canonicalised; symlinks resolve before the containment check.
pub(crate) fn verify_export_destination(
    dest_path: &str,
    allowed_roots: &[PathBuf],
) -> Result<(), String> {
    if allowed_roots.is_empty() {
        // Nothing was resolvable on this host — fall back to allowing the
        // write rather than blocking exports entirely. The PNG-payload check
        // above is still enforced.
        return Ok(());
    }
    let parent = Path::new(dest_path)
        .parent()
        .ok_or_else(|| "Export destination must include a directory.".to_string())?;
    let file_name = Path::new(dest_path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Export destination must include a file name.".to_string())?;
    if cfg!(windows) && file_name.contains(':') {
        return Err("Export destination file name cannot contain ':'.".to_string());
    }
    if let Ok(metadata) = std::fs::symlink_metadata(dest_path) {
        if metadata.file_type().is_symlink() {
            return Err("Export destination cannot be a symlink.".to_string());
        }
    }
    let canonical_parent = parent
        .canonicalize()
        .map_err(|_| "Export destination directory does not exist.".to_string())?;
    let in_root = allowed_roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| canonical_parent.starts_with(&root));
    if in_root {
        Ok(())
    } else {
        Err("Export destination is outside of allowed save locations.".to_string())
    }
}

fn has_png_extension(path: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
}

#[cfg(test)]
mod tests {
    use super::{has_png_extension, validate_png_export, verify_export_destination};
    use std::path::PathBuf;

    #[test]
    fn has_png_extension_accepts_only_png() {
        assert!(has_png_extension("C:/captures/shot.png"));
        assert!(has_png_extension("/tmp/shot.PNG"));
        assert!(!has_png_extension("/tmp/shot.jpg"));
        assert!(!has_png_extension("/tmp/shot"));
        assert!(!has_png_extension("/tmp/shot.png.exe"));
    }

    #[test]
    fn validate_png_export_rejects_non_png_payload() {
        assert!(validate_png_export("/tmp/shot.png", b"not a png").is_err());
        assert!(validate_png_export("/tmp/shot.png", &[]).is_err());
    }

    #[test]
    fn validate_png_export_accepts_png_signature() {
        assert!(validate_png_export("/tmp/shot.png", b"\x89PNG\r\n\x1a\nextra").is_ok());
    }

    #[test]
    fn validate_png_export_rejects_wrong_extension() {
        assert!(validate_png_export("/tmp/shot.jpg", b"\x89PNG\r\n\x1a\nextra").is_err());
    }

    fn temp_root(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "screenpick-export-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn verify_export_destination_accepts_path_inside_allowed_root() {
        let root = temp_root("ok");
        let dest = root.join("shot.png");
        let dest_str = dest.to_str().unwrap().to_string();
        assert!(verify_export_destination(&dest_str, std::slice::from_ref(&root)).is_ok());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn verify_export_destination_rejects_path_outside_allowed_roots() {
        let allowed = temp_root("allowed");
        let other = temp_root("other");
        let dest = other.join("shot.png");
        let dest_str = dest.to_str().unwrap().to_string();
        let result = verify_export_destination(&dest_str, std::slice::from_ref(&allowed));
        assert!(result.is_err(), "unexpected ok for {result:?}");
        let _ = std::fs::remove_dir_all(allowed);
        let _ = std::fs::remove_dir_all(other);
    }

    #[test]
    fn verify_export_destination_rejects_nonexistent_parent() {
        let dest = "/this/path/does/not/exist/shot.png";
        let result = verify_export_destination(dest, &[std::env::temp_dir()]);
        assert!(result.is_err());
    }

    #[test]
    fn verify_export_destination_allows_when_no_roots_resolvable() {
        // Empty roots == "host has no standard dirs" — degrade open rather
        // than block exports entirely. PNG payload checks still apply.
        assert!(verify_export_destination("/tmp/shot.png", &[]).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn verify_export_destination_rejects_windows_alternate_data_stream() {
        let root = temp_root("ads");
        let dest = root.join("evil.exe:shot.png");
        let dest_str = dest.to_str().unwrap().to_string();
        let result = verify_export_destination(&dest_str, std::slice::from_ref(&root));
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn verify_export_destination_rejects_final_component_symlink() {
        use std::os::unix::fs::symlink;

        let root = temp_root("symlink-root");
        let other = temp_root("symlink-other");
        let target = other.join("target.png");
        std::fs::write(&target, b"placeholder").unwrap();
        let link = root.join("shot.png");
        symlink(&target, &link).unwrap();
        let link_str = link.to_str().unwrap().to_string();
        let result = verify_export_destination(&link_str, std::slice::from_ref(&root));
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(other);
    }
}
