use tauri::{
    webview::PageLoadEvent, window::Color, AppHandle, Manager, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

use crate::capture::{
    capture_monitor_by_id, error_message, list_capturable_monitors, restore_main_window,
    CapturableMonitor, CaptureResult,
};
use crate::monitor_pairing::{pair_monitor_targets, CapMonitorInfo, TauriMonInfo};
use crate::picker_session::{
    emit_capture_cancelled, emit_capture_outcome, finish_capture, hide_before_capture,
    place_overlay, PickerSession,
};

const SCREEN_PICKER: &str = "screen-picker";
const SCREEN_OVERLAY_PREFIX: &str = "screen-overlay-";

#[derive(Default)]
pub(crate) struct ScreenPickerSession(PickerSession);

impl std::ops::Deref for ScreenPickerSession {
    type Target = PickerSession;
    fn deref(&self) -> &PickerSession {
        &self.0
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn start_screen_selection(app: AppHandle) -> Result<(), String> {
    app.state::<ScreenPickerSession>()
        .close_existing(&app, SCREEN_PICKER);
    close_screen_overlays(&app);

    let monitors = list_capturable_monitors()?;
    if monitors.is_empty() {
        return Err("No displays available for capture.".to_string());
    }

    if monitors.len() == 1 {
        return capture_monitor_now(&app, monitors[0].id);
    }

    // Enumerate displays before hiding the main window or recording a session.
    // If this fails we must not leave the main window hidden behind a phantom
    // session with an error the user can no longer see (it is delivered to the
    // now-hidden main window).
    let mut tauri_monitors = app.available_monitors().map_err(error_message)?;
    if tauri_monitors.is_empty() {
        return Err("No displays available for capture.".to_string());
    }
    tauri_monitors.sort_by(|a, b| {
        a.position()
            .y
            .cmp(&b.position().y)
            .then(a.position().x.cmp(&b.position().x))
    });

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    let overlay_targets =
        screen_overlay_targets(&monitors, &tauri_monitors).inspect_err(|_err| {
            restore_main_window(&app);
        })?;

    let id = app.state::<ScreenPickerSession>().next_id();
    app.state::<ScreenPickerSession>().record(id);

    for (index, (monitor_id, position, size)) in overlay_targets.into_iter().enumerate() {
        tauri::async_runtime::spawn(create_screen_overlay_window(
            app.clone(),
            id,
            index,
            monitor_id,
            position,
            size,
        ));
    }
    tauri::async_runtime::spawn(create_screen_picker_window(app.clone(), id));

    Ok(())
}

/// Capture the display under the mouse cursor immediately, with no picker UI.
///
/// This is what the plain Screen hotkey does: because nothing is shown and no
/// focus is taken, a context menu (or other transient UI) open at the moment
/// the hotkey fires stays open and is captured — the original reason the
/// always-show-picker behaviour was a problem. The picker is still reachable on
/// its own hotkey (the `screen-pick` mode) and from the in-app Screen button.
#[tauri::command]
#[specta::specta]
pub(crate) fn capture_screen_under_cursor(app: AppHandle) -> Result<(), String> {
    app.state::<ScreenPickerSession>()
        .close_existing(&app, SCREEN_PICKER);
    close_screen_overlays(&app);

    let monitors = list_capturable_monitors()?;
    if monitors.is_empty() {
        return Err("No displays available for capture.".to_string());
    }

    // Cursor display first; fall back to the primary (then first) display if the
    // cursor can't be resolved to a known monitor.
    let target = monitor_id_under_cursor(&app, &monitors)
        .or_else(|| monitors.iter().find(|m| m.primary).map(|m| m.id))
        .unwrap_or(monitors[0].id);

    capture_monitor_now(&app, target)
}

/// Resolve the xcap monitor id of the display containing the mouse cursor.
///
/// The cursor position and the Tauri monitor bounds are in the same winit
/// physical coordinate space, so the hit-test happens there; the matching Tauri
/// monitor is mapped back to its xcap id through the existing pairing logic
/// (which already handles duplicate names / hot-plug). Returns `None` if the
/// cursor can't be read, the displays can't be paired, or the cursor sits
/// outside every known display — callers fall back to the primary display.
fn monitor_id_under_cursor(app: &AppHandle, monitors: &[CapturableMonitor]) -> Option<u32> {
    let cursor = app.cursor_position().ok()?;
    let tauri_monitors = app.available_monitors().ok()?;
    let targets = screen_overlay_targets(monitors, &tauri_monitors).ok()?;
    // Flatten the tauri-typed targets to plain numbers so the hit-test lives in
    // the pure (and Windows-unit-testable) monitor_pairing module.
    let displays: Vec<(u32, i32, i32, u32, u32)> = targets
        .iter()
        .map(|(id, pos, size)| (*id, pos.x, pos.y, size.width, size.height))
        .collect();
    crate::monitor_pairing::monitor_at_point((cursor.x, cursor.y), &displays)
}

/// Capture a single display immediately, with no picker UI: record a session
/// (so a re-entrant hotkey press during the hide delay can't double-fire a
/// `CaptureCompleted`), hide the main window so ScreenPick isn't in the shot,
/// capture, then emit the outcome. Shared by the single-display fast path and
/// the capture-under-cursor hotkey.
fn capture_monitor_now(app: &AppHandle, monitor_id: u32) -> Result<(), String> {
    let session = app.state::<ScreenPickerSession>();
    let id = session.next_id();
    session.record(id);

    // Deliberately a longer settle than the picker's PICKER_HIDE_DELAY_MS: this
    // path hides the OPAQUE main editor window (not a translucent overlay), and
    // it lands in the full-screen shot if it's still compositing — so give it a
    // touch more time to disappear.
    if let Some(window) = app.get_webview_window("main") {
        hide_before_capture(&window, "main window", 180);
    } else {
        std::thread::sleep(std::time::Duration::from_millis(180));
    }

    let result = capture_monitor_by_id(app, monitor_id);
    let still_active = end_screen_session(app, Some(id));

    emit_capture_outcome(app, still_active, result).map(|_| ())
}

/// `(monitor id, overlay position, overlay size)` for one screen-picker overlay window.
type ScreenOverlayTarget = (u32, PhysicalPosition<i32>, PhysicalSize<u32>);

/// Converts the real monitor types into light-weight descriptors, pairs
/// them, and returns (monitor_id, position, size) tuples for overlay windows.
fn screen_overlay_targets(
    monitors: &[CapturableMonitor],
    tauri_monitors: &[tauri::Monitor],
) -> Result<Vec<ScreenOverlayTarget>, String> {
    let caps: Vec<CapMonitorInfo> = monitors
        .iter()
        .map(|m| CapMonitorInfo {
            id: m.id,
            name: m.name.clone(),
            x: m.x,
            y: m.y,
        })
        .collect();

    let tauris: Vec<TauriMonInfo> = tauri_monitors
        .iter()
        .map(|t| TauriMonInfo {
            name: t.name().cloned(),
            x: t.position().x,
            y: t.position().y,
            width: t.size().width,
            height: t.size().height,
        })
        .collect();

    pair_monitor_targets(&caps, &tauris).map(|targets| {
        targets
            .into_iter()
            .map(|(id, (x, y), (w, h))| {
                (
                    id,
                    PhysicalPosition { x, y },
                    PhysicalSize {
                        width: w,
                        height: h,
                    },
                )
            })
            .collect()
    })
}

async fn create_screen_picker_window(app: AppHandle, id: u64) {
    let app_for_load = app.clone();
    let picker = match WebviewWindowBuilder::new(
        &app,
        SCREEN_PICKER,
        WebviewUrl::App(format!("/{SCREEN_PICKER}").into()),
    )
    .title("ScreenPick Display")
    .inner_size(560.0, 600.0)
    .resizable(true)
    .always_on_top(true)
    .focused(false)
    .visible(false)
    .on_page_load(move |window, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            if !app_for_load.state::<ScreenPickerSession>().is_current(id) {
                let _ = window.close();
                return;
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
    .build()
    {
        Ok(window) => window,
        Err(err) => {
            let message = error_message(err);
            if end_screen_session(&app, Some(id)) {
                emit_capture_cancelled(&app, message);
                retry_close_screen_overlays(app.clone());
            }
            return;
        }
    };

    let app_for_handler = app.clone();
    picker.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) && end_screen_session(&app_for_handler, Some(id))
        {
            emit_capture_cancelled(&app_for_handler, "Screen capture cancelled.");
        }
    });
}

async fn create_screen_overlay_window(
    app: AppHandle,
    id: u64,
    index: usize,
    monitor_id: u32,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) {
    // Label by enumeration index, not monitor id: xcap ids are not guaranteed
    // unique across hot-plug / duplicate hardware (the whole reason
    // monitor_pairing exists), and a duplicate label would fail the second
    // overlay build and tear down the entire picker session. The monitor id
    // still travels as the query param so finish_screen_selection targets the
    // right display.
    let label = format!("{SCREEN_OVERLAY_PREFIX}{index}");
    let app_for_load = app.clone();
    let overlay = match WebviewWindowBuilder::new(
        &app,
        label.clone(),
        WebviewUrl::App(format!("/screen-overlay?monitorId={monitor_id}").into()),
    )
    .title("ScreenPick Display Overlay")
    .inner_size(1.0, 1.0)
    .decorations(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .on_page_load(move |window, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            if !app_for_load.state::<ScreenPickerSession>().is_current(id) {
                let _ = window.close();
                return;
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
    .build()
    {
        Ok(window) => window,
        Err(err) => {
            let message = error_message(err);
            if end_screen_session(&app, Some(id)) {
                emit_capture_cancelled(&app, message);
                retry_close_screen_overlays(app.clone());
            }
            return;
        }
    };
    place_overlay(&overlay, position, size);

    let app_for_handler = app.clone();
    overlay.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) && end_screen_session(&app_for_handler, Some(id))
        {
            emit_capture_cancelled(&app_for_handler, "Screen capture cancelled.");
        }
    });
}

#[tauri::command]
#[specta::specta]
pub(crate) fn list_screens_for_selection() -> Result<Vec<CapturableMonitor>, String> {
    list_capturable_monitors()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn finish_screen_selection(
    app: AppHandle,
    monitor_id: u32,
) -> Result<CaptureResult, String> {
    // Snapshot the session id BEFORE the hide-and-capture window so a re-entry
    // doesn't cause us to emit a CaptureCompleted on someone else's session.
    // finish_capture owns the hide/settle/end/restore/emit sequence; screen is
    // the one picker that also hides per-display overlays in the hide step.
    let session_id = app.state::<ScreenPickerSession>().current();
    finish_capture(
        &app,
        session_id,
        "Screen capture was already cancelled.",
        |app| {
            if let Some(window) = app.get_webview_window(SCREEN_PICKER) {
                hide_before_capture(&window, "screen picker", 0);
            }
            hide_screen_overlays(app);
        },
        finish_screen_session,
        move |app| capture_monitor_by_id(app, monitor_id),
    )
}

#[tauri::command]
#[specta::specta]
pub(crate) fn cancel_screen_selection(app: AppHandle) -> Result<(), String> {
    if end_screen_session(&app, None) {
        emit_capture_cancelled(&app, "Screen capture cancelled.");
    }
    Ok(())
}

fn end_screen_session(app: &AppHandle, expected_id: Option<u64>) -> bool {
    close_screen_overlays(app);
    app.state::<ScreenPickerSession>()
        .end(app, SCREEN_PICKER, expected_id)
}

fn finish_screen_session(app: &AppHandle, expected_id: Option<u64>) -> bool {
    close_screen_overlays(app);
    app.state::<ScreenPickerSession>()
        .end_without_restore(app, SCREEN_PICKER, expected_id)
}

fn hide_screen_overlays(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(SCREEN_OVERLAY_PREFIX) {
            // Load-bearing: this hide must land before the screenshot or the
            // overlay tint/border bleeds into the capture. Log rather than
            // swallow so that failure is diagnosable.
            if let Err(err) = window.hide() {
                log::warn!("failed to hide {label} before capture: {err}");
            }
        }
    }
}

fn close_screen_overlays(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(SCREEN_OVERLAY_PREFIX) {
            let _ = window.close();
        }
    }
}

fn retry_close_screen_overlays(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        std::thread::sleep(std::time::Duration::from_millis(75));
        close_screen_overlays(&app);
    });
}
