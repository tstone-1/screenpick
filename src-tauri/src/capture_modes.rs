use std::sync::OnceLock;

use serde::Serialize;
use specta::Type;

#[derive(Serialize, Clone, Debug, Type)]
pub(crate) struct CaptureMode {
    pub(crate) id: String,
    label: String,
    pub(crate) accelerators: Vec<String>,
}

/// Default accelerators are platform-split, because the short chords that are
/// free on Windows are all taken on macOS:
///
/// - `Cmd+Shift+4` is the system screenshot hotkey. The WindowServer handles it
///   before any `RegisterEventHotKey` client, so ScreenPick simply never sees
///   the press — the user gets the macOS region overlay instead.
/// - `Cmd+Shift+S` ("Save As" / "Duplicate") and `Cmd+Alt+W` ("Close All
///   Windows") are ordinary app menu equivalents, and a *global* hotkey
///   outranks those. Registering them would silently break those commands in
///   every other app for as long as ScreenPick is running — worse than the
///   region collision, because registration succeeds and nothing looks wrong.
///
/// Adding Option keeps every mnemonic and clears all three. Windows has none of
/// these collisions and keeps the shorter chords.
#[cfg(target_os = "macos")]
mod default_accelerators {
    pub(super) const REGION: &[&str] = &["CommandOrControl+Shift+Alt+4"];
    pub(super) const WINDOW: &[&str] = &["CommandOrControl+Shift+Alt+W"];
    pub(super) const SCREEN: &[&str] = &["CommandOrControl+Shift+Alt+S"];
    // Not the Alt+S chord that `screen` takes on macOS: D for "display".
    pub(super) const SCREEN_PICK: &[&str] = &["CommandOrControl+Shift+Alt+D"];
}

#[cfg(not(target_os = "macos"))]
mod default_accelerators {
    pub(super) const REGION: &[&str] = &["CommandOrControl+Shift+4"];
    pub(super) const WINDOW: &[&str] = &["CommandOrControl+Shift+W", "CommandOrControl+Alt+W"];
    pub(super) const SCREEN: &[&str] = &["CommandOrControl+Shift+S", "CommandOrControl+Alt+S"];
    pub(super) const SCREEN_PICK: &[&str] = &["CommandOrControl+Shift+Alt+S"];
}

fn owned(accelerators: &[&str]) -> Vec<String> {
    accelerators.iter().map(|a| (*a).to_string()).collect()
}

pub(crate) fn capture_modes() -> &'static Vec<CaptureMode> {
    static MODES: OnceLock<Vec<CaptureMode>> = OnceLock::new();
    MODES.get_or_init(|| {
        vec![
            CaptureMode {
                id: "region".to_string(),
                label: "Region".to_string(),
                accelerators: owned(default_accelerators::REGION),
            },
            CaptureMode {
                id: "window".to_string(),
                label: "Window".to_string(),
                accelerators: owned(default_accelerators::WINDOW),
            },
            CaptureMode {
                id: "screen".to_string(),
                label: "Screen".to_string(),
                accelerators: owned(default_accelerators::SCREEN),
            },
            // Opens the display picker. The plain "screen" hotkey captures the
            // display under the cursor instantly (no focus-stealing UI, so an
            // open context menu survives); this dedicated mode is the explicit
            // "let me choose a different display" path, on its own hotkey. It is
            // hidden from the main capture buttons (the Screen button already
            // opens the picker on click) but appears in the shortcut editor.
            CaptureMode {
                id: "screen-pick".to_string(),
                label: "Pick display".to_string(),
                accelerators: owned(default_accelerators::SCREEN_PICK),
            },
        ]
    })
}
