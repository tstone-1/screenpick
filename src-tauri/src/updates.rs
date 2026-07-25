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
// Pure module (no `tauri::` imports) so it stays in the ungated family and its
// tests run on Windows too — same split as `capture_modes` and the command that
// returns it. The `update_transition` command lives in `settings`.
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
