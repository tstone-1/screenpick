use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow};
use tauri_specta::Event;

use crate::capture::{restore_main_window, CaptureResult};
use crate::events::{CaptureCancelled, CaptureCompleted};

/// Emit the terminal capture event for a finished picker session and return the
/// original result unchanged. Centralises the "emit only when this session is
/// still the active one" rule that every picker's `finish_*` command shares, so
/// the re-entry guard cannot drift between region/window/screen.
pub(crate) fn emit_capture_outcome(
    app: &AppHandle,
    still_active: bool,
    result: Result<CaptureResult, String>,
) -> Result<CaptureResult, String> {
    if still_active {
        match &result {
            Ok(capture) => {
                if let Err(err) = CaptureCompleted(capture.clone()).emit_to(app, "main") {
                    log::warn!("failed to emit capture completed event: {err}");
                }
            }
            Err(error) => {
                if let Err(err) = CaptureCancelled(error.clone()).emit_to(app, "main") {
                    log::warn!("failed to emit capture cancelled event: {err}");
                }
            }
        }
    }
    result
}

/// Emit a `CaptureCancelled` to the main window. Shared by every picker's cancel
/// command, overlay-build error path, and overlay-destroyed handler.
pub(crate) fn emit_capture_cancelled(app: &AppHandle, message: impl Into<String>) {
    if let Err(err) = CaptureCancelled(message.into()).emit_to(app, "main") {
        log::warn!("failed to emit capture cancelled event: {err}");
    }
}

/// Places `overlay` so its CLIENT area lands exactly on the target rect.
///
/// On Windows a borderless window keeps an invisible non-client frame even with
/// decorations disabled, so the client area (where the webview and its border
/// render) is inset from the window's outer rect. `set_position` places the
/// *outer* rect, which would leave the client area shifted off the target
/// origin and spilling onto the next display. Measure the inset and re-offset so
/// the client area lands exactly on the target.
///
/// macOS borderless windows have no non-client frame, so `inner == outer` and
/// no correction is needed. The correction is also actively harmful on macOS
/// because tao's `inner_position()` reports a coordinate-system artifact (mixed
/// physical/logical units inside `bottom_left_to_top_left`) instead of a real
/// inset, which the Windows-style fix-up would interpret as a huge offset and
/// shove the window off-screen.
pub(crate) fn place_overlay(
    overlay: &WebviewWindow,
    target_position: PhysicalPosition<i32>,
    target_size: PhysicalSize<u32>,
) {
    let _ = overlay.set_size(Size::Physical(target_size));
    let _ = overlay.set_position(Position::Physical(target_position));

    if cfg!(target_os = "macos") {
        return;
    }

    if let (Ok(outer), Ok(inner)) = (overlay.outer_position(), overlay.inner_position()) {
        let corrected = PhysicalPosition {
            x: target_position.x - (inner.x - outer.x),
            y: target_position.y - (inner.y - outer.y),
        };
        let _ = overlay.set_position(Position::Physical(corrected));
    }
}

pub(crate) fn hide_before_capture(window: &WebviewWindow, label: &str, delay_ms: u64) {
    if let Err(err) = window.hide() {
        log::warn!("failed to hide {label} before capture: {err}");
    }
    if delay_ms > 0 {
        thread::sleep(Duration::from_millis(delay_ms));
    }
}

/// The hide-and-settle delay (ms) before a picker capture. A translucent
/// overlay/picker window must actually leave the compositor before the
/// screenshot, or its tint/border bleeds into the captured pixels. Single
/// source of truth for region/window/screen so the three finish paths can't
/// drift (they previously used 150/150/120 independently).
const PICKER_HIDE_DELAY_MS: u64 = 150;

/// Shared finish-capture choreography for every picker (region/window/screen).
///
/// Centralises the order each `finish_*` command must follow — hide the picker
/// UI → settle → end the session (re-entry-guarded against `session_id`) →
/// capture only if still active → restore the main window → emit the terminal
/// event. This sequence was copy-pasted across the three pickers with drifting
/// hide delays; defining it once is the whole point.
///
/// - `hide` hides this picker's window(s) WITHOUT sleeping (screen also hides
///   its per-display overlays here); the single settle sleep happens after.
/// - `end_session` is the picker's own teardown (`end_without_restore` plus any
///   per-picker cleanup), returning whether this call still owns the session.
/// - `capture` takes the screenshot; `cancelled_message` is surfaced when the
///   session was replaced/cancelled during the hide window.
pub(crate) fn finish_capture(
    app: &AppHandle,
    session_id: Option<u64>,
    cancelled_message: &str,
    hide: impl FnOnce(&AppHandle),
    end_session: impl FnOnce(&AppHandle, Option<u64>) -> bool,
    capture: impl FnOnce(&AppHandle) -> Result<CaptureResult, String>,
) -> Result<CaptureResult, String> {
    hide(app);
    thread::sleep(Duration::from_millis(PICKER_HIDE_DELAY_MS));

    let still_active = end_session(app, session_id);
    let result = if still_active {
        capture(app)
    } else {
        Err(cancelled_message.to_string())
    };
    if still_active {
        restore_main_window(app);
    }

    emit_capture_outcome(app, still_active, result)
}

/// Decide whether a finish/cancel may end the active session.
///
/// `current` is the active session id (`None` = no active session); `expected`
/// is the id the caller snapshotted before its hide-and-capture window (`None`
/// = an unconditional cancel). Returns `false` when there is no active session,
/// or when a *different* session has since replaced the one the caller saw —
/// the re-entry guard that stops a global shortcut firing twice during the hide
/// delay from emitting a capture on the newer session.
fn should_end(current: Option<u64>, expected: Option<u64>) -> bool {
    match (current, expected) {
        (None, _) => false,
        (Some(_), None) => true,
        (Some(current_id), Some(expect)) => current_id == expect,
    }
}

#[derive(Default)]
pub(crate) struct PickerSession {
    current_id: Mutex<Option<u64>>,
    next_id: AtomicU64,
}

impl PickerSession {
    pub(crate) fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    pub(crate) fn record(&self, id: u64) {
        *self
            .current_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(id);
    }

    /// Snapshot the active session id so a finish/cancel path can detect
    /// re-entry (e.g. a global shortcut firing twice during the hide-and-
    /// capture window) and refuse to emit events for a session that has
    /// since been replaced.
    pub(crate) fn current(&self) -> Option<u64> {
        *self
            .current_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn is_current(&self, id: u64) -> bool {
        self.current() == Some(id)
    }

    pub(crate) fn close_existing(&self, app: &AppHandle, label: &str) {
        *self
            .current_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
    }

    pub(crate) fn end(&self, app: &AppHandle, label: &str, expected_id: Option<u64>) -> bool {
        self.end_inner(app, label, expected_id, true)
    }

    pub(crate) fn end_without_restore(
        &self,
        app: &AppHandle,
        label: &str,
        expected_id: Option<u64>,
    ) -> bool {
        self.end_inner(app, label, expected_id, false)
    }

    fn end_inner(
        &self,
        app: &AppHandle,
        label: &str,
        expected_id: Option<u64>,
        restore_main: bool,
    ) -> bool {
        let mut current = self
            .current_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !should_end(*current, expected_id) {
            return false;
        }
        *current = None;
        drop(current);

        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
        if restore_main {
            restore_main_window(app);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{should_end, PickerSession};

    #[test]
    fn should_end_enforces_reentry_guard() {
        // No active session: nothing to end.
        assert!(!should_end(None, None));
        assert!(!should_end(None, Some(1)));
        // Unconditional cancel ends whatever is active.
        assert!(should_end(Some(2), None));
        // The session the caller snapshotted is still the active one.
        assert!(should_end(Some(2), Some(2)));
        // A later session replaced the one the caller saw — stale, refuse.
        assert!(!should_end(Some(2), Some(1)));
    }

    /// Direct unit test for the session lifecycle without touching AppHandle.
    /// Mirrors the production logic by manually inspecting `current_id` after
    /// each call instead of going through `end()` (which needs an AppHandle).
    #[test]
    fn current_reflects_recorded_id() {
        let session = PickerSession::default();
        assert_eq!(session.current(), None);
        let id1 = session.next_id();
        session.record(id1);
        assert_eq!(session.current(), Some(id1));
        let id2 = session.next_id();
        session.record(id2);
        // record overwrites — re-entry replaces the active session.
        assert_eq!(session.current(), Some(id2));
        assert_ne!(id1, id2);
    }
}
