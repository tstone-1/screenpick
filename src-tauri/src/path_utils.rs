//! Small filesystem-path helpers shared across modules that otherwise have no
//! clean way to import from each other (`capture` and `settings` are both
//! `AppHandle`-bound leaf modules with no reason to depend on one another).
//! Pure — no `AppHandle` — so it sits in the ungated pure-logic module group
//! (alongside `capture_modes` / `capture_trust` / `export_validation` /
//! `monitor_pairing` / `shortcut_config` / `document_store`) and is
//! unit-tested on Windows like its siblings.

/// `Path::canonicalize` on Windows returns an extended-length "verbatim" path
/// (`\\?\C:\...`, or `\\?\UNC\server\share` for network shares). That prefix is
/// valid for most Win32 APIs but leaks into settings UI display and trips up
/// naive path display/joining (e.g. Explorer's `/select,` switch), so strip it
/// back to a conventional path for anything we store or show. No-op on
/// non-Windows paths, which never carry the prefix.
pub(crate) fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::strip_verbatim_prefix;

    #[test]
    fn strip_verbatim_prefix_removes_disk_and_unc_prefixes() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\Users\me\screenpick"),
            r"C:\Users\me\screenpick"
        );
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\dir"),
            r"\\server\share\dir"
        );
        assert_eq!(
            strip_verbatim_prefix(r"C:\already\plain"),
            r"C:\already\plain"
        );
        assert_eq!(
            strip_verbatim_prefix("/unix/style/path"),
            "/unix/style/path"
        );
    }
}
