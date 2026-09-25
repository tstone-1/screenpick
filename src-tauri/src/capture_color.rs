// WGC float surfaces contain linear scRGB. Windows scales SDR content by the
// display's SDR white level (1.0 = 80 nits); undo that BEFORE encoding sRGB.
// https://learn.microsoft.com/windows/win32/direct3darticles/high-dynamic-range

pub(crate) fn srgb_table(white_scale: f32) -> Result<Box<[u8; 65536]>, String> {
    if !white_scale.is_finite() || white_scale <= 0.0 {
        return Err("Invalid display SDR white level".into());
    }
    let mut table = Box::new([0; 65536]);
    for (bits, output) in table.iter_mut().enumerate() {
        let linear = (half::f16::from_bits(bits as u16).to_f32() / white_scale).clamp(0.0, 1.0);
        let encoded = if linear <= 0.003_130_8 {
            12.92 * linear
        } else {
            1.055 * linear.powf(1.0 / 2.4) - 0.055
        };
        *output = (encoded * 255.0).round() as u8;
    }
    Ok(table)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_sdr_channel_round_trips_at_multiple_display_white_levels() {
        for scale in [1.0, 1.5, 3.0, 6.0] {
            let table = srgb_table(scale).unwrap();
            for expected in 0..=255u8 {
                let s = f32::from(expected) / 255.0;
                let linear = if s <= 0.04045 {
                    s / 12.92
                } else {
                    ((s + 0.055) / 1.055).powf(2.4)
                };
                let captured = half::f16::from_f32(linear * scale).to_bits();
                assert_eq!(table[captured as usize], expected, "scale={scale}");
            }
        }
    }

    #[test]
    fn bounds_and_half_float_subnormals_are_safe() {
        let table = srgb_table(3.0).unwrap();
        for (linear, expected) in [(-1.0, 0), (0.0, 0), (3.0, 255), (12.0, 255)] {
            assert_eq!(
                table[half::f16::from_f32(linear).to_bits() as usize],
                expected
            );
        }
        assert_eq!(table[1], 0);
        assert_eq!(table[half::f16::NAN.to_bits() as usize], 0);
        assert_eq!(table[half::f16::INFINITY.to_bits() as usize], 255);
        for invalid in [0.0, -1.0, f32::NAN, f32::INFINITY] {
            assert!(srgb_table(invalid).is_err());
        }
    }
}
