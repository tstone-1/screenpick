use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{
    webview::PageLoadEvent, AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
use xcap::Monitor;

use crate::capture::{
    capture_region_image, ensure_screen_capture_access, error_message, primary_monitor,
    CaptureResult,
};
use crate::picker_session::{
    emit_capture_cancelled, finish_capture, hide_before_capture, place_overlay, PickerSession,
};

const REGION_WINDOW: &str = "region-selector";

#[derive(Default)]
pub(crate) struct RegionPickerSession {
    session: PickerSession,
    /// Monitor that was chosen at `start_region_selection` time. The overlay
    /// is sized to this monitor; the capture must read pixels from this same
    /// monitor at finish time even if the display configuration has changed
    /// in between (e.g. a hot-plug changed the "primary" monitor).
    target_monitor_id: Mutex<Option<u32>>,
}

impl RegionPickerSession {
    // Explicit accessor instead of Deref: a call site always says which
    // session methods it's using, rather than relying on inherited methods
    // resolving invisibly through pseudo-inheritance.
    fn session(&self) -> &PickerSession {
        &self.session
    }

    fn set_target_monitor(&self, id: Option<u32>) {
        *self
            .target_monitor_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = id;
    }

    fn target_monitor(&self) -> Option<u32> {
        *self
            .target_monitor_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegionSelection {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
}

#[tauri::command]
#[specta::specta]
pub(crate) fn start_region_selection(app: AppHandle) -> Result<(), String> {
    ensure_screen_capture_access()?;

    app.state::<RegionPickerSession>()
        .session()
        .close_existing(&app, REGION_WINDOW);

    let primary = primary_monitor()?;
    let monitor_id = primary.id().ok();
    let tauri_primary = app
        .primary_monitor()
        .map_err(error_message)?
        .ok_or_else(|| "No primary display available for capture.".to_string())?;
    let position = *tauri_primary.position();
    let size = *tauri_primary.size();

    let id = app.state::<RegionPickerSession>().session().next_id();

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    let session_state = app.state::<RegionPickerSession>();
    session_state.set_target_monitor(monitor_id);
    session_state.session().record(id);

    tauri::async_runtime::spawn(create_region_window(app.clone(), id, position, size));

    Ok(())
}

async fn create_region_window(
    app: AppHandle,
    id: u64,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) {
    let window = match WebviewWindowBuilder::new(
        &app,
        REGION_WINDOW,
        WebviewUrl::App(format!("/{REGION_WINDOW}").into()),
    )
    .title("ScreenPick Region")
    .inner_size(1.0, 1.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .on_page_load(|window, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
    .build()
    {
        Ok(window) => window,
        Err(err) => {
            let message = error_message(err);
            if end_region_session(&app, Some(id)) {
                emit_capture_cancelled(&app, message);
            }
            return;
        }
    };

    place_overlay(&window, position, size);

    let app_for_handler = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) && end_region_session(&app_for_handler, Some(id))
        {
            emit_capture_cancelled(&app_for_handler, "Region capture cancelled.");
        }
    });
}

#[tauri::command]
#[specta::specta]
pub(crate) fn finish_region_selection(
    app: AppHandle,
    selection: RegionSelection,
) -> Result<CaptureResult, String> {
    // Snapshot the session id BEFORE the hide-and-capture window so a re-entry
    // (global shortcut firing again, or the user clicking start while the
    // overlay is hiding) can't emit a CaptureCompleted on someone else's
    // session. finish_capture owns the hide/settle/end/restore/emit sequence.
    let session_id = app.state::<RegionPickerSession>().session().current();
    finish_capture(
        &app,
        session_id,
        "Region capture was already cancelled.",
        |app| {
            if let Some(window) = app.get_webview_window(REGION_WINDOW) {
                hide_before_capture(&window, "region overlay", 0);
            }
        },
        finish_region_session,
        |app| capture_region_selection(app, &selection),
    )
}

#[tauri::command]
#[specta::specta]
pub(crate) fn cancel_region_selection(app: AppHandle) -> Result<(), String> {
    if end_region_session(&app, None) {
        emit_capture_cancelled(&app, "Region capture cancelled.");
    }
    Ok(())
}

fn end_region_session(app: &AppHandle, expected_id: Option<u64>) -> bool {
    let session = app.state::<RegionPickerSession>();
    let ended = session.session().end(app, REGION_WINDOW, expected_id);
    if ended {
        session.set_target_monitor(None);
    }
    ended
}

fn finish_region_session(app: &AppHandle, expected_id: Option<u64>) -> bool {
    let session = app.state::<RegionPickerSession>();
    let ended = session
        .session()
        .end_without_restore(app, REGION_WINDOW, expected_id);
    if ended {
        session.set_target_monitor(None);
    }
    ended
}

// Region capture targets the monitor that was recorded at `start_region_selection`
// time. The overlay was sized to that monitor; if the display configuration
// changed (e.g. a hot-plug shifted the "primary" between start and finish),
// re-resolving primary_monitor() at finish time would capture from a different
// display than the one the user dragged on.
fn capture_region_selection(
    app: &AppHandle,
    selection: &RegionSelection,
) -> Result<CaptureResult, String> {
    let monitor = resolve_target_monitor(app)?;
    let monitor_width = monitor.width().map_err(error_message)?;
    let monitor_height = monitor.height().map_err(error_message)?;
    if monitor_width == 0 || monitor_height == 0 {
        return Err("Capture monitor reported zero dimensions.".to_string());
    }
    let scale_factor =
        region_coordinate_scale_factor(preferred_region_scale(&monitor, selection.scale_factor));

    let x = (selection.x * scale_factor)
        .round()
        .clamp(0.0, f64::from(monitor_width.saturating_sub(1))) as u32;
    let y = (selection.y * scale_factor)
        .round()
        .clamp(0.0, f64::from(monitor_height.saturating_sub(1))) as u32;
    let available_width = monitor_width.saturating_sub(x).max(1);
    let available_height = monitor_height.saturating_sub(y).max(1);
    let width = (selection.width * scale_factor)
        .round()
        .clamp(1.0, f64::from(available_width)) as u32;
    let height = (selection.height * scale_factor)
        .round()
        .clamp(1.0, f64::from(available_height)) as u32;

    capture_region_image(app, &monitor, x, y, width, height)
}

/// Look up the monitor that the overlay was sized to at start time. Falls
/// back to the live primary monitor if the session id was lost (cancellation
/// race) or the recorded monitor is no longer enumerable (disconnected mid-
/// selection — the user then gets the next best capture instead of an error).
fn resolve_target_monitor(app: &AppHandle) -> Result<Monitor, String> {
    let recorded = app.state::<RegionPickerSession>().target_monitor();
    if let Some(target_id) = recorded {
        if let Ok(monitors) = Monitor::all() {
            if let Some(monitor) = monitors
                .into_iter()
                .find(|m| m.id().ok() == Some(target_id))
            {
                return Ok(monitor);
            }
        }
    }
    primary_monitor()
}

/// Scale that converts the overlay's CSS-pixel selection into the monitor's
/// physical pixels. Prefers the monitor's authoritative `scale_factor()` over
/// the frontend-reported `devicePixelRatio`, falling back to the reported value
/// only if the monitor query fails. The reported DPR is the overlay window's,
/// which can diverge from the true monitor scale on mixed-DPI Windows setups.
fn preferred_region_scale(monitor: &Monitor, reported: f64) -> f64 {
    monitor.scale_factor().map(f64::from).unwrap_or(reported)
}

#[cfg(target_os = "macos")]
fn region_coordinate_scale_factor(_scale_factor: f64) -> f64 {
    1.0
}

#[cfg(not(target_os = "macos"))]
fn region_coordinate_scale_factor(scale_factor: f64) -> f64 {
    scale_factor.max(0.25)
}

#[cfg(test)]
mod tests {
    use super::region_coordinate_scale_factor;

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_ignores_selection_scale_factor() {
        assert_eq!(region_coordinate_scale_factor(1.0), 1.0);
        assert_eq!(region_coordinate_scale_factor(2.0), 1.0);
        assert_eq!(region_coordinate_scale_factor(0.1), 1.0);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_clamps_selection_scale_factor() {
        assert_eq!(region_coordinate_scale_factor(0.5), 0.5);
        assert_eq!(region_coordinate_scale_factor(2.0), 2.0);
        assert_eq!(region_coordinate_scale_factor(0.1), 0.25);
        assert_eq!(region_coordinate_scale_factor(0.0), 0.25);
    }
}
