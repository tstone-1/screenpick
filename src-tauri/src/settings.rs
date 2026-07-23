use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};

// document_store is the AppHandle-free, unit-testable home for the atomic-write
// primitive (see the code review that unified it with this module's former
// write_settings_atomically); importing it here is fine even though this
// module is not itself part of the pure-module family.
use crate::document_store;
use crate::path_utils::strip_verbatim_prefix;

/// Current on-disk schema for `capture-settings.json`. Bump when an
/// incompatible change lands. Adding a new field with `#[serde(default)]`
/// does NOT require a bump — old files load with the field defaulted.
pub(crate) const CAPTURE_SETTINGS_VERSION: u32 = 1;

/// Hard ceiling for the size of `capture-settings.json` we'll attempt to
/// parse. Real settings are well under 16 KiB; anything larger is either a
/// corrupted file or an attempt to OOM startup.
const MAX_SETTINGS_BYTES: u64 = 256 * 1024;

/// FIFO cap on `SettingsState::trusted_capture_files` — see the comment at its
/// one mutator, `remember_capture_file`.
const TRUSTED_CAPTURE_FILES_CAP: usize = 512;

#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureSettings {
    #[serde(default = "default_version")]
    pub(crate) version: u32,
    #[serde(default)]
    pub(crate) save_directory: Option<String>,
    #[serde(default)]
    pub(crate) copy_to_clipboard: bool,
    #[serde(default)]
    pub(crate) play_capture_sound: bool,
    #[serde(default = "default_auto_open_editor")]
    pub(crate) auto_open_editor: bool,
    #[serde(default)]
    pub(crate) bring_to_front_on_hotkey_capture: bool,
    #[serde(default)]
    pub(crate) close_to_tray: bool,
    #[serde(default)]
    pub(crate) shortcut_overrides: HashMap<String, Vec<String>>,
}

fn default_version() -> u32 {
    CAPTURE_SETTINGS_VERSION
}

fn default_auto_open_editor() -> bool {
    true
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            version: CAPTURE_SETTINGS_VERSION,
            save_directory: None,
            copy_to_clipboard: false,
            play_capture_sound: false,
            auto_open_editor: true,
            bring_to_front_on_hotkey_capture: false,
            close_to_tray: false,
            shortcut_overrides: HashMap::new(),
        }
    }
}

pub(crate) struct SettingsState {
    settings: Mutex<CaptureSettings>,
    // Resolved once in `load` and never mutated afterwards, so this doesn't need
    // interior mutability like the fields above.
    config_path: PathBuf,
    trusted_capture_files: Mutex<Vec<PathBuf>>,
}

impl SettingsState {
    /// Returns the loaded state plus an optional recovery notice when the saved
    /// file had to be reset to defaults, so the caller can tell the user.
    pub(crate) fn load(app: &AppHandle) -> Result<(Self, Option<SettingsRecovery>), String> {
        let config_path = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?
            .join("capture-settings.json");

        let (settings, recovery) = load_settings_from(&config_path);

        Ok((
            Self {
                settings: Mutex::new(settings),
                config_path,
                trusted_capture_files: Mutex::new(Vec::new()),
            },
            recovery,
        ))
    }

    pub(crate) fn get(&self) -> CaptureSettings {
        self.settings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(crate) fn update(&self, partial: CaptureSettings) -> Result<CaptureSettings, String> {
        let mut current = self
            .settings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *current = sanitize_settings(partial);
        self.save(&current)?;
        Ok(current.clone())
    }

    pub(crate) fn reset_shortcuts(&self) -> Result<CaptureSettings, String> {
        let mut current = self
            .settings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        current.shortcut_overrides.clear();
        self.save(&current)?;
        Ok(current.clone())
    }

    pub(crate) fn remember_capture_file(&self, path: &Path) {
        let file = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let mut trusted = self
            .trusted_capture_files
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !trusted.iter().any(|existing| existing == &file) {
            trusted.push(file);
            // Memory-only, process-lifetime list — cap it FIFO so an
            // extremely long-running session (or one with an unusual capture
            // volume) can't grow it without bound. `crop`/`cutout` also each
            // trust their own output via this same path, so the cap has to be
            // generous enough that a normal editing session never evicts an
            // entry it still needs; 512 is comfortably above realistic
            // same-session capture counts.
            if trusted.len() > TRUSTED_CAPTURE_FILES_CAP {
                trusted.remove(0);
            }
        }
    }

    pub(crate) fn trusted_capture_files(&self) -> Vec<PathBuf> {
        self.trusted_capture_files
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn save(&self, settings: &CaptureSettings) -> Result<(), String> {
        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
        document_store::write_atomic(&self.config_path, json.as_bytes())
    }
}

/// A startup recovery: the saved settings file couldn't be used and was reset
/// to defaults. Surfaced to the user (a system notification) so a silent reset
/// doesn't read as "the app forgot my settings for no reason". `reason` is a
/// short human phrase; `backup_path` is where the bad file was preserved, if we
/// managed to move it aside. Internal-only — never crosses the IPC boundary.
#[derive(Clone, Debug)]
pub(crate) struct SettingsRecovery {
    pub(crate) reason: String,
    pub(crate) backup_path: Option<String>,
}

/// Load settings from `path`. On any failure short of "file doesn't exist",
/// preserve the unreadable file under `capture-settings.invalid-<ms>.json`
/// before returning defaults — losing the user's settings silently is worse
/// than disk noise, and an oversized/corrupted file shouldn't crash startup.
/// Returns the settings plus an optional recovery notice describing a reset.
fn load_settings_from(path: &Path) -> (CaptureSettings, Option<SettingsRecovery>) {
    let metadata = match fs::metadata(path) {
        Ok(meta) => meta,
        // No file yet (the common first-run case) is not a recovery.
        Err(_) => return (CaptureSettings::default(), None),
    };
    if metadata.len() > MAX_SETTINGS_BYTES {
        log::warn!(
            "capture settings at {} are oversized ({} bytes > {} max); backing up and using defaults",
            path.display(),
            metadata.len(),
            MAX_SETTINGS_BYTES
        );
        let backup_path = backup_invalid_settings(path, "oversized");
        return (
            CaptureSettings::default(),
            Some(SettingsRecovery {
                reason: "was too large to read".to_string(),
                backup_path,
            }),
        );
    }
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(err) => {
            log::warn!(
                "could not read capture settings at {}; using defaults: {err}",
                path.display()
            );
            return (
                CaptureSettings::default(),
                Some(SettingsRecovery {
                    reason: "could not be read".to_string(),
                    backup_path: None,
                }),
            );
        }
    };
    match serde_json::from_str::<CaptureSettings>(&contents) {
        Ok(settings) => (sanitize_settings(settings), None),
        Err(err) => {
            log::warn!(
                "invalid capture settings JSON at {}; backing up and using defaults: {err}",
                path.display()
            );
            let backup_path = backup_invalid_settings(path, "parse");
            (
                CaptureSettings::default(),
                Some(SettingsRecovery {
                    reason: "was corrupted".to_string(),
                    backup_path,
                }),
            )
        }
    }
}

/// Move the unreadable settings file aside so the next save doesn't clobber
/// it. Best-effort — returns the backup path on success, or `None` (after
/// logging) if the move failed; the caller uses defaults either way.
fn backup_invalid_settings(path: &Path, reason: &str) -> Option<String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("capture-settings");
    let mut backup = path.to_path_buf();
    backup.set_file_name(format!("{stem}.invalid-{ts}-{reason}.json"));
    match fs::rename(path, &backup) {
        Ok(()) => Some(backup.display().to_string()),
        Err(err) => {
            log::warn!(
                "could not back up invalid settings at {}: {err}",
                path.display()
            );
            None
        }
    }
}

/// Extend the `asset:` protocol scope so the editor can render images from a
/// user-configured `save_directory` outside `$APPCACHE`. The default scope in
/// `tauri.conf.json` is `["$APPCACHE/**"]`, so a save dir on the user's
/// Desktop would otherwise produce `asset://` URLs the webview refuses.
pub(crate) fn extend_asset_scope_for_save_directory(app: &AppHandle, save_directory: Option<&str>) {
    let Some(dir) = save_directory else {
        return;
    };
    let dir = dir.trim();
    if dir.is_empty() {
        return;
    }
    if let Err(err) = app.asset_protocol_scope().allow_directory(dir, true) {
        log::warn!("could not extend asset scope for {dir}: {err}");
    }
}

pub(crate) fn validate_save_directory(
    app: &AppHandle,
    save_directory: Option<&str>,
) -> Result<Option<String>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    validate_save_directory_path(save_directory, &home)
}

fn validate_save_directory_path(
    save_directory: Option<&str>,
    home: &Path,
) -> Result<Option<String>, String> {
    let Some(dir) = save_directory else {
        return Ok(None);
    };
    let dir = dir.trim();
    if dir.is_empty() {
        return Ok(None);
    }
    let path = PathBuf::from(dir);
    if path.parent().is_none() {
        return Err("Save directory cannot be a filesystem root.".to_string());
    }
    let canonical = path.canonicalize().map_err(|_| {
        "Save directory must be an existing folder under your user profile.".to_string()
    })?;
    if !canonical.is_dir() {
        return Err("Save directory must be an existing folder.".to_string());
    }
    let canonical_home = home.canonicalize().map_err(|_| {
        "Could not resolve the user profile directory for save-folder validation.".to_string()
    })?;
    if canonical == canonical_home || !canonical.starts_with(&canonical_home) {
        return Err(
            "Save directory must be inside your user profile, not the profile root.".to_string(),
        );
    }
    Ok(Some(strip_verbatim_prefix(&canonical.to_string_lossy())))
}

fn sanitize_settings(mut settings: CaptureSettings) -> CaptureSettings {
    settings.shortcut_overrides = settings
        .shortcut_overrides
        .into_iter()
        .filter_map(|(mode, accelerators)| {
            if accelerators.is_empty() {
                return Some((mode, accelerators));
            }
            let sanitized = accelerators
                .into_iter()
                .map(|accelerator| accelerator.trim().to_string())
                .filter(|accelerator| !accelerator.is_empty())
                .collect::<Vec<_>>();
            if sanitized.is_empty() {
                None
            } else {
                Some((mode, sanitized))
            }
        })
        .collect();
    // Clean any Windows verbatim prefix left in a previously stored save
    // directory so it displays as a conventional path even before the next
    // save round-trips it through validation.
    settings.save_directory = settings
        .save_directory
        .map(|dir| strip_verbatim_prefix(&dir));
    settings
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_settings(state: tauri::State<'_, SettingsState>) -> CaptureSettings {
    state.get()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn update_settings(
    app: AppHandle,
    state: tauri::State<'_, SettingsState>,
    settings: CaptureSettings,
) -> Result<CaptureSettings, String> {
    let mut settings = sanitize_settings(settings);
    settings.save_directory = validate_save_directory(&app, settings.save_directory.as_deref())?;
    let updated = state.update(settings)?;
    extend_asset_scope_for_save_directory(&app, updated.save_directory.as_deref());
    crate::shortcuts::re_register_shortcuts(&app, &updated)?;
    Ok(updated)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn reset_shortcut_settings(
    app: AppHandle,
    state: tauri::State<'_, SettingsState>,
) -> Result<CaptureSettings, String> {
    let updated = state.reset_shortcuts()?;
    crate::shortcuts::re_register_shortcuts(&app, &updated)?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::{
        load_settings_from, sanitize_settings, validate_save_directory_path, CaptureSettings,
        CAPTURE_SETTINGS_VERSION, MAX_SETTINGS_BYTES,
    };
    use crate::path_utils::strip_verbatim_prefix;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn temp_path(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "screenpick-settings-test-{}-{}-{}.json",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        path
    }

    #[test]
    fn default_settings_are_safe() {
        let settings = CaptureSettings::default();
        assert_eq!(settings.version, CAPTURE_SETTINGS_VERSION);
        assert_eq!(settings.save_directory, None);
        assert!(!settings.copy_to_clipboard);
        assert!(settings.auto_open_editor);
        assert!(!settings.bring_to_front_on_hotkey_capture);
        assert!(!settings.close_to_tray);
        assert!(settings.shortcut_overrides.is_empty());
    }

    #[test]
    fn round_trips_json() {
        let mut overrides = HashMap::new();
        overrides.insert("region".to_string(), vec!["CmdOrCtrl+Shift+X".to_string()]);
        let settings = CaptureSettings {
            save_directory: Some("/tmp/captures".to_string()),
            copy_to_clipboard: true,
            auto_open_editor: false,
            bring_to_front_on_hotkey_capture: true,
            close_to_tray: true,
            shortcut_overrides: overrides,
            ..CaptureSettings::default()
        };
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let parsed: CaptureSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.version, settings.version);
        assert_eq!(parsed.save_directory, settings.save_directory);
        assert_eq!(parsed.copy_to_clipboard, settings.copy_to_clipboard);
        assert_eq!(parsed.auto_open_editor, settings.auto_open_editor);
        assert_eq!(
            parsed.bring_to_front_on_hotkey_capture,
            settings.bring_to_front_on_hotkey_capture
        );
        assert_eq!(parsed.close_to_tray, settings.close_to_tray);
        assert_eq!(parsed.shortcut_overrides, settings.shortcut_overrides);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        // A pre-versioning settings file or a file written by an older build
        // that didn't know about a field. Each missing field gets its
        // serde(default), without losing the values that ARE present.
        let parsed: CaptureSettings =
            serde_json::from_str(r#"{ "saveDirectory": "/tmp/x" }"#).unwrap();
        assert_eq!(parsed.version, CAPTURE_SETTINGS_VERSION);
        assert_eq!(parsed.save_directory, Some("/tmp/x".to_string()));
        assert!(!parsed.copy_to_clipboard);
        assert!(!parsed.play_capture_sound);
        assert!(parsed.auto_open_editor);
        assert!(!parsed.bring_to_front_on_hotkey_capture);
        assert!(!parsed.close_to_tray);
        assert!(parsed.shortcut_overrides.is_empty());
    }

    #[test]
    fn unknown_future_fields_are_ignored() {
        // Forward compat: a settings file written by a newer build with an
        // additional field we don't know about must still load.
        let parsed: CaptureSettings = serde_json::from_str(
            r#"{ "saveDirectory": null, "copyToClipboard": true, "futureField": 42 }"#,
        )
        .unwrap();
        assert!(parsed.copy_to_clipboard);
    }

    #[test]
    fn load_returns_defaults_when_file_missing() {
        let path = temp_path("missing");
        let (settings, recovery) = load_settings_from(&path);
        assert_eq!(settings.save_directory, None);
        assert!(settings.auto_open_editor);
        assert!(recovery.is_none(), "a missing file is not a recovery");
    }

    #[test]
    fn load_parses_valid_file() {
        let path = temp_path("valid");
        std::fs::write(
            &path,
            r#"{ "saveDirectory": "/tmp/y", "copyToClipboard": true }"#,
        )
        .unwrap();
        let (settings, recovery) = load_settings_from(&path);
        assert_eq!(settings.save_directory, Some("/tmp/y".to_string()));
        assert!(settings.copy_to_clipboard);
        assert!(
            recovery.is_none(),
            "a valid file should not report a recovery"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn parse_failure_renames_original_to_invalid() {
        let path = temp_path("parse-fail");
        std::fs::write(&path, "not json at all").unwrap();
        let (settings, recovery) = load_settings_from(&path);
        assert_eq!(settings.save_directory, None);

        let recovery = recovery.expect("a corrupted file should report a recovery");
        assert_eq!(recovery.reason, "was corrupted");
        assert!(
            recovery.backup_path.is_some(),
            "recovery should point at the preserved backup"
        );

        // Original file is moved aside, not left to be clobbered.
        assert!(
            !path.exists(),
            "expected corrupted file to be renamed; still present at {:?}",
            path
        );
        let dir = path.parent().unwrap();
        let stem = path.file_stem().unwrap().to_str().unwrap();
        let backup = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with(stem) && n.contains("invalid-") && n.contains("parse"))
                    .unwrap_or(false)
            })
            .map(|e| e.path());
        assert!(backup.is_some(), "expected a *.invalid-*-parse.json backup");
        if let Some(b) = backup {
            std::fs::remove_file(b).ok();
        }
    }

    #[test]
    fn oversized_settings_file_falls_back_to_defaults() {
        let path = temp_path("oversized");
        // Allocate just over the cap and write it out.
        let bloat = vec![b'a'; (MAX_SETTINGS_BYTES as usize) + 1];
        std::fs::write(&path, &bloat).unwrap();
        let (settings, recovery) = load_settings_from(&path);
        assert_eq!(settings.save_directory, None);
        let recovery = recovery.expect("an oversized file should report a recovery");
        assert_eq!(recovery.reason, "was too large to read");
        assert!(recovery.backup_path.is_some());
        assert!(!path.exists(), "expected oversized file to be renamed");
        let dir = path.parent().unwrap();
        let stem = path.file_stem().unwrap().to_str().unwrap();
        let backup = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| {
                        n.starts_with(stem) && n.contains("invalid-") && n.contains("oversized")
                    })
                    .unwrap_or(false)
            })
            .map(|e| e.path());
        assert!(
            backup.is_some(),
            "expected a *.invalid-*-oversized.json backup"
        );
        if let Some(b) = backup {
            std::fs::remove_file(b).ok();
        }
    }

    #[test]
    fn reset_shortcut_shape_preserves_other_fields() {
        let mut overrides = HashMap::new();
        overrides.insert("region".to_string(), vec!["CmdOrCtrl+Shift+X".to_string()]);
        let mut settings = CaptureSettings {
            save_directory: Some("/tmp/captures".to_string()),
            copy_to_clipboard: true,
            auto_open_editor: false,
            shortcut_overrides: overrides,
            ..CaptureSettings::default()
        };

        settings.shortcut_overrides.clear();

        assert_eq!(settings.save_directory, Some("/tmp/captures".to_string()));
        assert!(settings.copy_to_clipboard);
        assert!(!settings.auto_open_editor);
        assert!(settings.shortcut_overrides.is_empty());
    }

    #[test]
    fn sanitize_settings_trims_shortcuts_and_drops_blank_placeholder_rows() {
        let mut overrides = HashMap::new();
        overrides.insert(
            "region".to_string(),
            vec![
                "".to_string(),
                "  ".to_string(),
                " CommandOrControl+Shift+X ".to_string(),
            ],
        );
        overrides.insert("window".to_string(), vec![" ".to_string()]);
        overrides.insert("screen".to_string(), vec![]);
        let settings = CaptureSettings {
            shortcut_overrides: overrides,
            ..CaptureSettings::default()
        };

        let sanitized = sanitize_settings(settings);
        assert_eq!(
            sanitized.shortcut_overrides.get("region").unwrap(),
            &vec!["CommandOrControl+Shift+X".to_string()]
        );
        assert!(!sanitized.shortcut_overrides.contains_key("window"));
        assert_eq!(
            sanitized.shortcut_overrides.get("screen").unwrap(),
            &Vec::<String>::new()
        );
    }

    #[test]
    fn validate_save_directory_rejects_filesystem_root() {
        let root = if cfg!(windows) { r"C:\" } else { "/" };
        let home = std::env::temp_dir();

        let err = validate_save_directory_path(Some(root), &home).unwrap_err();

        assert!(err.contains("root"));
    }

    #[test]
    fn validate_save_directory_accepts_existing_child_of_home() {
        let home =
            std::env::temp_dir().join(format!("screenpick-home-test-{}", std::process::id()));
        let child = home.join("captures");
        std::fs::create_dir_all(&child).unwrap();

        let validated = validate_save_directory_path(Some(child.to_str().unwrap()), &home).unwrap();

        assert_eq!(
            validated,
            Some(strip_verbatim_prefix(
                &child.canonicalize().unwrap().to_string_lossy()
            ))
        );
        // The stored value must never carry the Windows verbatim prefix.
        assert!(!validated.unwrap().starts_with(r"\\?\"));
        let _ = std::fs::remove_dir_all(&home);
    }

    // strip_verbatim_prefix itself is tested once, in `path_utils::tests`
    // (this module used to carry its own copy — see N2 in the code review).
}
