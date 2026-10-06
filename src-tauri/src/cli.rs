// Command-line parsing. Pure and ungated, so `cargo test` covers it on Windows
// too; what a parsed command does lives in `cli_capture` and in `run()`.
//
// Two kinds of capture command exist, and `--output` is what tells them apart:
// without it the command asks the running app to do what the mode's global
// shortcut does; with it the capture is taken in this process, with no window
// and no running app, and written to the named file.
use std::path::PathBuf;

use crate::capture_modes::capture_modes;

pub(crate) const USAGE: &str = "\
ScreenPick command line

Usage:
  screenpick
      Start ScreenPick, or show its window when it is already running.
  screenpick capture <mode>
      Start a capture in ScreenPick, exactly as the mode's shortcut does.
      Modes: region, window, screen, screen-pick.
  screenpick capture screen --output <file.png> [--display <n>]
  screenpick capture region --rect <x,y,width,height> --output <file.png> [--display <n>]
      Capture at once, without any window, and write the PNG. An existing
      file is replaced. ScreenPick does not need to be running.
  screenpick displays
      List the displays with the numbers --display takes.
  screenpick --version
  screenpick --help

--display defaults to the primary display. --rect is relative to the top-left
corner of that display, in the units `screenpick displays` prints.

Exit codes: 0 success, 1 the capture failed, 2 the command line is wrong.
";

#[derive(Debug, PartialEq)]
pub(crate) enum Invocation {
    Launch,
    // The mode id, already checked against `capture_modes`.
    Trigger(String),
    Headless(HeadlessCapture),
    Displays,
    Help,
    Version,
    UsageError(String),
}

#[derive(Debug, PartialEq)]
pub(crate) struct HeadlessCapture {
    pub(crate) target: HeadlessTarget,
    // 1-based, as `screenpick displays` numbers them. None is the primary display.
    pub(crate) display: Option<usize>,
    pub(crate) output: PathBuf,
}

#[derive(Debug, PartialEq)]
pub(crate) enum HeadlessTarget {
    Screen,
    Region {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
}

/// Parse the arguments after the program name.
///
/// An unknown flag in first position starts the app, as every argument did
/// before the command line existed: the login entry passes `--hidden`, and an
/// OS launcher may add flags of its own. An unknown word is an error, because a
/// mistyped command that silently opens the window looks like a capture that
/// did nothing.
pub(crate) fn parse<I: IntoIterator<Item = String>>(args: I) -> Invocation {
    let mut args = args.into_iter();
    let Some(first) = args.next() else {
        return Invocation::Launch;
    };
    match first.as_str() {
        "capture" => parse_capture(args),
        "displays" => match args.next() {
            None => Invocation::Displays,
            Some(extra) => usage_error(format!("`displays` takes no argument, got `{extra}`")),
        },
        "help" | "--help" | "-h" => Invocation::Help,
        "--version" | "-V" => Invocation::Version,
        flag if flag.starts_with('-') => Invocation::Launch,
        other => usage_error(format!("unknown command `{other}`")),
    }
}

fn usage_error(message: String) -> Invocation {
    Invocation::UsageError(message)
}

fn parse_capture<I: Iterator<Item = String>>(mut args: I) -> Invocation {
    let known_modes = || {
        capture_modes()
            .iter()
            .map(|mode| mode.id.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let Some(mode) = args.next() else {
        return usage_error(format!("`capture` needs a mode: {}", known_modes()));
    };
    if !capture_modes().iter().any(|known| known.id == mode) {
        return usage_error(format!(
            "unknown capture mode `{mode}`; the modes are {}",
            known_modes()
        ));
    }

    let mut output: Option<PathBuf> = None;
    let mut rect: Option<[u32; 4]> = None;
    let mut display: Option<usize> = None;
    while let Some(arg) = args.next() {
        // Accept `--name value` and `--name=value`.
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => {
                (name.to_string(), Some(value.to_string()))
            }
            _ => (arg, None),
        };
        if !matches!(name.as_str(), "--output" | "-o" | "--rect" | "--display") {
            return usage_error(format!("unknown option `{name}`"));
        }
        let Some(value) = inline.or_else(|| args.next()) else {
            return usage_error(format!("`{name}` needs a value"));
        };
        match name.as_str() {
            "--output" | "-o" => output = Some(PathBuf::from(value)),
            "--rect" => match parse_rect(&value) {
                Ok(parsed) => rect = Some(parsed),
                Err(message) => return usage_error(message),
            },
            _ => match value.parse::<usize>() {
                Ok(number) if number >= 1 => display = Some(number),
                _ => {
                    return usage_error(format!(
                        "`--display` takes a display number from 1, got `{value}`"
                    ))
                }
            },
        }
    }

    let Some(output) = output else {
        if rect.is_some() || display.is_some() {
            return usage_error(
                "`--rect` and `--display` only apply together with `--output`".to_string(),
            );
        }
        return Invocation::Trigger(mode);
    };
    let is_png = output
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"));
    if !is_png {
        return usage_error("`--output` must name a .png file".to_string());
    }
    let target =
        match (mode.as_str(), rect) {
            ("screen", None) => HeadlessTarget::Screen,
            ("screen", Some(_)) => return usage_error(
                "`--rect` belongs to `capture region`; `capture screen` takes the whole display"
                    .to_string(),
            ),
            ("region", Some([x, y, width, height])) => HeadlessTarget::Region {
                x,
                y,
                width,
                height,
            },
            ("region", None) => {
                return usage_error(
                    "`capture region --output` needs `--rect <x,y,width,height>`".to_string(),
                )
            }
            _ => {
                return usage_error(format!(
                    "`--output` works with the modes screen and region, not `{mode}`"
                ))
            }
        };
    Invocation::Headless(HeadlessCapture {
        target,
        display,
        output,
    })
}

fn parse_rect(value: &str) -> Result<[u32; 4], String> {
    let malformed = || format!("`--rect` takes x,y,width,height as whole numbers, got `{value}`");
    let numbers = value
        .split(',')
        .map(|part| part.trim().parse::<u32>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| malformed())?;
    let rect: [u32; 4] = numbers.try_into().map_err(|_| malformed())?;
    if rect[2] == 0 || rect[3] == 0 {
        return Err("`--rect` needs a width and a height above zero".to_string());
    }
    Ok(rect)
}

#[cfg(test)]
mod tests {
    use super::{parse, HeadlessCapture, HeadlessTarget, Invocation, USAGE};
    use crate::capture_modes::capture_modes;
    use std::path::PathBuf;

    fn run(args: &[&str]) -> Invocation {
        parse(args.iter().map(|arg| arg.to_string()))
    }

    fn is_usage_error(invocation: &Invocation) -> bool {
        matches!(invocation, Invocation::UsageError(_))
    }

    #[test]
    fn no_arguments_and_unknown_flags_start_the_app() {
        assert_eq!(run(&[]), Invocation::Launch);
        // The login entry's flag, and a flag nobody defined.
        assert_eq!(run(&["--hidden"]), Invocation::Launch);
        assert_eq!(run(&["--some-launcher-flag", "value"]), Invocation::Launch);
    }

    #[test]
    fn an_unknown_word_is_an_error_instead_of_a_launch() {
        assert!(is_usage_error(&run(&["captur", "region"])));
    }

    #[test]
    fn help_and_version() {
        for help in ["help", "--help", "-h"] {
            assert_eq!(run(&[help]), Invocation::Help);
        }
        for version in ["--version", "-V"] {
            assert_eq!(run(&[version]), Invocation::Version);
        }
    }

    #[test]
    fn the_help_text_names_every_capture_mode() {
        let listed = capture_modes()
            .iter()
            .map(|mode| mode.id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        assert!(USAGE.contains(&format!("Modes: {listed}.")), "{USAGE}");
    }

    #[test]
    fn displays_takes_no_argument() {
        assert_eq!(run(&["displays"]), Invocation::Displays);
        assert!(is_usage_error(&run(&["displays", "2"])));
    }

    #[test]
    fn capture_without_output_triggers_every_known_mode() {
        for mode in ["region", "window", "screen", "screen-pick"] {
            assert_eq!(
                run(&["capture", mode]),
                Invocation::Trigger(mode.to_string())
            );
        }
    }

    #[test]
    fn capture_rejects_a_missing_or_unknown_mode() {
        assert!(is_usage_error(&run(&["capture"])));
        assert!(is_usage_error(&run(&["capture", "video"])));
        // An option where the mode belongs is not a mode.
        assert!(is_usage_error(&run(&["capture", "--output", "a.png"])));
    }

    #[test]
    fn headless_screen_capture() {
        assert_eq!(
            run(&["capture", "screen", "--output", "shot.png"]),
            Invocation::Headless(HeadlessCapture {
                target: HeadlessTarget::Screen,
                display: None,
                output: PathBuf::from("shot.png"),
            })
        );
        assert_eq!(
            run(&["capture", "screen", "-o", "shot.PNG", "--display", "2"]),
            Invocation::Headless(HeadlessCapture {
                target: HeadlessTarget::Screen,
                display: Some(2),
                output: PathBuf::from("shot.PNG"),
            })
        );
    }

    #[test]
    fn headless_region_capture_in_both_option_spellings() {
        let expected = Invocation::Headless(HeadlessCapture {
            target: HeadlessTarget::Region {
                x: 10,
                y: 20,
                width: 300,
                height: 400,
            },
            display: Some(1),
            output: PathBuf::from("r.png"),
        });
        assert_eq!(
            run(&[
                "capture",
                "region",
                "--rect",
                "10,20,300,400",
                "--display",
                "1",
                "--output",
                "r.png"
            ]),
            expected
        );
        assert_eq!(
            run(&[
                "capture",
                "region",
                "--rect=10, 20, 300, 400",
                "--display=1",
                "--output=r.png"
            ]),
            expected
        );
    }

    #[test]
    fn an_equals_sign_inside_a_value_is_kept() {
        assert_eq!(
            run(&["capture", "screen", "--output", "a=b.png"]),
            Invocation::Headless(HeadlessCapture {
                target: HeadlessTarget::Screen,
                display: None,
                output: PathBuf::from("a=b.png"),
            })
        );
    }

    #[test]
    fn headless_capture_rejects_what_it_cannot_do() {
        for args in [
            // Not a PNG, and no extension at all.
            &["capture", "screen", "--output", "shot.jpg"][..],
            &["capture", "screen", "--output", "shot"],
            // Region without a rectangle, screen with one.
            &["capture", "region", "--output", "r.png"],
            &[
                "capture",
                "screen",
                "--rect",
                "0,0,10,10",
                "--output",
                "s.png",
            ],
            // Modes that need the picker or the foreground window.
            &["capture", "window", "--output", "w.png"],
            &["capture", "screen-pick", "--output", "w.png"],
            // Malformed values.
            &["capture", "region", "--rect", "0,0,10", "--output", "r.png"],
            &[
                "capture",
                "region",
                "--rect",
                "0,0,10,10,10",
                "--output",
                "r.png",
            ],
            &[
                "capture",
                "region",
                "--rect",
                "0,0,-5,10",
                "--output",
                "r.png",
            ],
            &[
                "capture", "region", "--rect", "0,0,0,10", "--output", "r.png",
            ],
            &[
                "capture", "region", "--rect", "0,0,10,0", "--output", "r.png",
            ],
            &["capture", "screen", "--display", "0", "--output", "s.png"],
            &["capture", "screen", "--display", "two", "--output", "s.png"],
            // A missing value and an unknown option.
            &["capture", "screen", "--output"],
            &["capture", "screen", "--copy"],
        ] {
            assert!(is_usage_error(&run(args)), "accepted: {args:?}");
        }
    }

    #[test]
    fn rect_and_display_without_output_are_an_error_not_a_trigger() {
        // Dropping them silently would open the picker when the caller asked
        // for a fixed rectangle.
        assert!(is_usage_error(&run(&[
            "capture",
            "region",
            "--rect",
            "0,0,10,10"
        ])));
        assert!(is_usage_error(&run(&[
            "capture",
            "screen",
            "--display",
            "2"
        ])));
    }
}
