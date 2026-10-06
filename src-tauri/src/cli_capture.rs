// What the command line does without the app: capture to a file, list the
// displays, and print. Runs before Tauri starts, so there is no AppHandle, no
// settings and no logger here; a failure is returned as the message to print.
use xcap::Monitor;

use crate::capture::{ensure_screen_capture_access, list_capturable_monitors, primary_monitor};
use crate::cli::{HeadlessCapture, HeadlessTarget};
use crate::errors::error_message;

/// A release build is a GUI-subsystem program on Windows and starts without a
/// console, so `println!` from a terminal would go nowhere. Attach to the
/// terminal that started us. Fails harmlessly when there is none (a shortcut,
/// a scheduled task) or when one is already there (a debug build); redirected
/// output keeps going to its pipe or file either way.
#[cfg(target_os = "windows")]
pub(crate) fn attach_parent_console() {
    use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn attach_parent_console() {}

pub(crate) fn run_headless(request: &HeadlessCapture) -> Result<String, String> {
    ensure_screen_capture_access()?;
    let monitor = select_monitor(request.display)?;
    let image = match request.target {
        HeadlessTarget::Screen => crate::capture_backend::monitor_image(&monitor)?,
        HeadlessTarget::Region {
            x,
            y,
            width,
            height,
        } => {
            let monitor_width = monitor.width().map_err(error_message)?;
            let monitor_height = monitor.height().map_err(error_message)?;
            if u64::from(x) + u64::from(width) > u64::from(monitor_width)
                || u64::from(y) + u64::from(height) > u64::from(monitor_height)
            {
                return Err(format!(
                    "The rectangle ends outside the display, which is {monitor_width} x {monitor_height}."
                ));
            }
            crate::capture_backend::region_image(&monitor, x, y, width, height)?
        }
    };
    image.save(&request.output).map_err(|err| {
        format!(
            "Could not write {}: {err}",
            request.output.to_string_lossy()
        )
    })?;
    Ok(format!(
        "Saved {} x {} to {}",
        image.width(),
        image.height(),
        request.output.to_string_lossy()
    ))
}

pub(crate) fn list_displays() -> Result<String, String> {
    let lines = list_capturable_monitors()?
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let name = if monitor.friendly_name.is_empty() {
                &monitor.name
            } else {
                &monitor.friendly_name
            };
            format!(
                "{}  {} x {} at {},{}  scale {}{}  {}",
                index + 1,
                monitor.width,
                monitor.height,
                monitor.x,
                monitor.y,
                monitor.scale_factor,
                if monitor.primary { "  primary" } else { "" },
                name
            )
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Err("No display is available for capture.".to_string());
    }
    Ok(lines.join("\n"))
}

// `--display` counts through the same list `list_displays` prints, so the
// number a user reads there is the number that selects the display here.
fn select_monitor(display: Option<usize>) -> Result<Monitor, String> {
    let Some(number) = display else {
        return primary_monitor();
    };
    let listed = list_capturable_monitors()?;
    let entry = listed.get(number - 1).ok_or_else(|| {
        format!(
            "There is no display {number}; `screenpick displays` lists {}.",
            listed.len()
        )
    })?;
    Monitor::all()
        .map_err(error_message)?
        .into_iter()
        .find(|monitor| monitor.id().ok() == Some(entry.id))
        .ok_or_else(|| format!("Display {number} is no longer available."))
}
