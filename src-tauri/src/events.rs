use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::capture::CaptureResult;
use crate::shortcuts::ShortcutStatus;

#[derive(Serialize, Deserialize, Clone, Debug, Type, Event)]
pub(crate) struct CaptureShortcut(pub String);

#[derive(Serialize, Deserialize, Clone, Debug, Type, Event)]
pub(crate) struct ShortcutRegistration(pub ShortcutStatus);

#[derive(Serialize, Deserialize, Clone, Debug, Type, Event)]
pub(crate) struct CaptureCompleted(pub CaptureResult);

#[derive(Serialize, Deserialize, Clone, Debug, Type, Event)]
pub(crate) struct CaptureCancelled(pub String);

// Emitted by the tray's "Check for updates" item. The check itself runs in the
// webview (that is where the updater plugin's progress and banner live), so the
// tray can only ask for one — hence an event rather than a command.
#[derive(Serialize, Deserialize, Clone, Debug, Type, Event)]
pub(crate) struct UpdateCheckRequested;
