use std::{collections::HashMap, sync::Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{App, AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState as GsState};
use tauri_specta::Event;

use crate::events::{CaptureShortcut, ShortcutRegistration};
use crate::settings::CaptureSettings;
use crate::shortcut_config::{effective_accelerators, EffectiveShortcut};

#[derive(Default)]
pub(crate) struct ShortcutRegistry {
    statuses: Mutex<Vec<ShortcutStatus>>,
    registered_keys: Mutex<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ShortcutState {
    Registered,
    Failed,
}

#[derive(Serialize, Deserialize, Clone, Debug, Type)]
pub(crate) struct ShortcutStatus {
    accelerator: String,
    mode: String,
    state: ShortcutState,
    error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub(crate) fn shortcut_status(registry: tauri::State<'_, ShortcutRegistry>) -> Vec<ShortcutStatus> {
    registry
        .statuses
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn effective_shortcut_accelerators(
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> HashMap<String, Vec<String>> {
    let settings = settings.get();
    let mut result: HashMap<String, Vec<String>> = crate::capture_modes::capture_modes()
        .iter()
        .map(|mode| (mode.id.clone(), Vec::new()))
        .collect();
    for shortcut in effective_accelerators(Some(&settings.shortcut_overrides)) {
        result
            .entry(shortcut.mode)
            .or_default()
            .push(shortcut.accelerator);
    }
    result
}

pub(crate) fn register_shortcuts_with_settings(app: &App, settings: &CaptureSettings) {
    let shortcuts = effective_accelerators(Some(&settings.shortcut_overrides));
    register_shortcut_list(app, &shortcuts);
}

pub(crate) fn re_register_shortcuts(
    app: &AppHandle,
    settings: &CaptureSettings,
) -> Result<(), String> {
    unregister_all_shortcuts(app);
    let shortcuts = effective_accelerators(Some(&settings.shortcut_overrides));
    register_shortcut_list(app, &shortcuts);
    Ok(())
}

fn unregister_all_shortcuts(app: &AppHandle) {
    let registry = app.state::<ShortcutRegistry>();
    let mut keys = registry
        .registered_keys
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for key in keys.drain(..) {
        let _ = app.global_shortcut().unregister(key.as_str());
    }
    let mut statuses = registry
        .statuses
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    statuses.clear();
}

fn register_shortcut_list<R, M>(app: &M, shortcuts: &[EffectiveShortcut])
where
    R: Runtime,
    M: Manager<R> + Emitter<R>,
{
    for shortcut in shortcuts {
        let accel_owned = shortcut.accelerator.clone();
        let mode_id = shortcut.mode.clone();
        let mode_id_for_callback = mode_id.clone();

        let status = match app.global_shortcut().on_shortcut(
            shortcut.accelerator.as_str(),
            move |app, _shortcut, event| {
                if event.state == GsState::Pressed {
                    if let Err(err) = CaptureShortcut(mode_id_for_callback.clone()).emit(app) {
                        log::warn!("failed to emit capture shortcut event: {err}");
                    }
                }
            },
        ) {
            Ok(()) => ShortcutStatus {
                accelerator: accel_owned.clone(),
                mode: mode_id.clone(),
                state: ShortcutState::Registered,
                error: None,
            },
            Err(err) => ShortcutStatus {
                accelerator: accel_owned.clone(),
                mode: mode_id.clone(),
                state: ShortcutState::Failed,
                error: Some(err.to_string()),
            },
        };

        log::info!(
            "{} {}: {}",
            match status.state {
                ShortcutState::Registered => "registered",
                ShortcutState::Failed => "failed",
            },
            status.accelerator,
            status.error.as_deref().unwrap_or("ok")
        );
        if status.state == ShortcutState::Registered {
            app.state::<ShortcutRegistry>()
                .registered_keys
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(accel_owned);
        }
        app.state::<ShortcutRegistry>()
            .statuses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(status.clone());
        if let Err(err) = ShortcutRegistration(status).emit(app) {
            log::warn!("failed to emit shortcut registration event: {err}");
        }
    }
}
