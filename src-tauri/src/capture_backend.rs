// One image boundary for window, screen and region capture. Keep color handling
// before PNG encoding: clipped 8-bit pixels cannot be repaired in the editor.
use xcap::{image::RgbaImage, Monitor, Window};

// A failed capture reaches the user as a status line only. The log keeps which
// call failed: on Windows a display-config query failure stops the capture on
// purpose (falling back would hand out wrong colors on an HDR display), so the
// log line is the only way to tell that case from an ordinary capture error.
fn logged(kind: &str, result: Result<RgbaImage, String>) -> Result<RgbaImage, String> {
    result.inspect_err(|err| log::warn!("{kind} capture failed: {err}"))
}

pub(crate) fn window_image(window: &Window) -> Result<RgbaImage, String> {
    logged("window", window_image_inner(window))
}

pub(crate) fn monitor_image(monitor: &Monitor) -> Result<RgbaImage, String> {
    logged("screen", monitor_image_inner(monitor))
}

pub(crate) fn region_image(
    monitor: &Monitor,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<RgbaImage, String> {
    logged("region", region_image_inner(monitor, x, y, width, height))
}

fn window_image_inner(window: &Window) -> Result<RgbaImage, String> {
    #[cfg(target_os = "windows")]
    if let Some(image) = crate::windows_capture::window_image(window)? {
        return Ok(image);
    }
    window.capture_image().map_err(|e| e.to_string())
}

fn monitor_image_inner(monitor: &Monitor) -> Result<RgbaImage, String> {
    #[cfg(target_os = "windows")]
    if let Some(image) = crate::windows_capture::monitor_image(monitor)? {
        return Ok(image);
    }
    monitor.capture_image().map_err(|e| e.to_string())
}

fn region_image_inner(
    monitor: &Monitor,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<RgbaImage, String> {
    #[cfg(target_os = "windows")]
    if let Some(image) = crate::windows_capture::monitor_image(monitor)? {
        if width == 0
            || height == 0
            || u64::from(x) + u64::from(width) > u64::from(image.width())
            || u64::from(y) + u64::from(height) > u64::from(image.height())
        {
            return Err("Capture region is outside the current display bounds".into());
        }
        return Ok(xcap::image::imageops::crop_imm(&image, x, y, width, height).to_image());
    }
    monitor
        .capture_region(x, y, width, height)
        .map_err(|e| e.to_string())
}
