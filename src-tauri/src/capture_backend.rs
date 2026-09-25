// One image boundary for window, screen and region capture. Keep color handling
// before PNG encoding: clipped 8-bit pixels cannot be repaired in the editor.
use xcap::{image::RgbaImage, Monitor, Window};

pub(crate) fn window_image(window: &Window) -> Result<RgbaImage, String> {
    #[cfg(target_os = "windows")]
    if let Some(image) = crate::windows_capture::window_image(window)? {
        return Ok(image);
    }
    window.capture_image().map_err(|e| e.to_string())
}

pub(crate) fn monitor_image(monitor: &Monitor) -> Result<RgbaImage, String> {
    #[cfg(target_os = "windows")]
    if let Some(image) = crate::windows_capture::monitor_image(monitor)? {
        return Ok(image);
    }
    monitor.capture_image().map_err(|e| e.to_string())
}

pub(crate) fn region_image(
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
