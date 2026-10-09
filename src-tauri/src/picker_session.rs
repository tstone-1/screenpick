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

use crate::capture::CaptureResult;
use crate::events::{CaptureCancelled, CaptureCompleted};
use crate::main_window::restore_main_window;

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

/// Run a picker's blocking hide -> settle -> capture sequence off the UI thread.
///
/// A synchronous `#[tauri::command]` body runs on the main thread (only `async
/// fn` commands go to the async runtime), and on macOS a window does not leave
/// the screen at `orderOut:` — the ordering is flushed when the run loop next
/// turns. Sleeping on the main thread right after `hide()` therefore blocks the
/// very thread that has to apply the hide, so the overlay is still composited
/// when the screenshot is taken and its tint lands in every capture.
///
/// `spawn_blocking` (not `spawn`) because the sequence sleeps and does image
/// I/O: it must not be on the main thread, and it must not starve an async
/// runtime worker either.
pub(crate) async fn run_capture_off_ui_thread<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result,
        Err(err) => Err(format!("Capture task failed: {err}")),
    }
}

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
    let Some((still_active, result)) = finish_sequence(
        session_id,
        cancelled_message,
        || {
            hide(app);
            thread::sleep(Duration::from_millis(PICKER_HIDE_DELAY_MS));
        },
        |expected_id| end_session(app, expected_id),
        || capture(app),
    ) else {
        return Err(cancelled_message.to_string());
    };
    if still_active {
        restore_main_window(app);
    }

    emit_capture_outcome(app, still_active, result)
}

/// The order of a finish, without the windows: refuse a finish that saw no
/// session, hide and settle, end the session, and capture only if this call
/// still owned it. Kept free of `AppHandle` so the order itself is testable;
/// `finish_capture` and the picker-less screen capture supply the real steps.
///
/// Returns `None` when the finish was refused before anything ran, otherwise
/// whether this call ended the session together with the capture result.
pub(crate) fn finish_sequence<T>(
    session_id: Option<u64>,
    cancelled_message: &str,
    hide_and_settle: impl FnOnce(),
    end_session: impl FnOnce(Option<u64>) -> bool,
    capture: impl FnOnce() -> Result<T, String>,
) -> Option<(bool, Result<T, String>)> {
    if !finish_may_proceed(session_id) {
        // Nothing was active when this finish started, so it is reporting on a
        // session that a cancel command or the overlay's Destroyed handler
        // already tore down (and already emitted a cancellation for). Bail out
        // BEFORE the hide: the labels this path hides and ends are per-picker,
        // not per-session, so carrying on would hide and close a newer
        // session's overlay and capture with this one's stale selection.
        return None;
    }

    hide_and_settle();

    let still_active = end_session(session_id);
    let result = if still_active {
        capture()
    } else {
        Err(cancelled_message.to_string())
    };
    Some((still_active, result))
}

/// End a session, then run the picker's own teardown only if this call ended
/// it. The order matters when the teardown closes windows whose `Destroyed`
/// handler ends the session too: closing first lets such a handler win the
/// race against a finish on another thread, end the session and report a
/// cancellation for a pick that was made. With the session ended first, the
/// handler finds nothing to end. A caller that does not own the session also
/// must not close windows that may belong to a newer one.
pub(crate) fn end_then_teardown(end: impl FnOnce() -> bool, teardown: impl FnOnce()) -> bool {
    let ended = end();
    if ended {
        teardown();
    }
    ended
}

/// Whether a `finish_*` path may run its hide-and-capture sequence at all.
///
/// A finish snapshots `session().current()` before its hide window, and that
/// snapshot can legitimately be `None` — the session was already ended by a
/// cancel command or by the overlay's Destroyed handler. `None` must not travel
/// on to `should_end`, where it means the opposite thing: the unconditional
/// cancel the explicit cancel commands pass. A stale finish would then end
/// whichever session happens to be active by the time its settle sleep is over.
fn finish_may_proceed(session_id: Option<u64>) -> bool {
    session_id.is_some()
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

    /// Clear the active session if `expected_id` may end it (see `should_end`).
    /// The check and the clear happen under one lock, so of two callers racing
    /// to end the same session exactly one gets `true`.
    fn release(&self, expected_id: Option<u64>) -> bool {
        let mut current = self
            .current_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !should_end(*current, expected_id) {
            return false;
        }
        *current = None;
        true
    }

    fn end_inner(
        &self,
        app: &AppHandle,
        label: &str,
        expected_id: Option<u64>,
        restore_main: bool,
    ) -> bool {
        if !self.release(expected_id) {
            return false;
        }

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
    use super::{
        end_then_teardown, finish_may_proceed, finish_sequence, should_end, PickerSession,
    };
    use std::cell::RefCell;

    // What `finish_sequence` returns: whether the session was ended by this
    // call and the capture result, or None for a finish refused up front.
    type FinishOutcome = Option<(bool, Result<u8, String>)>;

    // Runs `finish_sequence` with steps that only write their name down.
    fn recorded_finish(session_id: Option<u64>, ends: bool) -> (Vec<&'static str>, FinishOutcome) {
        let steps = RefCell::new(Vec::new());
        let outcome = finish_sequence(
            session_id,
            "cancelled",
            || steps.borrow_mut().push("hide"),
            |_| {
                steps.borrow_mut().push("end");
                ends
            },
            || {
                steps.borrow_mut().push("capture");
                Ok(7)
            },
        );
        (steps.into_inner(), outcome)
    }

    #[test]
    fn a_finish_that_saw_no_session_runs_nothing() {
        // Not even the hide: the windows it would hide and end may belong to a
        // session started since.
        let (steps, outcome) = recorded_finish(None, true);
        assert!(steps.is_empty(), "ran {steps:?}");
        assert!(outcome.is_none());
    }

    #[test]
    fn a_finish_ends_its_session_before_it_captures() {
        let (steps, outcome) = recorded_finish(Some(3), true);
        assert_eq!(steps, ["hide", "end", "capture"]);
        assert_eq!(outcome, Some((true, Ok(7))));
    }

    #[test]
    fn a_finish_that_lost_its_session_does_not_capture() {
        let (steps, outcome) = recorded_finish(Some(3), false);
        assert_eq!(steps, ["hide", "end"]);
        assert_eq!(outcome, Some((false, Err("cancelled".to_string()))));
    }

    #[test]
    fn teardown_runs_after_the_session_ended_and_only_for_its_owner() {
        let session = PickerSession::default();
        let id = session.next_id();
        session.record(id);

        // What a window's Destroyed handler does while the teardown closes it.
        let handler_ended_it = RefCell::new(None);
        let ended = end_then_teardown(
            || session.release(Some(id)),
            || *handler_ended_it.borrow_mut() = Some(session.release(Some(id))),
        );
        assert!(ended);
        // The session was already over when the teardown ran, so the handler
        // had nothing to end and reports no cancellation.
        assert_eq!(handler_ended_it.into_inner(), Some(false));

        // A caller that does not own the session tears nothing down.
        session.record(session.next_id());
        let tore_down = RefCell::new(false);
        assert!(!end_then_teardown(
            || session.release(Some(id)),
            || *tore_down.borrow_mut() = true,
        ));
        assert!(!tore_down.into_inner());
    }

    #[test]
    fn finish_without_a_snapshot_is_already_cancelled() {
        // A finish that saw a live session runs its normal sequence.
        assert!(finish_may_proceed(Some(1)));
        // A finish that saw none must not reach should_end, whose None arm is
        // the unconditional cancel below and would let it end — and capture on
        // — a session started during its settle sleep.
        assert!(!finish_may_proceed(None));
        // That arm stays intact for the cancel commands it belongs to.
        assert!(should_end(Some(7), None));
    }

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
