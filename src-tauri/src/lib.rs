mod capture_modes;
mod capture_trust;
mod document_store;
mod export_validation;
mod monitor_pairing;
mod path_utils;
mod shortcut_config;

// Windows Rust unit-test harnesses do not get Tauri's generated GUI manifest.
// Keep pure tests runnable without linking the desktop stack that imports
// common-controls v6 entry points.
//
// Verified 2026-07: this is a hard platform limit, not
// laziness. Ungating these modules (and `specta_builder`/the
// `specta_export` test below) compiles and links cleanly on Windows, but the
// resulting `screenpick_lib-*.exe` test binary then fails to even START —
// `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139) — because `tauri_build::build()`
// (build.rs) only embeds the generated Windows manifest (the one declaring
// the comctl32 v6 dependency) into the `bin` target via
// `rustc-link-arg-bin`; the `cargo test` harness links a `lib` target that
// never gets that manifest, so the OS side-by-side loader resolves a
// comctl32 import Tauri's GUI stack needs against the wrong (v5) DLL. There
// is no known way to get `tauri_build`'s manifest onto a test binary short of
// a nonstandard build.rs hack, which is out of proportion to the payoff here.
//
// Consequence: `export_typescript_bindings` (the bindings-drift guard for all
// 33+ commands / 4 events) — and every test inside these gated modules that
// isn't ALSO duplicated into an ungated pure module (see `document_store`,
// `path_utils`) — cannot run via `cargo test` on Windows, which is where all
// development happens. This is a real, standing gap: bindings drift is
// structurally invisible until someone runs `cargo test` on macOS/Linux.
// BUILD.md's release checklist has a hard gate for this — see "macOS bindings
// drift guard" under Pre-release Checklist. Do not cut a release without it.
#[cfg(not(all(test, target_os = "windows")))]
mod autostart;
#[cfg(not(all(test, target_os = "windows")))]
mod capture;
#[cfg(not(all(test, target_os = "windows")))]
mod documents;
#[cfg(not(all(test, target_os = "windows")))]
mod events;
#[cfg(not(all(test, target_os = "windows")))]
mod picker_session;
#[cfg(not(all(test, target_os = "windows")))]
mod region;
#[cfg(not(all(test, target_os = "windows")))]
mod screen_picker;
#[cfg(not(all(test, target_os = "windows")))]
mod settings;
#[cfg(not(all(test, target_os = "windows")))]
mod shortcuts;
#[cfg(not(all(test, target_os = "windows")))]
mod tray;
#[cfg(not(all(test, target_os = "windows")))]
mod window_picker;

#[cfg(not(all(test, target_os = "windows")))]
use events::{CaptureCancelled, CaptureCompleted, CaptureShortcut, ShortcutRegistration};
#[cfg(not(all(test, target_os = "windows")))]
use region::RegionPickerSession;
#[cfg(not(all(test, target_os = "windows")))]
use screen_picker::ScreenPickerSession;
#[cfg(not(all(test, target_os = "windows")))]
use settings::SettingsState;
#[cfg(not(all(test, target_os = "windows")))]
use shortcuts::ShortcutRegistry;
#[cfg(not(all(test, target_os = "windows")))]
use tauri::Manager;
#[cfg(not(all(test, target_os = "windows")))]
use tauri_specta::{collect_commands, collect_events, Builder};
#[cfg(not(all(test, target_os = "windows")))]
use window_picker::WindowPickerSession;

#[cfg(not(all(test, target_os = "windows")))]
#[tauri::command]
#[specta::specta]
fn app_status() -> &'static str {
    "ready"
}

#[cfg(not(all(test, target_os = "windows")))]
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            app_status,
            capture::list_capture_modes,
            shortcuts::shortcut_status,
            shortcuts::effective_shortcut_accelerators,
            capture::crop_capture,
            capture::cutout_capture,
            capture::save_png_bytes,
            capture::save_png_bytes_new,
            capture::copy_image_to_clipboard,
            capture::copy_png_bytes_to_clipboard,
            capture::reveal_in_dir,
            capture::capture_active_window,
            capture::screen_recording_access,
            capture::open_screen_recording_settings,
            documents::list_documents,
            documents::create_document,
            documents::replace_document_base,
            documents::save_document,
            documents::delete_document,
            settings::get_settings,
            settings::update_settings,
            settings::reset_shortcut_settings,
            autostart::autostart_enabled,
            autostart::set_autostart,
            region::start_region_selection,
            region::finish_region_selection,
            region::cancel_region_selection,
            window_picker::start_window_selection,
            window_picker::finish_window_point_selection,
            window_picker::window_rect_at_point,
            window_picker::cancel_window_selection,
            screen_picker::start_screen_selection,
            screen_picker::capture_screen_under_cursor,
            screen_picker::list_screens_for_selection,
            screen_picker::finish_screen_selection,
            screen_picker::cancel_screen_selection,
            tray::quit_app,
        ])
        .events(collect_events![
            CaptureShortcut,
            ShortcutRegistration,
            CaptureCompleted,
            CaptureCancelled,
        ])
}

/// Argument the login-autostart entry carries so a process started at login
/// knows to stay in the tray rather than show its window. A normal (manual)
/// launch never has it. Defined in one place so the plugin registration, the
/// startup check, and the tests can't drift. Ungated (a plain `&str` with no
/// GUI deps) so it's usable from the Windows unit-test build too.
const AUTOSTART_HIDDEN_FLAG: &str = "--hidden";

/// Whether this process was started by the OS login-autostart entry — i.e. its
/// args contain `flag` (`AUTOSTART_HIDDEN_FLAG`). Pure over an arg iterator so it
/// can be unit tested without a real process or GUI.
fn launched_hidden<I: IntoIterator<Item = String>>(args: I, flag: &str) -> bool {
    args.into_iter().any(|arg| arg == flag)
}

/// Set the main window title to `"screenpick v<version>"`, appending `" DEV"`
/// in debug builds (i.e. `tauri dev`) so a dev instance is visually
/// distinguishable from an installed release. The version comes from the
/// bundle's package info, which is sourced from `tauri.conf.json` / `Cargo.toml`
/// — keeping the title in sync with the single version of record automatically.
#[cfg(not(all(test, target_os = "windows")))]
fn set_window_title(app: &tauri::AppHandle) {
    let version = app.package_info().version.to_string();
    let suffix = if cfg!(debug_assertions) { " DEV" } else { "" };
    let title = format!("screenpick v{version}{suffix}");
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&title);
    }
}

/// Set once per launch, the first time we tell the user (on a close-to-tray
/// hide) that the app is still alive in the tray, so we don't nag on every
/// close. Intentionally resets each process start.
#[cfg(not(all(test, target_os = "windows")))]
static TRAY_HIDE_NOTICE_SHOWN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Whether a close should hide-to-tray rather than quit. Requires both that the
/// user enabled the setting AND that a tray icon actually exists — hiding with
/// no tray would strand the only window with no way back. Pure so it's unit
/// testable without a GUI.
fn should_hide_to_tray(close_to_tray: bool, tray_available: bool) -> bool {
    close_to_tray && tray_available
}

/// Intercept the main window's close button. When the user has enabled
/// "close to tray" (and the tray came up), hide the window instead of letting
/// the close destroy it (which, as the only window, would quit the app); the
/// always-present tray icon is how they get it back. Picker overlays are
/// label-gated out so their own `Destroyed` cleanup is untouched.
#[cfg(not(all(test, target_os = "windows")))]
fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let close_to_tray = window
            .app_handle()
            .try_state::<SettingsState>()
            .map(|state| state.get().close_to_tray)
            .unwrap_or(false);
        if should_hide_to_tray(close_to_tray, tray::tray_available()) {
            api.prevent_close();
            let _ = window.hide();
            notify_first_hide(window.app_handle());
        }
    }
}

/// On the first hide-to-tray, surface a system notification so the window
/// vanishing doesn't read as a crash. Best-effort — a notification failure must
/// not affect the hide.
#[cfg(not(all(test, target_os = "windows")))]
fn notify_first_hide(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri_plugin_notification::NotificationExt;

    if TRAY_HIDE_NOTICE_SHOWN.swap(true, Ordering::Relaxed) {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title("ScreenPick")
        .body("Still running in the tray. Use the tray icon to quit.")
        .show();
}

/// Tell the user when their saved settings had to be reset to defaults at
/// startup (an unreadable/oversized/corrupted file). A silent reset reads as
/// the app "forgetting" preferences; surfacing the cause — and where the bad
/// file was preserved — makes it explicable. Best-effort.
#[cfg(not(all(test, target_os = "windows")))]
fn notify_settings_reset(app: &tauri::AppHandle, recovery: &settings::SettingsRecovery) {
    use tauri_plugin_notification::NotificationExt;

    let mut body = format!(
        "Your saved settings {} and were reset to defaults.",
        recovery.reason
    );
    if let Some(path) = &recovery.backup_path {
        body.push_str(&format!(" The previous file was kept at {path}."));
    }
    let _ = app
        .notification()
        .builder()
        .title("ScreenPick")
        .body(body)
        .show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(not(all(test, target_os = "windows")))]
pub fn run() {
    let builder = specta_builder();

    tauri::Builder::default()
        // Must be the FIRST plugin registered. When a second launch occurs, this
        // process keeps running and the new one exits after handing us its argv;
        // we surface the already-running window instead of spawning a duplicate
        // (which would fight over the global shortcut and produce a second tray icon).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            capture::restore_main_window(app);
        }))
        // File + stderr logging. In a packaged build stderr goes nowhere, so the
        // LogDir target is what makes "it didn't work" diagnosable; Stderr keeps
        // `tauri dev` output intact. Verbose in dev, info+ in release.
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir { file_name: None },
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stderr,
                ))
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Register the login-autostart entry with AUTOSTART_HIDDEN_FLAG so a
        // login-launched process can tell itself apart from a manual launch and
        // stay in the tray instead of popping its window (see `launched_hidden`).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_HIDDEN_FLAG]),
        ))
        .plugin(tauri_plugin_notification::init())
        .manage(ShortcutRegistry::default())
        .manage(RegionPickerSession::default())
        .manage(ScreenPickerSession::default())
        .manage(WindowPickerSession::default())
        .invoke_handler(builder.invoke_handler())
        .on_window_event(handle_window_event)
        .setup(move |app| {
            builder.mount_events(app);

            let (settings_state, settings_recovery) =
                SettingsState::load(app.handle()).map_err(|err| {
                    std::io::Error::other(format!("failed to load capture settings: {err}"))
                })?;
            if let Some(recovery) = settings_recovery {
                notify_settings_reset(app.handle(), &recovery);
            }
            let initial_save_directory = settings_state
                .get()
                .save_directory
                .as_deref()
                .and_then(|dir| settings::validate_save_directory(app.handle(), Some(dir)).ok())
                .flatten();
            #[cfg(desktop)]
            let settings = settings_state.get();
            app.manage(settings_state);

            capture::seed_capture_sequence(app.handle());
            settings::extend_asset_scope_for_save_directory(
                app.handle(),
                initial_save_directory.as_deref(),
            );
            // Persistent annotation documents live under $APPLOCALDATA, outside the
            // default $APPCACHE asset scope — widen it so the editor can render
            // each document's base/current image.
            documents::extend_asset_scope(app.handle());

            #[cfg(desktop)]
            shortcuts::register_shortcuts_with_settings(app, &settings);

            set_window_title(app.handle());
            tray::build(app.handle());

            // The main window is `visible: false` in tauri.conf.json so nothing
            // flashes before we decide here. A login-launched process (its
            // autostart entry carries AUTOSTART_HIDDEN_FLAG) stays hidden in the
            // tray, matching the user's expectation that "start at login" means
            // "live in the tray". A manual launch shows the window as usual.
            if launched_hidden(std::env::args(), AUTOSTART_HIDDEN_FLAG) {
                log::info!("launched at login; staying hidden in the tray");
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            // Heal autostart entries written by a build that predates the hidden
            // flag: if autostart is on, re-register so the login command includes
            // AUTOSTART_HIDDEN_FLAG. Without this, users who enabled it in an
            // older version would keep getting the window on login until they
            // toggled the setting off and on. Best-effort — a failure here must
            // not abort startup.
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                let autolaunch = app.autolaunch();
                if autolaunch.is_enabled().unwrap_or(false) {
                    if let Err(err) = autolaunch.enable() {
                        log::warn!("could not refresh autostart entry: {err}");
                    }
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {
            // On macOS, clicking the dock icon while the window is hidden to the
            // tray emits Reopen with no window to activate — bring ours back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                capture::restore_main_window(_app);
            }
        });
}

#[cfg(all(test, target_os = "windows"))]
pub fn run() {}

#[cfg(test)]
mod tray_decision_tests {
    use super::should_hide_to_tray;

    #[test]
    fn should_hide_to_tray_requires_both_flags() {
        assert!(should_hide_to_tray(true, true));
        assert!(!should_hide_to_tray(true, false));
        assert!(!should_hide_to_tray(false, true));
        assert!(!should_hide_to_tray(false, false));
    }
}

#[cfg(test)]
mod launched_hidden_tests {
    use super::{launched_hidden, AUTOSTART_HIDDEN_FLAG};

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detects_the_hidden_flag_among_args() {
        // Mirrors a real autostart launch: exe path followed by the flag.
        let argv = args(&["/path/to/screenpick", AUTOSTART_HIDDEN_FLAG]);
        assert!(launched_hidden(argv, AUTOSTART_HIDDEN_FLAG));
    }

    #[test]
    fn manual_launch_has_no_hidden_flag() {
        let argv = args(&["/path/to/screenpick"]);
        assert!(!launched_hidden(argv, AUTOSTART_HIDDEN_FLAG));
    }

    #[test]
    fn does_not_match_a_partial_or_substring_arg() {
        let argv = args(&["/path/to/screenpick", "--hidden-thing", "hidden"]);
        assert!(!launched_hidden(argv, AUTOSTART_HIDDEN_FLAG));
    }
}

#[cfg(all(test, not(target_os = "windows")))]
mod specta_export {
    use super::specta_builder;
    use specta_typescript::Typescript;

    const BINDINGS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/bindings.ts");

    // Default: verifies src/lib/bindings.ts matches the live Rust contract; fails if drifted.
    // Regenerate with `BINDINGS_UPDATE=1 cargo test export_typescript_bindings`.
    #[test]
    fn export_typescript_bindings() {
        let temp = std::env::temp_dir().join("screenpick_bindings_check.ts");
        let _ = std::fs::remove_file(&temp);
        specta_builder()
            .export(Typescript::default(), &temp)
            .expect("failed to generate TypeScript bindings");
        let generated = std::fs::read_to_string(&temp).expect("failed to read generated bindings");

        if std::env::var_os("BINDINGS_UPDATE").is_some() {
            std::fs::write(BINDINGS_PATH, &generated).expect("failed to write src/lib/bindings.ts");
            return;
        }

        let current =
            std::fs::read_to_string(BINDINGS_PATH).expect("failed to read src/lib/bindings.ts");
        assert_eq!(
            current, generated,
            "src/lib/bindings.ts is out of sync with Rust types. \
             Regenerate with: BINDINGS_UPDATE=1 cargo test export_typescript_bindings"
        );
    }
}
