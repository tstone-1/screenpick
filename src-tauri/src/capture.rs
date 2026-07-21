use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};
use xcap::{Monitor, Window};

use crate::capture_modes::{capture_modes, CaptureMode};
use crate::capture_trust::is_capture_source_trusted;
use crate::export_validation::{validate_png_export, verify_export_destination};

#[cfg(target_os = "macos")]
use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};

#[derive(Serialize, Deserialize, Clone, Debug, Type)]
pub(crate) struct CaptureResult {
    mode: String,
    title: String,
    path: String,
    width: u32,
    height: u32,
}

// Ceiling on the decoded RGBA buffer handed to the clipboard backend. Mirrors
// the 256 MiB export-payload cap so a malformed/oversized source can't drive a
// runaway allocation.
const MAX_CLIPBOARD_IMAGE_BYTES: usize = 256 * 1024 * 1024;

// Below this size, macOS surfaces are mostly menu-bar widgets, system tooltips,
// and other accessory windows that the user can't meaningfully target.
#[cfg(target_os = "macos")]
const MIN_CAPTURABLE_WINDOW_WIDTH: u32 = 160;
#[cfg(target_os = "macos")]
const MIN_CAPTURABLE_WINDOW_HEIGHT: u32 = 120;

#[derive(Serialize, Clone, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowBounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Serialize, Clone, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapturableMonitor {
    pub(crate) id: u32,
    pub(crate) name: String,
    friendly_name: String,
    pub(crate) x: i32,
    pub(crate) y: i32,
    width: u32,
    height: u32,
    scale_factor: f32,
    pub(crate) primary: bool,
}

#[tauri::command]
#[specta::specta]
pub(crate) fn list_capture_modes() -> Vec<CaptureMode> {
    capture_modes().clone()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn save_png_bytes(
    app: AppHandle,
    dest_path: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    // Keep the webview-exposed export command narrow: the frontend picks a PNG
    // destination via the save dialog, Rust verifies the suffix, payload, and
    // that the destination resolves to one of the user-data roots we accept.
    validate_png_export(&dest_path, &bytes)?;
    let roots = allowed_export_roots(&app);
    verify_export_destination(&dest_path, &roots)?;
    // TOCTOU note: there is a small window between verify_export_destination
    // (which rejects a symlinked final component and confines the parent to the
    // user-data roots) and this write, in which the final path component could
    // be swapped. Accepted: the destination always comes from the user's own
    // native save dialog and resolves inside their own profile dirs, so abusing
    // it needs write access the attacker would already have. Revisit with
    // create_new / O_NOFOLLOW semantics if exports ever take a non-dialog path.
    fs::write(&dest_path, bytes).map_err(|err| {
        log::error!("failed to write export to {dest_path}: {err}");
        "Failed to write export file.".to_string()
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn save_png_bytes_new(
    app: AppHandle,
    dest_path: String,
    bytes: Vec<u8>,
) -> Result<bool, String> {
    // Non-clobbering sibling of `save_png_bytes` for the dialog-less batch export
    // path (Recent multi-selection "Save N images as..."). The single-image save
    // dialog supplies its own overwrite prompt; batch save writes directly, so it
    // must never silently replace a file the user didn't mean to touch. `create_new`
    // also closes the TOCTOU window `save_png_bytes` documents: the existence check
    // and the create are one atomic syscall, and a symlinked dest is already
    // rejected by verify_export_destination above. Returns Ok(true) when a fresh
    // file was written, or Ok(false) when the name is already taken (the frontend
    // bumps the suffix and retries).
    validate_png_export(&dest_path, &bytes)?;
    let roots = allowed_export_roots(&app);
    verify_export_destination(&dest_path, &roots)?;
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&dest_path)
    {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(&bytes).map_err(|err| {
                log::error!("failed to write export to {dest_path}: {err}");
                "Failed to write export file.".to_string()
            })?;
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => {
            log::error!("failed to create export file {dest_path}: {err}");
            Err("Failed to write export file.".to_string())
        }
    }
}

/// User-data directories that the export command is allowed to write into.
/// Pictures, Documents, Desktop, Downloads are the standard places a user
/// would save a screenshot; the configured `save_directory` and the app's
/// cache `captures/` extend the set for app-managed exports.
fn allowed_export_roots(app: &AppHandle) -> Vec<PathBuf> {
    let path = app.path();
    let mut roots: Vec<PathBuf> = [
        path.picture_dir().ok(),
        path.document_dir().ok(),
        path.desktop_dir().ok(),
        path.download_dir().ok(),
        path.app_cache_dir().ok().map(|d| d.join("captures")),
    ]
    .into_iter()
    .flatten()
    .collect();
    if let Some(state) = app.try_state::<crate::settings::SettingsState>() {
        if let Some(dir) = state.get().save_directory {
            if let Ok(Some(valid)) = crate::settings::validate_save_directory(app, Some(&dir)) {
                roots.push(PathBuf::from(valid));
            }
        }
    }
    roots
}

// Convert to RGBA, enforce the size ceiling, and hand the raw buffer to the OS
// clipboard. Shared by the path-based and bytes-based copy commands so the cap
// and arboard plumbing live in one place.
fn set_clipboard_image(image: xcap::image::DynamicImage) -> Result<(), String> {
    let rgba = image.to_rgba8();
    let (width, height) = (rgba.width() as usize, rgba.height() as usize);
    if width.saturating_mul(height).saturating_mul(4) > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err("Image is too large to copy to the clipboard.".to_string());
    }
    let image_data = arboard::ImageData {
        width,
        height,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    };
    let mut clipboard = arboard::Clipboard::new().map_err(error_message)?;
    clipboard.set_image(image_data).map_err(error_message)
}

fn ensure_clipboard_dimensions_fit(width: u32, height: u32) -> Result<(), String> {
    if (width as usize)
        .saturating_mul(height as usize)
        .saturating_mul(4)
        > MAX_CLIPBOARD_IMAGE_BYTES
    {
        return Err("Image is too large to copy to the clipboard.".to_string());
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn copy_image_to_clipboard(app: AppHandle, path: String) -> Result<(), String> {
    let canonical_source = verify_capture_source(&app, &path)?;
    let image = xcap::image::open(&canonical_source).map_err(error_message)?;
    set_clipboard_image(image)
}

// Copy a flattened PNG (capture + annotations) rendered in the webview straight
// to the clipboard, without a round-trip through a saved file. The frontend's
// editor produces the bytes via `renderFlattenedPng`, so cropped/annotated
// edits are copied as shown, not just the on-disk source.
#[tauri::command]
#[specta::specta]
pub(crate) fn copy_png_bytes_to_clipboard(bytes: Vec<u8>) -> Result<(), String> {
    // Encoded-size sanity ceiling before decode, mirroring the decoded-buffer cap
    // in set_clipboard_image (a real PNG is always smaller encoded than decoded).
    if bytes.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err("Image is too large to copy to the clipboard.".to_string());
    }
    let reader = xcap::image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(error_message)?;
    let (width, height) = reader.into_dimensions().map_err(error_message)?;
    ensure_clipboard_dimensions_fit(width, height)?;
    let image = xcap::image::load_from_memory(&bytes).map_err(error_message)?;
    set_clipboard_image(image)
}

// Reveal a capture in the OS file manager (Explorer on Windows, Finder on
// macOS) with the file selected inside its containing folder. Gated by the same
// `verify_capture_source` trust check as the clipboard/crop commands so the
// webview can only ask us to reveal genuine ScreenPick captures, never an
// arbitrary path.
#[tauri::command]
#[specta::specta]
pub(crate) fn reveal_in_dir(app: AppHandle, path: String) -> Result<(), String> {
    let canonical_source = verify_capture_source(&app, &path)?;
    reveal_path_in_file_manager(&canonical_source)
}

#[cfg(target_os = "windows")]
fn reveal_path_in_file_manager(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // Explorer rejects the `\\?\` verbatim prefix that `canonicalize()` returns,
    // so hand it the plain path. Explorer parses its own command line rather than
    // going through CommandLineToArgvW, so the `/select,<path>` switch must arrive
    // verbatim: std's normal arg-quoting wraps the entire `/select,<path>` token
    // in quotes once the path contains spaces, which makes Explorer miss the
    // switch and just open the default folder (Documents) without selecting. Use
    // `raw_arg` to write the command line unescaped, quoting only the path.
    // Explorer is known to exit non-zero even on success, so we spawn-and-forget
    // and only surface a failure to launch the process at all.
    let display = strip_verbatim_prefix_path(path);
    // The path is already trust-gated (verify_capture_source) and Windows paths
    // cannot contain '"', but the command line below is hand-quoted via raw_arg
    // — reject a stray quote rather than let it break out of the quoting if the
    // trust set ever widens.
    if display.contains('"') {
        return Err("Cannot reveal a path containing a quote character.".to_string());
    }
    std::process::Command::new("explorer")
        .raw_arg(format!("/select,\"{display}\""))
        .spawn()
        .map_err(error_message)?;
    Ok(())
}

// Thin &Path adapter over the shared `path_utils::strip_verbatim_prefix`
// (settings.rs takes &str directly; Explorer's /select switch needs a &Path
// here) — one implementation, tested once in `path_utils::tests` (N2 in the
// code review: this used to be a second, undertested copy).
#[cfg(target_os = "windows")]
fn strip_verbatim_prefix_path(path: &Path) -> String {
    crate::path_utils::strip_verbatim_prefix(&path.to_string_lossy())
}

#[cfg(target_os = "macos")]
fn reveal_path_in_file_manager(path: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map_err(error_message)?;
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn reveal_path_in_file_manager(_path: &Path) -> Result<(), String> {
    Err("Reveal in folder is not supported on this platform.".to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn crop_capture(
    app: AppHandle,
    source_path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<CaptureResult, String> {
    if width == 0 || height == 0 {
        return Err("Crop selection must have width and height.".to_string());
    }

    let canonical_source = verify_capture_source(&app, &source_path)?;
    let image = xcap::image::open(&canonical_source).map_err(error_message)?;
    let image_width = image.width();
    let image_height = image.height();
    if x >= image_width || y >= image_height {
        return Err("Crop selection starts outside the image.".to_string());
    }

    let crop_width = width.min(image_width.saturating_sub(x));
    let crop_height = height.min(image_height.saturating_sub(y));
    if crop_width == 0 || crop_height == 0 {
        return Err("Crop selection is outside the image.".to_string());
    }

    let cropped = image.crop_imm(x, y, crop_width, crop_height);
    let path = capture_path(&app, "crop")?;
    cropped.save(&path).map_err(error_message)?;
    remember_capture_file(&app, &path);

    Ok(CaptureResult {
        mode: "crop".to_string(),
        title: format!("Crop - {} x {}", crop_width, crop_height),
        path: path.to_string_lossy().into_owned(),
        width: crop_width,
        height: crop_height,
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn cutout_capture(
    app: AppHandle,
    source_path: String,
    axis: String,
    start: u32,
    length: u32,
) -> Result<CaptureResult, String> {
    if length == 0 {
        return Err("Cut selection must have a thickness.".to_string());
    }

    let canonical_source = verify_capture_source(&app, &source_path)?;
    let image = xcap::image::open(&canonical_source).map_err(error_message)?;
    let image_width = image.width();
    let image_height = image.height();

    let result = match axis.as_str() {
        "horizontal" => cutout_horizontal(&image, image_width, image_height, start, length)?,
        "vertical" => cutout_vertical(&image, image_width, image_height, start, length)?,
        _ => return Err("Unknown cut axis.".to_string()),
    };

    let path = capture_path(&app, "cutout")?;
    result.save(&path).map_err(error_message)?;
    remember_capture_file(&app, &path);

    Ok(CaptureResult {
        mode: "cutout".to_string(),
        title: format!("Cut - {} x {}", result.width(), result.height()),
        path: path.to_string_lossy().into_owned(),
        width: result.width(),
        height: result.height(),
    })
}

fn cutout_horizontal(
    image: &xcap::image::DynamicImage,
    image_width: u32,
    image_height: u32,
    start: u32,
    length: u32,
) -> Result<xcap::image::DynamicImage, String> {
    if start >= image_height {
        return Err("Cut starts outside the image.".to_string());
    }
    let length = length.min(image_height - start);
    let new_height = image_height - length;
    if new_height == 0 {
        return Err("Cut would remove the whole image.".to_string());
    }

    // `length` is clamped to `image_height - start` above, so `cut_end` is
    // bounded by `image_height` and cannot overflow.
    let cut_end = start + length;
    let top = image.crop_imm(0, 0, image_width, start);
    let bottom = image.crop_imm(0, cut_end, image_width, image_height - cut_end);
    let mut canvas = xcap::image::RgbaImage::new(image_width, new_height);
    xcap::image::imageops::replace(&mut canvas, &top.to_rgba8(), 0, 0);
    xcap::image::imageops::replace(&mut canvas, &bottom.to_rgba8(), 0, i64::from(start));
    Ok(xcap::image::DynamicImage::ImageRgba8(canvas))
}

fn cutout_vertical(
    image: &xcap::image::DynamicImage,
    image_width: u32,
    image_height: u32,
    start: u32,
    length: u32,
) -> Result<xcap::image::DynamicImage, String> {
    if start >= image_width {
        return Err("Cut starts outside the image.".to_string());
    }
    let length = length.min(image_width - start);
    let new_width = image_width - length;
    if new_width == 0 {
        return Err("Cut would remove the whole image.".to_string());
    }

    // `length` is clamped to `image_width - start` above, so `cut_end` is
    // bounded by `image_width` and cannot overflow.
    let cut_end = start + length;
    let left = image.crop_imm(0, 0, start, image_height);
    let right = image.crop_imm(cut_end, 0, image_width - cut_end, image_height);
    let mut canvas = xcap::image::RgbaImage::new(new_width, image_height);
    xcap::image::imageops::replace(&mut canvas, &left.to_rgba8(), 0, 0);
    xcap::image::imageops::replace(&mut canvas, &right.to_rgba8(), i64::from(start), 0);
    Ok(xcap::image::DynamicImage::ImageRgba8(canvas))
}

pub(crate) fn capture_region_image(
    app: &AppHandle,
    monitor: &Monitor,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<CaptureResult, String> {
    ensure_screen_capture_access()?;

    let monitor_name = monitor
        .friendly_name()
        .or_else(|_| monitor.name())
        .unwrap_or_else(|_| "Region".to_string());
    let image = monitor
        .capture_region(x, y, width, height)
        .map_err(error_message)?;
    let path = capture_path(app, "region")?;
    image.save(&path).map_err(error_message)?;
    remember_capture_file(app, &path);

    Ok(CaptureResult {
        mode: "region".to_string(),
        title: format!("Region - {}", monitor_name),
        path: path.to_string_lossy().into_owned(),
        width: image.width(),
        height: image.height(),
    })
}

#[cfg(test)]
mod cutout_tests {
    use super::*;

    fn sample_image(width: u32, height: u32) -> xcap::image::DynamicImage {
        xcap::image::DynamicImage::ImageRgba8(xcap::image::RgbaImage::new(width, height))
    }

    #[test]
    fn horizontal_cut_reduces_height() {
        let image = sample_image(10, 8);
        let result = cutout_horizontal(&image, 10, 8, 2, 3).expect("cut should succeed");

        assert_eq!(result.width(), 10);
        assert_eq!(result.height(), 5);
    }

    #[test]
    fn vertical_cut_reduces_width() {
        let image = sample_image(10, 8);
        let result = cutout_vertical(&image, 10, 8, 2, 3).expect("cut should succeed");

        assert_eq!(result.width(), 7);
        assert_eq!(result.height(), 8);
    }

    #[test]
    fn cut_rejects_start_outside_or_whole_image() {
        let image = sample_image(10, 8);

        assert!(cutout_horizontal(&image, 10, 8, 8, 1).is_err());
        assert!(cutout_horizontal(&image, 10, 8, 0, 8).is_err());
        assert!(cutout_vertical(&image, 10, 8, 10, 1).is_err());
        assert!(cutout_vertical(&image, 10, 8, 0, 10).is_err());
    }
}

/// Predicate for windows the user is allowed to target via the picker overlay.
///
/// Filters out: empty metadata, ScreenPick's own windows, macOS system chrome,
/// minimized windows, and surfaces smaller than the platform's useful threshold.
fn is_window_capturable(
    app_name: &str,
    title: &str,
    width: u32,
    height: u32,
    window: &Window,
) -> bool {
    if app_name.is_empty() && title.is_empty() {
        return false;
    }
    if should_skip_window_metadata(app_name, title) {
        return false;
    }
    let app_lower = app_name.to_lowercase();
    let title_lower = title.to_lowercase();
    if app_lower.contains("screenpick") || title_lower.contains("screenpick") {
        return false;
    }
    if !is_useful_window_size(width, height) {
        return false;
    }
    if window.is_minimized().unwrap_or(false) {
        return false;
    }
    true
}

#[cfg(target_os = "macos")]
pub(crate) fn ensure_screen_capture_access() -> Result<(), String> {
    if CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() {
        return Ok(());
    }

    Err(
        "Screen Recording permission is required to list windows. Enable it for ScreenPick in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the app."
            .to_string(),
    )
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn ensure_screen_capture_access() -> Result<(), String> {
    Ok(())
}

// Read-only counterpart to `ensure_screen_capture_access`: report whether macOS
// Screen Recording permission is currently granted WITHOUT prompting. The
// capture path uses `ensure_screen_capture_access`, which triggers the one-time
// OS prompt; the UI polls this to decide whether to show its "grant access"
// banner (and to clear it once the user returns from System Settings having
// granted it). Non-macOS platforms have no such gate, so they always report
// granted.
#[tauri::command]
#[specta::specta]
pub(crate) fn screen_recording_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        CGPreflightScreenCaptureAccess()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

// Open the macOS System Settings pane where Screen Recording is granted
// (Privacy & Security > Screen & System Audio Recording). Deep-links via the
// `x-apple.systempreferences` URL scheme so the banner's button lands the user
// exactly where they need to be — the app registers no shell/opener plugin, so
// this native `open` is how the webview reaches an external URL. No-op on other
// platforms.
#[tauri::command]
#[specta::specta]
pub(crate) fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("Could not open System Settings: {err}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

fn should_skip_window_metadata(app_name: &str, title: &str) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }

    let app_name = app_name.trim();
    let title = title.trim();
    title.eq_ignore_ascii_case("Menubar")
        || matches!(
            app_name,
            "Control Center" | "Dock" | "Notification Center" | "SystemUIServer" | "Window Server"
        )
}

#[cfg(target_os = "macos")]
fn is_useful_window_size(width: u32, height: u32) -> bool {
    width >= MIN_CAPTURABLE_WINDOW_WIDTH && height >= MIN_CAPTURABLE_WINDOW_HEIGHT
}

#[cfg(not(target_os = "macos"))]
fn is_useful_window_size(width: u32, height: u32) -> bool {
    width > 0 && height > 0
}

pub(crate) fn capture_window_at_point(
    app: &AppHandle,
    point_x: f64,
    point_y: f64,
) -> Result<CaptureResult, String> {
    ensure_screen_capture_access()?;

    // point_x/point_y are absolute virtual-desktop coordinates; the window picker
    // overlay translates its client-relative pointer position before calling in.
    // Relies on xcap returning Window::all() in front-to-back z-order on macOS
    // (kCGWindowListOptionOnScreenOnly behavior). The first containing window is
    // therefore the topmost one. If this assumption ever fails, the user clicks
    // a window and gets one underneath. xcap is pinned in Cargo.toml accordingly.
    let window = Window::all()
        .map_err(error_message)?
        .into_iter()
        .find(|window| window_contains_point(window, point_x, point_y).unwrap_or(false))
        .ok_or_else(|| "No capturable window found at that point.".to_string())?;

    let app_name = window.app_name().unwrap_or_else(|_| "Window".to_string());
    let title = window.title().unwrap_or_default();
    write_window_capture(app, &window, app_name, title)
}

// Capture the currently-focused (foreground) window directly, with no picker
// overlay — the behavior the global Window shortcut wants, mirroring the OS
// Alt+PrintScreen. `is_focused()` maps to the OS foreground window; ScreenPick's
// own windows are filtered out by `is_window_capturable`, so triggering this
// while ScreenPick happens to be frontmost reports "no active window" rather
// than screenshotting ourselves.
#[tauri::command]
#[specta::specta]
pub(crate) fn capture_active_window(app: AppHandle) -> Result<CaptureResult, String> {
    ensure_screen_capture_access()?;

    let window = Window::all()
        .map_err(error_message)?
        .into_iter()
        .find(|window| window.is_focused().unwrap_or(false) && window_is_capturable(window))
        .ok_or_else(|| {
            "No capturable active window — bring the window you want to capture to the front."
                .to_string()
        })?;

    let app_name = window.app_name().unwrap_or_else(|_| "Window".to_string());
    let title = window.title().unwrap_or_default();
    let result = write_window_capture(&app, &window, app_name, title)?;
    if app
        .try_state::<crate::settings::SettingsState>()
        .map(|state| state.get().bring_to_front_on_hotkey_capture)
        .unwrap_or(false)
    {
        restore_main_window(&app);
    }
    Ok(result)
}

/// Whether a window passes the picker's capturability filter, fetching the
/// metadata `is_window_capturable` needs. Used to skip ScreenPick's own and
/// non-targetable windows when resolving the active window.
fn window_is_capturable(window: &Window) -> bool {
    let app_name = window.app_name().unwrap_or_default();
    let title = window.title().unwrap_or_default();
    let width = window.width().unwrap_or(0);
    let height = window.height().unwrap_or(0);
    is_window_capturable(&app_name, &title, width, height, window)
}

/// Absolute (virtual-desktop) bounding rect of the window `capture_window_at_point`
/// would select for the given absolute point, or `None` when no capturable window
/// is under it. The window picker translates this into overlay-relative coordinates
/// for the hover highlight. Matches the front-to-back z-order assumption in
/// `capture_window_at_point`, so the highlight always frames the window an actual
/// click would capture.
pub(crate) fn window_bounds_at_point(
    point_x: f64,
    point_y: f64,
) -> Result<Option<WindowBounds>, String> {
    ensure_screen_capture_access()?;

    let window = Window::all()
        .map_err(error_message)?
        .into_iter()
        .find(|window| window_contains_point(window, point_x, point_y).unwrap_or(false));

    let Some(window) = window else {
        return Ok(None);
    };

    Ok(Some(WindowBounds {
        x: f64::from(window.x().map_err(error_message)?),
        y: f64::from(window.y().map_err(error_message)?),
        width: f64::from(window.width().map_err(error_message)?),
        height: f64::from(window.height().map_err(error_message)?),
    }))
}

fn window_contains_point(window: &Window, point_x: f64, point_y: f64) -> Result<bool, String> {
    let app_name = window.app_name().map_err(error_message)?;
    let title = window.title().unwrap_or_default();
    let width = window.width().map_err(error_message)?;
    let height = window.height().map_err(error_message)?;
    if !is_window_capturable(&app_name, &title, width, height, window) {
        return Ok(false);
    }

    let x = f64::from(window.x().map_err(error_message)?);
    let y = f64::from(window.y().map_err(error_message)?);
    Ok(point_contained_in_rect(
        point_x, point_y, x, y, width, height,
    ))
}

fn point_contained_in_rect(
    point_x: f64,
    point_y: f64,
    rect_x: f64,
    rect_y: f64,
    width: u32,
    height: u32,
) -> bool {
    point_x >= rect_x
        && point_x < rect_x + f64::from(width)
        && point_y >= rect_y
        && point_y < rect_y + f64::from(height)
}

fn write_window_capture(
    app: &AppHandle,
    window: &Window,
    app_name: String,
    title: String,
) -> Result<CaptureResult, String> {
    if should_skip_window_metadata(&app_name, &title) {
        return Err("Selected window is not capturable.".to_string());
    }
    let image = window.capture_image().map_err(error_message)?;
    let label = if title.is_empty() {
        app_name
    } else {
        format!("{} - {}", app_name, title)
    };
    let path = capture_path(app, "window")?;
    image.save(&path).map_err(error_message)?;
    remember_capture_file(app, &path);

    Ok(CaptureResult {
        mode: "window".to_string(),
        title: label,
        path: path.to_string_lossy().into_owned(),
        width: image.width(),
        height: image.height(),
    })
}

pub(crate) fn list_capturable_monitors() -> Result<Vec<CapturableMonitor>, String> {
    ensure_screen_capture_access()?;

    let mut monitors = Monitor::all()
        .map_err(error_message)?
        .into_iter()
        .filter_map(|monitor| {
            let width = monitor.width().ok()?;
            let height = monitor.height().ok()?;
            if width == 0 || height == 0 {
                return None;
            }

            Some(CapturableMonitor {
                id: monitor.id().ok()?,
                name: monitor.name().unwrap_or_default(),
                friendly_name: monitor.friendly_name().unwrap_or_default(),
                x: monitor.x().unwrap_or_default(),
                y: monitor.y().unwrap_or_default(),
                width,
                height,
                scale_factor: monitor.scale_factor().unwrap_or(1.0),
                primary: monitor.is_primary().unwrap_or(false),
            })
        })
        .collect::<Vec<_>>();

    monitors.sort_by(|a, b| b.primary.cmp(&a.primary).then(a.id.cmp(&b.id)));
    Ok(monitors)
}

pub(crate) fn capture_monitor_by_id(
    app: &AppHandle,
    monitor_id: u32,
) -> Result<CaptureResult, String> {
    ensure_screen_capture_access()?;

    let monitor = Monitor::all()
        .map_err(error_message)?
        .into_iter()
        .find(|monitor| monitor.id().ok() == Some(monitor_id))
        .ok_or_else(|| "Selected display is no longer available.".to_string())?;
    capture_monitor(app, &monitor)
}

fn capture_monitor(app: &AppHandle, monitor: &Monitor) -> Result<CaptureResult, String> {
    let name = monitor
        .friendly_name()
        .or_else(|_| monitor.name())
        .unwrap_or_else(|_| "Display".to_string());
    let image = monitor.capture_image().map_err(error_message)?;
    let path = capture_path(app, "screen")?;
    image.save(&path).map_err(error_message)?;
    remember_capture_file(app, &path);

    Ok(CaptureResult {
        mode: "screen".to_string(),
        title: format!("Screen - {}", name),
        path: path.to_string_lossy().into_owned(),
        width: image.width(),
        height: image.height(),
    })
}

/// Returns the primary monitor.
///
/// Note: on macOS, xcap reports `Monitor::x/y/width/height` in **logical** pixels
/// (CSS-equivalent). Region capture still uses this xcap monitor as the pixel
/// source, but overlay placement uses Tauri monitor physical bounds via
/// `place_overlay` so Windows per-monitor DPI scaling does not resize the
/// selector window incorrectly.
pub(crate) fn primary_monitor() -> Result<Monitor, String> {
    let mut monitors = Monitor::all().map_err(error_message)?;
    let primary_index = monitors
        .iter()
        .position(|monitor| monitor.is_primary().unwrap_or(false))
        .unwrap_or(0);

    if monitors.is_empty() {
        Err("No monitors available for capture.".to_string())
    } else {
        Ok(monitors.swap_remove(primary_index))
    }
}

pub(crate) fn restore_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn capture_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = app
        .try_state::<crate::settings::SettingsState>()
        .map(|s| s.get());

    if let Some(Some(dir)) = settings.as_ref().map(|s| s.save_directory.as_ref()) {
        crate::settings::validate_save_directory(app, Some(dir))?;
        let path = PathBuf::from(dir);
        if path.is_dir() {
            return Ok(path);
        }
        let create_err = fs::create_dir_all(&path).err();
        if path.is_dir() {
            return Ok(path);
        }
        return match create_err {
            Some(err) => Err(format!(
                "Configured save directory is not available: {dir} ({err})"
            )),
            None => Err(format!("Configured save directory is not available: {dir}")),
        };
    }

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(error_message)?
        .join("captures");
    fs::create_dir_all(&dir).map_err(error_message)?;
    Ok(dir)
}

fn capture_path(app: &AppHandle, mode: &str) -> Result<PathBuf, String> {
    let dir = capture_dir(app)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(error_message)?
        .as_millis();
    Ok(dir.join(capture_filename(mode, timestamp, next_capture_sequence())))
}

pub(crate) fn error_message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub(crate) fn verify_capture_source(app: &AppHandle, source_path: &str) -> Result<PathBuf, String> {
    let canonical_source = Path::new(source_path)
        .canonicalize()
        .map_err(error_message)?;

    let settings = app.try_state::<crate::settings::SettingsState>();
    let trusted_files = settings
        .as_ref()
        .map(|state| state.trusted_capture_files())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.canonicalize().ok())
        .collect::<Vec<_>>();
    let default_root = app
        .path()
        .app_cache_dir()
        .map_err(error_message)?
        .join("captures")
        .canonicalize()
        .ok();

    // The persistent document store (`$APPLOCALDATA/documents`) lives outside the
    // capture cache, but its base.png / current.png are app-managed ScreenPick
    // images that copy-path, reveal, and re-crop legitimately act on — trust them
    // too. Canonicalized so `..` / symlinks can't smuggle in an outside path.
    let trusted_in_documents = crate::documents::documents_root_canonical(app)
        .is_some_and(|root| canonical_source.starts_with(root));

    if !trusted_in_documents
        && !is_capture_source_trusted(&canonical_source, &trusted_files, default_root.as_deref())
    {
        return Err("Source must be a ScreenPick capture.".to_string());
    }
    Ok(canonical_source)
}

fn remember_capture_file(app: &AppHandle, path: &Path) {
    if let Some(settings) = app.try_state::<crate::settings::SettingsState>() {
        settings.remember_capture_file(path);
    }
}

static NEXT_CAPTURE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn next_capture_sequence() -> u64 {
    NEXT_CAPTURE_SEQUENCE.fetch_add(1, Ordering::SeqCst)
}

/// Scan known capture roots and bump the in-process sequence past the highest
/// already on disk so a restart can't reuse a filename if the user takes two
/// captures in the same wall-clock millisecond across the boundary.
pub(crate) fn seed_capture_sequence(app: &AppHandle) {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(cache) = app.path().app_cache_dir() {
        roots.push(cache.join("captures"));
    }
    if let Some(state) = app.try_state::<crate::settings::SettingsState>() {
        if let Some(dir) = state.get().save_directory {
            if let Ok(Some(valid)) = crate::settings::validate_save_directory(app, Some(&dir)) {
                roots.push(PathBuf::from(valid));
            }
        }
    }
    let highest = roots
        .iter()
        .filter_map(|dir| highest_capture_sequence_in(dir).ok())
        .max()
        .unwrap_or(0);
    if highest >= NEXT_CAPTURE_SEQUENCE.load(Ordering::SeqCst) {
        NEXT_CAPTURE_SEQUENCE.store(highest + 1, Ordering::SeqCst);
    }
}

fn highest_capture_sequence_in(dir: &Path) -> Result<u64, std::io::Error> {
    let mut highest = 0u64;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if let Some(name) = entry.file_name().to_str() {
            if let Some(seq) = parse_capture_sequence(name) {
                if seq > highest {
                    highest = seq;
                }
            }
        }
    }
    Ok(highest)
}

fn parse_capture_sequence(filename: &str) -> Option<u64> {
    let stem = filename.strip_suffix(".png")?;
    let rest = stem.strip_prefix("screenpick-")?;
    // Expected shape: <mode>-<timestamp>-<sequence>
    let last_dash = rest.rfind('-')?;
    rest[last_dash + 1..].parse::<u64>().ok()
}

fn capture_filename(mode: &str, timestamp: u128, sequence: u64) -> String {
    format!("screenpick-{}-{}-{}.png", mode, timestamp, sequence)
}

#[cfg(test)]
mod tests {
    use super::{
        capture_filename, ensure_clipboard_dimensions_fit, highest_capture_sequence_in,
        is_useful_window_size, parse_capture_sequence, point_contained_in_rect,
        should_skip_window_metadata,
    };

    #[test]
    fn capture_filename_includes_sequence_for_same_millisecond() {
        let first = capture_filename("screen", 42, 1);
        let second = capture_filename("screen", 42, 2);

        assert_ne!(first, second);
        assert_eq!(first, "screenpick-screen-42-1.png");
        assert_eq!(second, "screenpick-screen-42-2.png");
    }

    #[test]
    fn parse_capture_sequence_handles_known_shapes() {
        assert_eq!(
            parse_capture_sequence("screenpick-region-42-7.png"),
            Some(7)
        );
        assert_eq!(
            parse_capture_sequence("screenpick-window-1700000000000-12345.png"),
            Some(12345)
        );
        assert_eq!(parse_capture_sequence("unrelated.png"), None);
        assert_eq!(parse_capture_sequence("screenpick-screen-42-.png"), None);
        assert_eq!(parse_capture_sequence("screenpick-region-42-7.jpg"), None);
        assert_eq!(parse_capture_sequence("screenpick-region-42-abc.png"), None);
    }

    #[test]
    fn highest_capture_sequence_in_picks_max_and_ignores_non_capture_files() {
        let dir = std::env::temp_dir().join(format!("screenpick-seed-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "screenpick-region-42-3.png",
            "screenpick-window-99-17.png",
            "screenpick-screen-99-5.png",
            "ignored.txt",
            "screenpick-bad.png",
        ] {
            std::fs::write(dir.join(name), b"").unwrap();
        }
        assert_eq!(highest_capture_sequence_in(&dir).unwrap(), 17);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn should_skip_window_metadata_filters_macos_chrome() {
        assert!(should_skip_window_metadata("Dock", ""));
        assert!(should_skip_window_metadata("Control Center", ""));
        assert!(should_skip_window_metadata("Notification Center", ""));
        assert!(should_skip_window_metadata("SystemUIServer", ""));
        assert!(should_skip_window_metadata("Window Server", ""));
        assert!(should_skip_window_metadata("MyApp", "Menubar"));
        assert!(should_skip_window_metadata("MyApp", "menubar"));
        assert!(!should_skip_window_metadata("Safari", "GitHub"));
        assert!(!should_skip_window_metadata("Terminal", ""));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn should_skip_window_metadata_is_noop_off_macos() {
        assert!(!should_skip_window_metadata("Dock", ""));
        assert!(!should_skip_window_metadata("MyApp", "Menubar"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn is_useful_window_size_enforces_macos_threshold() {
        assert!(!is_useful_window_size(159, 200));
        assert!(!is_useful_window_size(200, 119));
        assert!(!is_useful_window_size(0, 0));
        assert!(is_useful_window_size(160, 120));
        assert!(is_useful_window_size(1920, 1080));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn is_useful_window_size_rejects_zero_off_macos() {
        assert!(!is_useful_window_size(0, 0));
        assert!(!is_useful_window_size(10, 0));
        assert!(!is_useful_window_size(0, 10));
        assert!(is_useful_window_size(1, 1));
    }

    #[test]
    fn point_contained_in_rect_is_half_open() {
        // Rect at (100, 100) sized 200x200 covers x in [100, 300), y in [100, 300).
        assert!(point_contained_in_rect(
            100.0, 100.0, 100.0, 100.0, 200, 200
        ));
        assert!(point_contained_in_rect(
            150.0, 150.0, 100.0, 100.0, 200, 200
        ));
        assert!(point_contained_in_rect(
            299.9, 299.9, 100.0, 100.0, 200, 200
        ));
        // Right and bottom edges are exclusive so adjacent windows don't both match.
        assert!(!point_contained_in_rect(
            300.0, 200.0, 100.0, 100.0, 200, 200
        ));
        assert!(!point_contained_in_rect(
            200.0, 300.0, 100.0, 100.0, 200, 200
        ));
        // Outside on all sides.
        assert!(!point_contained_in_rect(
            99.9, 200.0, 100.0, 100.0, 200, 200
        ));
        assert!(!point_contained_in_rect(
            200.0, 99.9, 100.0, 100.0, 200, 200
        ));
    }

    #[test]
    fn clipboard_dimension_guard_rejects_huge_decoded_images() {
        assert!(ensure_clipboard_dimensions_fit(60_000, 60_000).is_err());
        assert!(ensure_clipboard_dimensions_fit(100, 100).is_ok());
    }
}
