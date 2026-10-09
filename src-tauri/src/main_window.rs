//! The main editor window, for the modules that bring it back: the tray, the
//! pickers after a capture, a second launch. Kept out of `capture` so those
//! modules do not depend on the capture code for a window call.

use tauri::{AppHandle, Manager};

pub(crate) fn restore_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
