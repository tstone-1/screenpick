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
