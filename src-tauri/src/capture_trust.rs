use std::path::{Path, PathBuf};

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
    use super::is_capture_source_trusted;
    use std::path::PathBuf;

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
}
