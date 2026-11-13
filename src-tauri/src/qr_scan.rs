//! Commands and events of the QR reader: the Scan QR capture mode (a region
//! selection that decodes instead of saving) and the editor's Read QR action.
//! The decoding and the link rule are pure and live in `qr.rs`.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::capture_trust_roots::verify_capture_source;
use crate::errors::error_message;
use crate::events::{CaptureCancelled, QrScanCompleted};
use crate::picker_session::run_capture_off_ui_thread;
use crate::qr::{decode_qr_codes, is_web_url, QrCode};
use crate::region::{begin_region_selection, RegionPurpose};

// What a scan found. `copied` says whether the texts reached the clipboard,
// so the frontend never claims a copy that failed.
#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QrScanResult {
    codes: Vec<QrCode>,
    copied: bool,
}

// Decode `image` and put the texts on the clipboard, one per line. Copied in
// Rust rather than by the webview: after a shortcut scan the main window is
// only just coming forward, and the webview clipboard refuses a write from a
// document without focus.
pub(crate) fn scan_result(image: &xcap::image::DynamicImage) -> QrScanResult {
    let codes = decode_qr_codes(image);
    let copied = !codes.is_empty() && copy_texts(&codes);
    log::info!("QR scan found {} code(s)", codes.len());
    QrScanResult { codes, copied }
}

fn copy_texts(codes: &[QrCode]) -> bool {
    let joined = codes
        .iter()
        .map(|code| code.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    match arboard::Clipboard::new().and_then(|mut clipboard| clipboard.set_text(joined)) {
        Ok(()) => true,
        Err(err) => {
            log::warn!("could not copy the QR text to the clipboard: {err}");
            false
        }
    }
}

// Terminal event of a region selection started by `start_qr_scan`. Same rule
// as `emit_capture_outcome`: nothing is emitted for a session this finish no
// longer owns.
pub(crate) fn emit_qr_scan_outcome(
    app: &AppHandle,
    still_active: bool,
    result: Result<QrScanResult, String>,
) -> Result<QrScanResult, String> {
    if still_active {
        let emitted = match &result {
            Ok(scan) => QrScanCompleted(scan.clone()).emit_to(app, "main"),
            Err(error) => CaptureCancelled(error.clone()).emit_to(app, "main"),
        };
        if let Err(err) = emitted {
            log::warn!("failed to emit the QR scan outcome: {err}");
        }
    }
    result
}

// Open the region overlay; the selection is decoded, not saved.
#[tauri::command]
#[specta::specta]
pub(crate) fn start_qr_scan(app: AppHandle) -> Result<(), String> {
    begin_region_selection(app, RegionPurpose::QrScan)
}

// Decode the QR codes in a capture the editor has open. The path passes the
// same trust check as the clipboard and reveal commands. Reading and scanning
// a whole capture is off the main thread, so the window stays responsive.
#[tauri::command]
#[specta::specta]
pub(crate) async fn decode_qr_in_capture(
    app: AppHandle,
    path: String,
) -> Result<QrScanResult, String> {
    let source = verify_capture_source(&app, &path)?;
    run_capture_off_ui_thread(move || {
        let image = xcap::image::open(&source).map_err(error_message)?;
        Ok(scan_result(&image))
    })
    .await
}

// Open a decoded link in the default browser. The webview cannot open one
// itself, and the check is repeated here because the text came off a screen:
// only an http(s) URL is ever handed to the OS.
#[tauri::command]
#[specta::specta]
pub(crate) fn open_qr_url(url: String) -> Result<(), String> {
    if !is_web_url(&url) {
        return Err("Only http and https links can be opened.".to_string());
    }
    crate::updates::open_in_browser(&url).map_err(|err| format!("Could not open the link: {err}"))
}
