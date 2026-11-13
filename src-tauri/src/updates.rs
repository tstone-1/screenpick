// Version-transition reporting for the in-app updater.
//
// The updater itself lives in `tauri-plugin-updater` and is driven from the
// frontend; the only thing Rust owns here is the answer to "is this launch the
// first one after an update?". That matters on macOS, where TCC keys the Screen
// Recording grant to the app's code-signature Designated Requirement.
//
// This is STILL NEEDED after Developer ID signing landed in 26.7.6, though the
// reason narrowed — do not delete it on the grounds that the app is signed now:
//
//   - Updating *to* 26.7.6 changes the signing identity itself (ad-hoc cdhash ->
//     Developer ID), so that one update breaks the grant a final time.
//   - Users still arriving from any pre-26.7.6 build hit the same transition,
//     and will keep doing so for as long as old builds are in the wild.
//
// From 26.7.6 onward the DR is anchored to a stable Team ID, so ordinary
// update-to-update transitions no longer drop the grant. The frontend uses this
// flag to re-check the permission and explain the fix, instead of leaving the
// user with an app that captures black frames. See ROADMAP P0 #1 and
// BUILD.md#macos-code-signing-and-notarization.
//
// Ungated module, so its tests run on Windows too — same split as
// `capture_modes`. The one item that needs Tauri, the `open_releases_page`
// command, carries the Windows-test gate itself (see the note above the gated
// `mod` list in `lib.rs`). The `update_transition` command lives in `settings`.
//
// NOTE: comments in this module use `//`, never `///`. Doc comments on
// specta-exposed types and fields are emitted as JSDoc into
// `src/lib/bindings.ts`, and the committed bindings carry none — a `///` here
// would fail the drift guard on macOS/Linux while passing on Windows.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateTransition {
    // The build that ran last, or `None` on a first run.
    previous_version: Option<String>,
    // The build running now.
    current_version: String,
    // Whether this launch is the first after a version change. Computed here
    // rather than re-derived in TypeScript so the "a first run is not an
    // update" rule has exactly one implementation, tested once.
    updated: bool,
}

impl UpdateTransition {
    // `updated` is true only when a *different* version ran before this one. A
    // first run (`None`) is deliberately not an update: a fresh install has no
    // stale permission grant to repair, and claiming otherwise would greet
    // every new user with a warning about an update that never happened.
    pub(crate) fn new(previous_version: Option<String>, current_version: String) -> Self {
        let updated = matches!(&previous_version, Some(previous) if previous != &current_version);
        Self {
            previous_version,
            current_version,
            updated,
        }
    }
}

// The releases page the update banner points at. The frontend holds the same
// string as RELEASES_URL in src/lib/updateState.svelte.ts. The command takes no
// parameter on purpose: the webview must never choose which URL gets opened.
#[cfg(not(all(test, target_os = "windows")))]
const RELEASES_URL: &str = "https://github.com/tstone-1/screenpick/releases/latest";

// The webview cannot open external URLs itself: no opener plugin is registered,
// and without a new-window handler a target="_blank" link does nothing on macOS
// and opens a bare in-app popup on Windows. The URL is a separate argv entry and
// never passes through a shell.
#[cfg(not(all(test, target_os = "windows")))]
#[tauri::command]
#[specta::specta]
pub(crate) fn open_releases_page() -> Result<(), String> {
    open_in_browser(RELEASES_URL).map_err(|err| format!("Could not open the releases page: {err}"))
}

// Hand `url` to the OS default browser. The caller decides that `url` is a
// web link; this only passes it on, as one string and with no shell between.
//
// Windows uses ShellExecuteW, not `explorer <url>`: explorer reads commas as
// separators (its `/select,<path>` syntax). Measured against a local server,
// `http://127.0.0.1:8765/x?q=a,b,c` reached it intact through ShellExecute and
// not at all through explorer. A QR code's link often has a comma.
#[cfg(all(target_os = "windows", not(test)))]
pub(crate) fn open_in_browser(url: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let target = HSTRING::from(url);
    // SAFETY: every pointer is a NUL-terminated wide string that outlives the
    // call; null parameters and directory are documented as allowed.
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &target,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // The documented success test: a value above 32. Below it is an error code.
    let code = result.0 as isize;
    if code > 32 {
        Ok(())
    } else {
        Err(format!("ShellExecute failed with code {code}"))
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(target_os = "macos"))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::UpdateTransition;

    fn transition(previous: Option<&str>, current: &str) -> UpdateTransition {
        UpdateTransition::new(previous.map(str::to_string), current.to_string())
    }

    #[test]
    fn first_run_is_not_an_update() {
        assert!(!transition(None, "26.7.6").updated);
    }

    #[test]
    fn same_version_relaunch_is_not_an_update() {
        assert!(!transition(Some("26.7.6"), "26.7.6").updated);
    }

    #[test]
    fn changed_version_is_an_update() {
        assert!(transition(Some("26.7.5"), "26.7.6").updated);
    }

    #[test]
    fn downgrade_counts_as_an_update() {
        // A sideways or backwards move still changes the code signature, so the
        // macOS permission repair applies just the same.
        assert!(transition(Some("26.7.6"), "26.7.5").updated);
    }
}
