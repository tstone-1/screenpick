use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

use crate::capture::restore_main_window;

// Stable id so a re-run of setup can't leave two icons behind.
const TRAY_ID: &str = "main-tray";

// Whether the tray icon actually came up. The close-to-tray path consults this
// before hiding the window, so a failed tray can never strand the only window
// with no way to bring it back.
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);

// Build the always-present system tray icon. It's the only way back to the main
// window once "close to tray" hides it, so it exists on every launch regardless
// of the setting. Left-click restores the window; right-click opens a Show/Quit
// menu. Best-effort: a tray failure must not abort app startup — it just leaves
// `tray_available()` false so close-to-tray falls back to a normal close.
pub(crate) fn build(app: &AppHandle) {
    match try_build(app) {
        Ok(()) => TRAY_AVAILABLE.store(true, Ordering::Relaxed),
        Err(err) => log::error!("could not create system tray: {err}"),
    }
}

// True only once a tray icon has been successfully built.
pub(crate) fn tray_available() -> bool {
    TRAY_AVAILABLE.load(Ordering::Relaxed)
}

fn try_build(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // No icon means an invisible tray — treat that as a build failure rather
    // than shipping an unclickable icon the user can't find.
    //
    // macOS menu bar: use a dedicated monochrome silhouette rendered as a
    // template image (see `icon_as_template` below). The full-colour app icon
    // can't be a template — its opaque rounded-square background fills the whole
    // alpha mask, so macOS would draw it as a solid white box. The template asset
    // is just the capture-frame + plus on transparency, so only that shape shows.
    // Windows has no template concept and a dark taskbar tray, so it keeps the
    // colourful app icon where it reads well.
    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-macos.png"))?;
    #[cfg(not(target_os = "macos"))]
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("no default window icon available for the tray")?;

    let show = MenuItem::with_id(app, "show", "Show ScreenPick", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit ScreenPick", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;

    #[allow(unused_mut)]
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("ScreenPick")
        .icon(icon)
        .menu(&menu)
        // Left-click restores the window; the menu is reserved for right-click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => restore_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_main_window(tray.app_handle());
            }
        });

    // On the macOS menu bar, render as a template image so the icon adapts to
    // light/dark and matches native menu-bar items.
    #[cfg(target_os = "macos")]
    {
        builder = builder.icon_as_template(true);
    }

    builder.build(app)?;
    Ok(())
}

// Quit the whole app from the frontend. Needed because, with "close to tray"
// on, the window's close button only hides — this is the in-app way out.
#[tauri::command]
#[specta::specta]
pub(crate) fn quit_app(app: AppHandle) {
    app.exit(0);
}
