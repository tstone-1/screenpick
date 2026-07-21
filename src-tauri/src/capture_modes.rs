use std::sync::OnceLock;

use serde::Serialize;
use specta::Type;

#[derive(Serialize, Clone, Debug, Type)]
pub(crate) struct CaptureMode {
    pub(crate) id: String,
    label: String,
    pub(crate) accelerators: Vec<String>,
}

pub(crate) fn capture_modes() -> &'static Vec<CaptureMode> {
    static MODES: OnceLock<Vec<CaptureMode>> = OnceLock::new();
    MODES.get_or_init(|| {
        vec![
            CaptureMode {
                id: "region".to_string(),
                label: "Region".to_string(),
                accelerators: vec!["CommandOrControl+Shift+4".to_string()],
            },
            CaptureMode {
                id: "window".to_string(),
                label: "Window".to_string(),
                accelerators: vec![
                    "CommandOrControl+Shift+W".to_string(),
                    "CommandOrControl+Alt+W".to_string(),
                ],
            },
            CaptureMode {
                id: "screen".to_string(),
                label: "Screen".to_string(),
                accelerators: vec![
                    "CommandOrControl+Shift+S".to_string(),
                    "CommandOrControl+Alt+S".to_string(),
                ],
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
                accelerators: vec!["CommandOrControl+Shift+Alt+S".to_string()],
            },
        ]
    })
}
