// What the command line does without the app: capture to a file, list the
// displays, and print. Runs before Tauri starts, so there is no AppHandle, no
// settings and no logger here; a failure is returned as the message to print.
use std::path::Path;

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
    write_replacing(&request.output, |temp| {
        // The temporary name does not end in `.png`, so name the format; the
        // parser has already made sure the output does.
        image
            .save_with_format(temp, xcap::image::ImageFormat::Png)
            .map_err(error_message)
    })
    .map_err(|err| {
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

/// Write a file through a temporary neighbour and rename it into place, so a
/// write that fails halfway leaves `output` as it was (an earlier capture, or
/// nothing) instead of a truncated PNG. The neighbour is in the same folder
/// because a rename only replaces a file within one volume.
fn write_replacing(
    output: &Path,
    write: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let file_name = output
        .file_name()
        .ok_or_else(|| "the output has no file name".to_string())?
        .to_string_lossy();
    let temp = output.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));
    let written = write(&temp).and_then(|()| std::fs::rename(&temp, output).map_err(error_message));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
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

#[cfg(test)]
mod tests {
    use super::write_replacing;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "screenpick-cli-capture-test-{label}-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names_in(dir: &PathBuf) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_successful_write_replaces_the_file_and_leaves_nothing_else() {
        let dir = temp_dir("replace");
        let output = dir.join("shot.png");
        fs::write(&output, b"old").unwrap();

        let result = write_replacing(&output, |temp| {
            fs::write(temp, b"new").map_err(|err| err.to_string())
        });

        assert_eq!(result, Ok(()));
        assert_eq!(fs::read(&output).unwrap(), b"new");
        assert_eq!(names_in(&dir), ["shot.png"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_write_that_fails_halfway_keeps_the_old_file_and_removes_its_own() {
        let dir = temp_dir("failed");
        let output = dir.join("shot.png");
        fs::write(&output, b"old").unwrap();

        let result = write_replacing(&output, |temp| {
            fs::write(temp, b"half").unwrap();
            Err("disk full".to_string())
        });

        assert_eq!(result, Err("disk full".to_string()));
        assert_eq!(fs::read(&output).unwrap(), b"old");
        assert_eq!(names_in(&dir), ["shot.png"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_to_a_new_name_leaves_no_file() {
        let dir = temp_dir("failed-new");
        let output = dir.join("shot.png");

        let result = write_replacing(&output, |temp| {
            fs::write(temp, b"half").unwrap();
            Err("encode failed".to_string())
        });

        assert!(result.is_err());
        assert!(names_in(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
