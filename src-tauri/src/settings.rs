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

use crate::atomic_write::write_atomic;
use crate::path_utils::strip_verbatim_prefix;
use crate::updates::UpdateTransition;

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
    #[serde(default = "default_check_for_updates_on_startup")]
    pub(crate) check_for_updates_on_startup: bool,
    // Version of the last build that ran. Written by Rust at startup, not by the
    // frontend, so the UI can tell "we just updated" from "same build as before"
    // and re-check the macOS Screen Recording grant, which an ad-hoc-signed
    // update invalidates (see ROADMAP P0 #1). `None` on a first run.
    #[serde(default)]
    pub(crate) last_run_version: Option<String>,
    #[serde(default)]
    pub(crate) shortcut_overrides: HashMap<String, Vec<String>>,
}

fn default_version() -> u32 {
    CAPTURE_SETTINGS_VERSION
}

fn default_auto_open_editor() -> bool {
    true
}

fn default_check_for_updates_on_startup() -> bool {
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
            check_for_updates_on_startup: true,
            last_run_version: None,
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
        let merged = preserve_backend_owned_fields(&current, partial);
        let candidate = sanitize_settings(merged);
        self.save(&candidate)?;
        *current = candidate;
        Ok(current.clone())
    }

    pub(crate) fn reset_shortcuts(&self) -> Result<CaptureSettings, String> {
        let mut current = self
            .settings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut candidate = current.clone();
        candidate.shortcut_overrides.clear();
        self.save(&candidate)?;
        *current = candidate;
        Ok(current.clone())
    }

    /// Records `version` as the build that ran, returning the version it
    /// replaced. A `Some(previous)` that differs from `version` means the app
    /// was updated since the last launch — which on macOS is exactly when the
    /// Screen Recording grant needs re-checking. A first run returns `None`, so
    /// callers can tell "fresh install" from "upgraded" and stay quiet on the
    /// former.
    pub(crate) fn record_run_version(&self, version: &str) -> Result<Option<String>, String> {
        let mut current = self
            .settings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = current.last_run_version.clone();
        if previous.as_deref() == Some(version) {
            // Unchanged: skip the write so an ordinary relaunch doesn't rewrite
            // the settings file for nothing.
            return Ok(previous);
        }
        let mut candidate = current.clone();
        candidate.last_run_version = Some(version.to_string());
        self.save(&candidate)?;
        *current = candidate;
        Ok(previous)
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
        write_atomic(&self.config_path, json.as_bytes())
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
                "could not read capture settings at {}; backing up and using defaults: {err}",
                path.display()
            );
            // Startup saves the run version right after this, which would
            // replace the file. Move it aside first, like the other branches.
            let backup_path = backup_invalid_settings(path, "unreadable");
            return (
                CaptureSettings::default(),
                Some(SettingsRecovery {
                    reason: "could not be read".to_string(),
                    backup_path,
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

/// The save directory an update may store. The frontend sends the whole
/// settings struct on every save, so the stored directory comes back with each
/// unrelated change. Validation needs the folder to exist, so validating an
/// unchanged directory would refuse every toggle and shortcut edit once that
/// folder is deleted, renamed or on an unmounted volume. Only a directory that
/// differs from the stored one is a choice to check; the stored one was checked
/// when it was chosen.
fn save_directory_for_update(
    stored: Option<&str>,
    incoming: Option<&str>,
    home: &Path,
) -> Result<Option<String>, String> {
    if incoming.is_some() && incoming == stored {
        return Ok(stored.map(str::to_string));
    }
    validate_save_directory_path(incoming, home)
}

/// Overlay the fields Rust owns onto a `CaptureSettings` that arrived from the
/// frontend. `update_settings` takes the whole struct, so every save round-trips
/// fields the UI neither shows nor tracks — and its own default object has
/// `last_run_version: None`. A save that lands before the initial `get_settings`
/// resolves, or any save after a failed one, would therefore write that default
/// over the stored value: the next launch would then see `None`, read as a first
/// run rather than an update, and stay silent about re-checking the macOS Screen
/// Recording grant — the single question the field exists to answer. `version` is
/// the on-disk schema number and belongs to whatever code migrates the file, not
/// to a settings toggle, so it is pinned the same way.
fn preserve_backend_owned_fields(
    stored: &CaptureSettings,
    mut incoming: CaptureSettings,
) -> CaptureSettings {
    incoming.version = stored.version;
    incoming.last_run_version = stored.last_run_version.clone();
    incoming
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

// Resolved once during setup (see lib.rs) and handed out unchanged, so the
// "did we just update?" answer survives the settings file already having been
// rewritten with the current version.
#[tauri::command]
#[specta::specta]
pub(crate) fn update_transition(state: tauri::State<'_, UpdateTransition>) -> UpdateTransition {
    state.inner().clone()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn update_settings(
    app: AppHandle,
    state: tauri::State<'_, SettingsState>,
    settings: CaptureSettings,
) -> Result<CaptureSettings, String> {
    let mut settings = sanitize_settings(settings);
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    settings.save_directory = save_directory_for_update(
        state.get().save_directory.as_deref(),
        settings.save_directory.as_deref(),
        &home,
    )?;
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
    #[test]
    fn failed_settings_writes_leave_runtime_state_unchanged() {
        let blocker = temp_path("write-blocker");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let initial = super::CaptureSettings {
            shortcut_overrides: std::collections::HashMap::from([(
                "window".into(),
                vec!["Control+Shift+9".into()],
            )]),
            ..Default::default()
        };
        let state = super::SettingsState {
            settings: std::sync::Mutex::new(initial.clone()),
            config_path: blocker.join("settings.json"),
            trusted_capture_files: std::sync::Mutex::new(Vec::new()),
        };
        let mut changed = initial.clone();
        changed.close_to_tray = true;
        assert!(state.update(changed).is_err());
        assert!(!state.get().close_to_tray);
        assert!(state.reset_shortcuts().is_err());
        assert_eq!(state.get().shortcut_overrides, initial.shortcut_overrides);
        assert!(state.record_run_version("test-version").is_err());
        assert!(state.get().last_run_version.is_none());
        // A writable destination is the control: success must actually adopt
        // the candidate in memory and on disk.
        std::fs::remove_file(&blocker).unwrap();
        state
            .update(super::CaptureSettings {
                close_to_tray: true,
                ..initial
            })
            .unwrap();
        assert!(state.get().close_to_tray);
        assert!(
            super::load_settings_from(&state.config_path)
                .0
                .close_to_tray
        );
        std::fs::remove_dir_all(blocker).unwrap();
    }
    use super::{
        load_settings_from, preserve_backend_owned_fields, sanitize_settings,
        save_directory_for_update, validate_save_directory_path, CaptureSettings, SettingsState,
        CAPTURE_SETTINGS_VERSION, MAX_SETTINGS_BYTES,
    };
    use crate::path_utils::strip_verbatim_prefix;
    use serde::Deserialize;
    use std::collections::HashMap;
    use std::path::PathBuf;

    // The sanitize rules exist twice by design — see the fixture's own _readme.
    // Compiled in rather than read at runtime so a moved or deleted fixture is a
    // build failure here, not a test that quietly stops checking anything.
    const SHORTCUT_SANITIZE_FIXTURE: &str =
        include_str!("../../src/lib/shortcutSanitizeFixture.json");

    #[derive(Deserialize)]
    struct SanitizeCase {
        name: String,
        input: HashMap<String, Vec<String>>,
        expected: HashMap<String, Vec<String>>,
    }

    #[derive(Deserialize)]
    struct SanitizeFixture {
        cases: Vec<SanitizeCase>,
    }

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

    // A state that saves to its own temp file, holding `settings` in memory.
    fn state_with(label: &str, settings: CaptureSettings) -> SettingsState {
        SettingsState {
            settings: std::sync::Mutex::new(settings),
            config_path: temp_path(label),
            trusted_capture_files: std::sync::Mutex::new(Vec::new()),
        }
    }

    // A directory tree of its own per test: `<temp>/<label>-<pid>-<nanos>/home`.
    fn temp_home(label: &str) -> PathBuf {
        let home = temp_path(label).with_extension("").join("home");
        std::fs::create_dir_all(&home).unwrap();
        home
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
    fn reset_shortcuts_clears_the_overrides_and_keeps_every_other_setting() {
        let mut overrides = HashMap::new();
        overrides.insert("region".to_string(), vec!["CmdOrCtrl+Shift+X".to_string()]);
        let state = state_with(
            "reset-shortcuts",
            CaptureSettings {
                save_directory: Some("/tmp/captures".to_string()),
                copy_to_clipboard: true,
                auto_open_editor: false,
                last_run_version: Some("0.0.1".to_string()),
                shortcut_overrides: overrides,
                ..CaptureSettings::default()
            },
        );

        let returned = state.reset_shortcuts().unwrap();

        // In memory, in the returned value and on disk alike.
        let (on_disk, recovery) = load_settings_from(&state.config_path);
        assert!(recovery.is_none());
        for settings in [returned, state.get(), on_disk] {
            assert!(settings.shortcut_overrides.is_empty());
            assert_eq!(settings.save_directory, Some("/tmp/captures".to_string()));
            assert!(settings.copy_to_clipboard);
            assert!(!settings.auto_open_editor);
            assert_eq!(settings.last_run_version, Some("0.0.1".to_string()));
        }
        std::fs::remove_file(&state.config_path).ok();
    }

    #[test]
    fn unreadable_settings_file_is_moved_aside_before_defaults_are_used() {
        let path = temp_path("unreadable");
        // Not valid UTF-8, so the file exists and is small but cannot be read
        // as text: the shape of a torn write.
        let bytes = [0xff_u8, 0xfe, 0x00];
        std::fs::write(&path, bytes).unwrap();

        let (settings, recovery) = load_settings_from(&path);

        assert_eq!(settings.save_directory, None);
        let recovery = recovery.expect("an unreadable file should report a recovery");
        assert_eq!(recovery.reason, "could not be read");
        let backup = PathBuf::from(
            recovery
                .backup_path
                .expect("the unreadable file should be preserved"),
        );
        assert_eq!(std::fs::read(&backup).unwrap(), bytes);
        // Moved, not copied: the next save must not find it in the way.
        assert!(!path.exists());
        std::fs::remove_file(backup).ok();
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
    fn sanitize_settings_agrees_with_the_shared_frontend_fixture() {
        let fixture: SanitizeFixture = serde_json::from_str(SHORTCUT_SANITIZE_FIXTURE)
            .expect("the shared sanitize fixture must parse");
        assert!(
            !fixture.cases.is_empty(),
            "an empty corpus passes without checking anything"
        );
        for case in fixture.cases {
            let settings = CaptureSettings {
                shortcut_overrides: case.input,
                ..CaptureSettings::default()
            };
            let sanitized = sanitize_settings(settings);
            assert_eq!(
                sanitized.shortcut_overrides, case.expected,
                "shared fixture case: {}",
                case.name
            );
        }
    }

    #[test]
    fn update_keeps_the_stored_run_version_when_the_frontend_omits_it() {
        // What the frontend's `defaultSettings` serializes to before its first
        // get_settings has resolved: no lastRunVersion, everything else default.
        let stored = CaptureSettings {
            last_run_version: Some("26.7.7".to_string()),
            save_directory: Some("/tmp/captures".to_string()),
            ..CaptureSettings::default()
        };
        let incoming = CaptureSettings {
            copy_to_clipboard: true,
            ..CaptureSettings::default()
        };

        let merged = preserve_backend_owned_fields(&stored, incoming);

        assert_eq!(merged.last_run_version, Some("26.7.7".to_string()));
        assert_eq!(merged.version, stored.version);
        // Fields the UI does own still take effect — this preserves two fields,
        // it does not ignore the payload.
        assert!(merged.copy_to_clipboard);
    }

    #[test]
    fn update_ignores_a_frontend_supplied_run_version_and_schema_version() {
        let stored = CaptureSettings {
            last_run_version: Some("26.7.7".to_string()),
            ..CaptureSettings::default()
        };
        let incoming = CaptureSettings {
            last_run_version: Some("0.0.0".to_string()),
            version: CAPTURE_SETTINGS_VERSION + 41,
            ..CaptureSettings::default()
        };

        let merged = preserve_backend_owned_fields(&stored, incoming);

        assert_eq!(merged.last_run_version, Some("26.7.7".to_string()));
        assert_eq!(merged.version, CAPTURE_SETTINGS_VERSION);
    }

    #[test]
    fn update_through_the_state_keeps_the_stored_run_version() {
        let state = state_with(
            "update-run-version",
            CaptureSettings {
                last_run_version: Some("0.0.1".to_string()),
                ..CaptureSettings::default()
            },
        );

        let updated = state
            .update(CaptureSettings {
                copy_to_clipboard: true,
                last_run_version: None,
                ..CaptureSettings::default()
            })
            .unwrap();

        assert!(updated.copy_to_clipboard);
        assert_eq!(updated.last_run_version, Some("0.0.1".to_string()));
        assert_eq!(
            load_settings_from(&state.config_path).0.last_run_version,
            Some("0.0.1".to_string())
        );
        std::fs::remove_file(&state.config_path).ok();
    }

    #[test]
    fn an_update_keeps_a_stored_save_directory_that_no_longer_exists() {
        let home = temp_home("update-missing-dir");
        let gone = home.join("captures");
        std::fs::create_dir_all(&gone).unwrap();
        let stored = validate_save_directory_path(gone.to_str(), &home)
            .unwrap()
            .unwrap();
        std::fs::remove_dir(&gone).unwrap();
        // The control: this directory can no longer be chosen afresh.
        assert!(validate_save_directory_path(Some(&stored), &home).is_err());

        let kept = save_directory_for_update(Some(&stored), Some(&stored), &home).unwrap();

        assert_eq!(kept, Some(stored));
        std::fs::remove_dir_all(home.parent().unwrap()).ok();
    }

    #[test]
    fn an_update_that_changes_the_save_directory_is_validated() {
        let home = temp_home("update-changed-dir");
        let stored = home.join("captures");
        let next = home.join("other");
        std::fs::create_dir_all(&stored).unwrap();
        std::fs::create_dir_all(&next).unwrap();
        let stored = validate_save_directory_path(stored.to_str(), &home)
            .unwrap()
            .unwrap();
        let missing = home.join("not-there");

        // A changed directory that does not exist is refused, as before.
        assert!(save_directory_for_update(Some(&stored), missing.to_str(), &home).is_err());
        // So is the first directory ever set, when nothing was stored.
        assert!(save_directory_for_update(None, missing.to_str(), &home).is_err());
        // A changed directory that is valid is taken in its canonical form.
        assert_eq!(
            save_directory_for_update(Some(&stored), next.to_str(), &home).unwrap(),
            validate_save_directory_path(next.to_str(), &home).unwrap()
        );
        // Clearing the directory is a change too, and always allowed.
        assert_eq!(
            save_directory_for_update(Some(&stored), None, &home).unwrap(),
            None
        );
        std::fs::remove_dir_all(home.parent().unwrap()).ok();
    }

    #[test]
    fn validate_save_directory_rejects_the_home_directory_itself() {
        let home = temp_home("home-itself");

        let err = validate_save_directory_path(home.to_str(), &home).unwrap_err();

        assert!(err.contains("not the profile root"), "{err}");
        std::fs::remove_dir_all(home.parent().unwrap()).ok();
    }

    #[test]
    fn validate_save_directory_rejects_an_existing_directory_outside_home() {
        let home = temp_home("outside-home");
        // A sibling of home whose name starts with home's name: outside it, and
        // the case a string comparison of the two paths would let through.
        let outside = home.parent().unwrap().join("home-other");
        std::fs::create_dir_all(&outside).unwrap();

        let err = validate_save_directory_path(outside.to_str(), &home).unwrap_err();

        assert!(err.contains("inside your user profile"), "{err}");
        // The control: the same call accepts a directory that is inside.
        let inside = home.join("captures");
        std::fs::create_dir_all(&inside).unwrap();
        assert!(validate_save_directory_path(inside.to_str(), &home).is_ok());
        std::fs::remove_dir_all(home.parent().unwrap()).ok();
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
