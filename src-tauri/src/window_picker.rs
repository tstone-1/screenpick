use tauri::{
    webview::PageLoadEvent, window::Color, AppHandle, Manager, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

use crate::capture::{
    capture_window_at_point, ensure_screen_capture_access, error_message, window_bounds_at_point,
    CaptureResult, WindowBounds,
};
use crate::picker_session::{
    emit_capture_cancelled, finish_capture, hide_before_capture, place_overlay, PickerSession,
};

const WINDOW_PICKER: &str = "window-selector";

#[derive(Default)]
pub(crate) struct WindowPickerSession(PickerSession);

impl WindowPickerSession {
    // Explicit accessor instead of Deref: a call site always says which
    // session methods it's using, rather than relying on inherited methods
    // resolving invisibly through pseudo-inheritance.
    fn session(&self) -> &PickerSession {
        &self.0
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn start_window_selection(app: AppHandle) -> Result<(), String> {
    // Fail loudly before showing the overlay so the user gets the permission
    // prompt instead of a transparent overlay that errors only on click.
    ensure_screen_capture_access()?;

    app.state::<WindowPickerSession>()
        .session()
        .close_existing(&app, WINDOW_PICKER);

    let (position, size) = virtual_desktop_bounds(&app)?;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    let id = app.state::<WindowPickerSession>().session().next_id();
    app.state::<WindowPickerSession>().session().record(id);
    tauri::async_runtime::spawn(create_window_picker(app.clone(), id, position, size));
    Ok(())
}

/// Bounding box of every monitor, in physical pixels. The picker overlay spans
/// this whole virtual desktop so windows on any display can be targeted.
///
/// Note: on macOS with "Displays have separate Spaces" enabled, a single window
/// cannot span multiple displays, so the overlay is confined to one screen there.
/// Multi-display window picking on macOS would need one overlay per monitor.
fn virtual_desktop_bounds(
    app: &AppHandle,
) -> Result<(PhysicalPosition<i32>, PhysicalSize<u32>), String> {
    let monitors = app.available_monitors().map_err(error_message)?;
    let mut bounds: Option<(i32, i32, i32, i32)> = None;
    for monitor in &monitors {
        let pos = monitor.position();
        let size = monitor.size();
        let left = pos.x;
        let top = pos.y;
        let right = pos.x + size.width as i32;
        let bottom = pos.y + size.height as i32;
        bounds = Some(match bounds {
            Some((l, t, r, b)) => (l.min(left), t.min(top), r.max(right), b.max(bottom)),
            None => (left, top, right, bottom),
        });
    }

    let (left, top, right, bottom) =
        bounds.ok_or_else(|| "No displays available for capture.".to_string())?;
    Ok((
        PhysicalPosition { x: left, y: top },
        PhysicalSize {
            width: (right - left).max(1) as u32,
            height: (bottom - top).max(1) as u32,
        },
    ))
}

async fn create_window_picker(
    app: AppHandle,
    id: u64,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) {
    let picker = match WebviewWindowBuilder::new(
        &app,
        WINDOW_PICKER,
        WebviewUrl::App(format!("/{WINDOW_PICKER}").into()),
    )
    .title("ScreenPick Window")
    .inner_size(1.0, 1.0)
    .decorations(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .resizable(false)
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
            if end_window_session(&app, Some(id)) {
                emit_capture_cancelled(&app, message);
            }
            return;
        }
    };
    place_overlay(&picker, position, size);

    let app_for_handler = app.clone();
    picker.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) && end_window_session(&app_for_handler, Some(id))
        {
            emit_capture_cancelled(&app_for_handler, "Window capture cancelled.");
        }
    });
}

/// Maps between the overlay's CSS pointer coordinates and the coordinate space xcap
/// reports window rects in. The origin is the overlay client-area top-left; reading
/// the live `inner_position` keeps it correct regardless of the frame inset or a
/// negative virtual-desktop origin (a display left of / above the primary).
///
/// Units differ by platform: xcap reports physical pixels on Windows/Linux but
/// logical points on macOS (see `capture::primary_monitor` docs), while the
/// webview's `clientX/clientY` are always CSS pixels and `inner_position` is always
/// physical. `css_to_xcap` reconciles them via the overlay's scale factor, so the
/// math is correct at any DPI — not just 100%.
struct OverlayCoords {
    origin_x: f64,
    origin_y: f64,
    css_to_xcap: f64,
}

impl OverlayCoords {
    fn to_xcap(&self, css_x: f64, css_y: f64) -> (f64, f64) {
        (
            self.origin_x + css_x * self.css_to_xcap,
            self.origin_y + css_y * self.css_to_xcap,
        )
    }

    fn rect_to_css(&self, rect: WindowBounds) -> WindowBounds {
        let xcap_to_css = 1.0 / self.css_to_xcap;
        WindowBounds {
            x: (rect.x - self.origin_x) * xcap_to_css,
            y: (rect.y - self.origin_y) * xcap_to_css,
            width: rect.width * xcap_to_css,
            height: rect.height * xcap_to_css,
        }
    }
}

fn overlay_coords(app: &AppHandle) -> Result<OverlayCoords, String> {
    let overlay = app
        .get_webview_window(WINDOW_PICKER)
        .ok_or_else(|| "Window picker overlay is no longer available.".to_string())?;
    let inner = overlay.inner_position().map_err(error_message)?;
    let scale = overlay.scale_factor().map_err(error_message)?;

    // macOS: xcap uses logical points, which equal CSS pixels; convert the physical
    // inner_position into points for the origin. Elsewhere: xcap uses physical
    // pixels, so the origin is already physical and CSS scales up by the factor.
    #[cfg(target_os = "macos")]
    let coords = OverlayCoords {
        origin_x: f64::from(inner.x) / scale,
        origin_y: f64::from(inner.y) / scale,
        css_to_xcap: 1.0,
    };
    #[cfg(not(target_os = "macos"))]
    let coords = OverlayCoords {
        origin_x: f64::from(inner.x),
        origin_y: f64::from(inner.y),
        css_to_xcap: scale,
    };
    Ok(coords)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn finish_window_point_selection(
    app: AppHandle,
    x: f64,
    y: f64,
) -> Result<CaptureResult, String> {
    // Snapshot the session id BEFORE the hide-and-capture window so a re-entry
    // can't emit a CaptureCompleted on someone else's session.
    let session_id = app.state::<WindowPickerSession>().session().current();

    // Resolve the overlay coordinates BEFORE hiding it; inner_position is
    // unreliable once the window is hidden. finish_capture then owns the
    // hide/settle/end/restore/emit sequence.
    let coords = overlay_coords(&app);

    finish_capture(
        &app,
        session_id,
        "Window capture was already cancelled.",
        |app| {
            if let Some(window) = app.get_webview_window(WINDOW_PICKER) {
                hide_before_capture(&window, "window overlay", 0);
            }
        },
        finish_window_session,
        move |app| {
            coords.and_then(|coords| {
                let (point_x, point_y) = coords.to_xcap(x, y);
                capture_window_at_point(app, point_x, point_y)
            })
        },
    )
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_rect_at_point(
    app: AppHandle,
    x: f64,
    y: f64,
) -> Result<Option<WindowBounds>, String> {
    let coords = overlay_coords(&app)?;
    let (point_x, point_y) = coords.to_xcap(x, y);
    let bounds = window_bounds_at_point(point_x, point_y)?;
    Ok(bounds.map(|bounds| coords.rect_to_css(bounds)))
}

#[tauri::command]
#[specta::specta]
pub(crate) fn cancel_window_selection(app: AppHandle) -> Result<(), String> {
    if end_window_session(&app, None) {
        emit_capture_cancelled(&app, "Window capture cancelled.");
    }
    Ok(())
}

fn end_window_session(app: &AppHandle, expected_id: Option<u64>) -> bool {
    app.state::<WindowPickerSession>()
        .session()
        .end(app, WINDOW_PICKER, expected_id)
}

fn finish_window_session(app: &AppHandle, expected_id: Option<u64>) -> bool {
    app.state::<WindowPickerSession>()
        .session()
        .end_without_restore(app, WINDOW_PICKER, expected_id)
}
