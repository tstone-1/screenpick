// Windows capture diagnostic using the production backend, without Tauri UI.
// cargo run --manifest-path src-tauri/Cargo.toml --example capture-color-probe -- <window-id> <output-dir>
// Run once without arguments to list window IDs. Images stay in the explicitly
// supplied directory; never add real desktop captures to the repository.
// --chart <file.html> writes a synthetic SDR chart to open in the target browser.
// Add --verify to a window capture to assert that every chart color survives.
// Add --display to verify monitor/region paths too (keep the chart unobscured).

#[cfg(windows)]
#[path = "../src/capture_backend.rs"]
mod capture_backend;
#[cfg(windows)]
#[path = "../src/capture_color.rs"]
mod capture_color;
#[cfg(windows)]
#[path = "../src/windows_capture.rs"]
mod windows_capture;

#[cfg(windows)]
const COLORS: [[u8; 3]; 10] = [
    [32, 32, 32],
    [64, 64, 64],
    [128, 128, 128],
    [192, 192, 192],
    [240, 240, 240],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [54, 76, 98],
    [0, 0, 0],
];

#[cfg(windows)]
fn verify(image: &xcap::image::RgbaImage) {
    for color in COLORS {
        let count = image
            .pixels()
            .filter(|p| (0..3).all(|i| p.0[i].abs_diff(color[i]) <= 1))
            .count();
        assert!(
            count > 10_000,
            "missing chart color {color:?}: {count} pixels"
        );
    }
    println!("[PASS] All 10 SDR chart colors survived capture (within one byte)");
}

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--chart") {
        let path = args.get(1).ok_or("supply an HTML output path")?;
        let mut html = String::from("<!doctype html><title>ScreenPick color test</title><style>body{margin:0;background:white}main{display:flex;flex-wrap:wrap;width:1000px}div{width:200px;height:200px}</style><main>");
        for [r, g, b] in COLORS {
            html.push_str(&format!(
                "<div style=\"background:rgb({r},{g},{b})\"></div>"
            ));
        }
        html.push_str("</main>");
        std::fs::write(path, html)?;
        return Ok(());
    }
    let windows = xcap::Window::all()?;
    if args.is_empty() {
        for window in windows {
            if !window.is_minimized()? {
                println!("{} {}", window.id()?, window.app_name()?);
            }
        }
        return Ok(());
    }
    let id: u32 = args[0].parse()?;
    let output = std::path::PathBuf::from(args.get(1).ok_or("supply an output directory")?);
    let window = windows
        .iter()
        .find(|w| w.id().ok() == Some(id))
        .ok_or("window no longer exists")?;
    std::fs::create_dir_all(&output)?;
    let monitor = window.current_monitor()?;
    println!(
        "SDR white scale: {:?}",
        windows_capture::white_scale(&monitor)?
    );
    window.capture_image()?.save(output.join("baseline.png"))?;
    let corrected = capture_backend::window_image(window)?;
    corrected.save(output.join("corrected.png"))?;
    if args.iter().any(|a| a == "--verify") {
        verify(&corrected);
    }
    if args.iter().any(|a| a == "--display") {
        let screen = capture_backend::monitor_image(&monitor)?;
        verify(&screen);
        // Exercise the region route with the chart's on-screen window bounds.
        let x = u32::try_from(window.x()? - monitor.x()?)?;
        let y = u32::try_from(window.y()? - monitor.y()?)?;
        let region =
            capture_backend::region_image(&monitor, x, y, corrected.width(), corrected.height())?;
        verify(&region);
        assert!(capture_backend::region_image(&monitor, screen.width(), 0, 1, 1).is_err());
    }
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    println!("This diagnostic requires Windows.");
}
