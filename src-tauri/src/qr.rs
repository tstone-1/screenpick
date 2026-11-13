//! QR code decoding for the Scan QR capture mode and the editor's Read QR
//! action, and the rule for which decoded texts may be opened as links.
//!
//! Pure over an in-memory image, so it runs in the Windows unit-test build
//! (see the gating note in `lib.rs`). The commands that feed it a screen region
//! or a capture file live in `qr_scan.rs`.

use serde::{Deserialize, Serialize};
use specta::Type;
use xcap::image::{DynamicImage, GrayImage};

// One decoded QR code. `is_url` is decided here, once, so the button the
// frontend shows and the check `open_qr_url` makes cannot disagree.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QrCode {
    pub(crate) text: String,
    pub(crate) is_url: bool,
}

// Decode every QR code in `image`, in detection order, without duplicates.
//
// rqrr only finds dark-on-light finder patterns, so a light-on-dark code (a
// dark-mode web page) is invisible to it as captured. When the first pass
// finds nothing, the inverted image gets a second pass.
pub(crate) fn decode_qr_codes(image: &DynamicImage) -> Vec<QrCode> {
    let mut luma = image.to_luma8();
    let mut texts = decode_luma(&luma);
    if texts.is_empty() {
        xcap::image::imageops::invert(&mut luma);
        texts = decode_luma(&luma);
    }
    texts
        .into_iter()
        .map(|text| QrCode {
            is_url: is_web_url(&text),
            text,
        })
        .collect()
}

fn decode_luma(luma: &GrayImage) -> Vec<String> {
    let (width, height) = luma.dimensions();
    if width == 0 || height == 0 {
        return Vec::new();
    }
    let mut prepared =
        rqrr::PreparedImage::prepare_from_greyscale(width as usize, height as usize, |x, y| {
            luma.get_pixel(x as u32, y as u32)[0]
        });
    let mut texts: Vec<String> = Vec::new();
    for grid in prepared.detect_grids() {
        match grid.decode() {
            Ok((_, text)) => {
                if !texts.contains(&text) {
                    texts.push(text);
                }
            }
            // A finder-pattern triple that is not a readable code (a damaged
            // code, or three squares that only look like one) is normal in a
            // screen region; the other grids still count.
            Err(err) => log::debug!("skipped an undecodable QR grid: {err}"),
        }
    }
    texts
}

// Whether a decoded text may be handed to the browser. Only absolute http(s)
// URLs with no whitespace or control characters qualify: the text came off
// the screen, so anything else (a `file:` path, a custom scheme, a string
// with a newline in it) stays text the user can copy.
pub(crate) fn is_web_url(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix("https://") {
        rest
    } else if let Some(rest) = lower.strip_prefix("http://") {
        rest
    } else {
        return false;
    };
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    host_end > 0
        && !text
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '"')
}

#[cfg(test)]
mod tests {
    use super::*;
    use xcap::image::{imageops, Luma, Rgba, RgbaImage};

    // Render `text` as a QR code: `module` pixels per module, a four-module
    // quiet zone, dark on light unless `inverted`.
    fn qr_image(text: &str, module: u32, inverted: bool) -> DynamicImage {
        let code = qrcode::QrCode::new(text.as_bytes()).expect("encodable test text");
        let modules = code.width() as u32;
        let colors = code.to_colors();
        let quiet = 4;
        let side = (modules + 2 * quiet) * module;
        let (dark, light) = if inverted { (235, 20) } else { (20, 235) };
        let image = GrayImage::from_fn(side, side, |x, y| {
            let (mx, my) = (x / module, y / module);
            let inside = mx >= quiet && my >= quiet && mx < quiet + modules && my < quiet + modules;
            let is_dark = inside
                && colors[((my - quiet) * modules + (mx - quiet)) as usize] == qrcode::Color::Dark;
            Luma([if is_dark { dark } else { light }])
        });
        DynamicImage::ImageLuma8(image)
    }

    fn texts(image: &DynamicImage) -> Vec<String> {
        decode_qr_codes(image)
            .into_iter()
            .map(|code| code.text)
            .collect()
    }

    #[test]
    fn decodes_a_plain_code() {
        let image = qr_image("hello from screenpick", 4, false);
        assert_eq!(texts(&image), vec!["hello from screenpick".to_string()]);
    }

    #[test]
    fn marks_a_url_code_as_openable() {
        let image = qr_image("https://example.com/path?q=1", 4, false);
        assert_eq!(
            decode_qr_codes(&image),
            vec![QrCode {
                text: "https://example.com/path?q=1".to_string(),
                is_url: true
            }]
        );
    }

    #[test]
    fn decodes_a_light_on_dark_code_through_the_inverted_pass() {
        let inverted = qr_image("dark mode", 4, true);
        // Control: the first pass alone must miss it, or the second pass is
        // untested.
        assert!(decode_luma(&inverted.to_luma8()).is_empty());
        assert_eq!(texts(&inverted), vec!["dark mode".to_string()]);
    }

    #[test]
    fn decodes_a_code_on_a_larger_colored_background() {
        let code = qr_image("embedded", 3, false).to_rgba8();
        let mut canvas = RgbaImage::from_pixel(800, 500, Rgba([40, 90, 160, 255]));
        imageops::replace(&mut canvas, &code, 300, 120);
        assert_eq!(
            texts(&DynamicImage::ImageRgba8(canvas)),
            vec!["embedded".to_string()]
        );
    }

    #[test]
    fn decodes_a_code_resampled_by_display_scaling() {
        // A 125% / 150% display scales a page's QR code by a fractional factor,
        // so modules are not whole pixels and edges are blended.
        let source = qr_image("https://example.com/scaled", 4, false);
        for factor in [1.25_f32, 1.5, 0.75] {
            let side = (source.width() as f32 * factor).round() as u32;
            let scaled = source.resize_exact(side, side, imageops::FilterType::Triangle);
            assert_eq!(
                texts(&scaled),
                vec!["https://example.com/scaled".to_string()],
                "scale factor {factor}"
            );
        }
    }

    #[test]
    fn decodes_two_codes_in_one_region_once_each() {
        let left = qr_image("first", 3, false).to_rgba8();
        let right = qr_image("second", 3, false).to_rgba8();
        let mut canvas =
            RgbaImage::from_pixel(left.width() * 3, left.height() + 40, Rgba([255; 4]));
        imageops::replace(&mut canvas, &left, 0, 20);
        imageops::replace(&mut canvas, &right, i64::from(left.width() * 2), 20);
        let mut found = texts(&DynamicImage::ImageRgba8(canvas));
        found.sort();
        assert_eq!(found, vec!["first".to_string(), "second".to_string()]);
    }

    #[test]
    fn finds_nothing_in_an_image_without_a_code() {
        let blank = DynamicImage::ImageRgba8(RgbaImage::from_pixel(200, 120, Rgba([250; 4])));
        assert!(decode_qr_codes(&blank).is_empty());
        let empty = DynamicImage::ImageRgba8(RgbaImage::new(0, 0));
        assert!(decode_qr_codes(&empty).is_empty());
    }

    #[test]
    fn web_url_rule() {
        for url in [
            "https://example.com",
            "http://example.com/a?b=c#d",
            "HTTPS://Example.com/Path",
            "https://localhost:8080/",
        ] {
            assert!(is_web_url(url), "{url} should be openable");
        }
        for text in [
            "example.com",
            "https://",
            "https:///path",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "mailto:someone@example.com",
            "ms-settings:privacy",
            " https://example.com",
            "https://example.com/a b",
            "https://example.com/\nsecond line",
            "https://example.com/\"quoted",
            "WIFI:S:home;T:WPA;P:secret;;",
        ] {
            assert!(!is_web_url(text), "{text:?} must not be openable");
        }
    }
}
