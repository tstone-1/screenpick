use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
#[specta::specta]
pub(crate) fn autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|err| err.to_string())?;
    } else {
        autolaunch.disable().map_err(|err| err.to_string())?;
    }
    autolaunch.is_enabled().map_err(|err| err.to_string())
}
