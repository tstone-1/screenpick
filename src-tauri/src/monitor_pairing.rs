#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CapMonitorInfo {
    pub(crate) id: u32,
    pub(crate) name: String,
    pub(crate) x: i32,
    pub(crate) y: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TauriMonInfo {
    pub(crate) name: Option<String>,
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

/// A paired overlay target: `(monitor id, (x, y) position, (width, height) size)`.
pub(crate) type MonitorTarget = (u32, (i32, i32), (u32, u32));

fn has_duplicate_names(monitors: &[CapMonitorInfo]) -> bool {
    let mut names: Vec<&str> = monitors.iter().map(|m| m.name.as_str()).collect();
    names.sort_unstable();
    names.windows(2).any(|w| w[0] == w[1])
}

pub(crate) fn pair_monitor_targets(
    cap_monitors: &[CapMonitorInfo],
    tauri_monitors: &[TauriMonInfo],
) -> Result<Vec<MonitorTarget>, String> {
    if cap_monitors.is_empty() || tauri_monitors.is_empty() {
        return Err("No displays available for capture.".to_string());
    }

    let can_use_names = !has_duplicate_names(cap_monitors)
        && cap_monitors.len() == tauri_monitors.len()
        && tauri_monitors.iter().all(|t| t.name.is_some());

    if can_use_names {
        if let Ok(targets) = pair_by_names(cap_monitors, tauri_monitors) {
            return Ok(targets);
        }
    }

    pair_by_position(cap_monitors, tauri_monitors)
}

fn pair_by_names(
    cap_monitors: &[CapMonitorInfo],
    tauri_monitors: &[TauriMonInfo],
) -> Result<Vec<MonitorTarget>, String> {
    let mut targets = Vec::with_capacity(tauri_monitors.len());
    let mut used = vec![false; cap_monitors.len()];

    for tauri in tauri_monitors {
        let tauri_name = tauri.name.as_deref().unwrap_or("");
        let mut found = None;
        for (i, cap) in cap_monitors.iter().enumerate() {
            if !used[i] && cap.name == tauri_name {
                if found.is_some() {
                    return Err("ambiguous name match".into());
                }
                found = Some((i, cap.id));
            }
        }
        match found {
            Some((i, id)) => {
                used[i] = true;
                targets.push((id, (tauri.x, tauri.y), (tauri.width, tauri.height)));
            }
            None => {
                return Err("name not found".into());
            }
        }
    }

    Ok(targets)
}

fn pair_by_position(
    cap_monitors: &[CapMonitorInfo],
    tauri_monitors: &[TauriMonInfo],
) -> Result<Vec<MonitorTarget>, String> {
    if cap_monitors.len() != tauri_monitors.len() {
        return Err(format!(
            "Monitor count mismatch: {} capturable vs {} display(s).",
            cap_monitors.len(),
            tauri_monitors.len()
        ));
    }

    let mut caps = cap_monitors.to_vec();
    caps.sort_by(|a, b| a.y.cmp(&b.y).then(a.x.cmp(&b.x)).then(a.id.cmp(&b.id)));

    let mut tauris = tauri_monitors.to_vec();
    tauris.sort_by(|a, b| a.y.cmp(&b.y).then(a.x.cmp(&b.x)));

    Ok(caps
        .into_iter()
        .zip(tauris)
        .map(|(cap, tauri)| (cap.id, (tauri.x, tauri.y), (tauri.width, tauri.height)))
        .collect())
}

/// Pure cursor→display hit-test. `displays` is `(id, x, y, width, height)` in a
/// single coordinate space (winit physical pixels, as the Screen overlay
/// targets are). Returns the id of the display whose half-open bounds contain
/// `(cursor_x, cursor_y)` — left/top inclusive, right/bottom exclusive, so two
/// adjacent displays never both claim a point on their shared seam. `None` if
/// the cursor is outside every display (the caller falls back to primary).
pub(crate) fn monitor_at_point(
    cursor: (f64, f64),
    displays: &[(u32, i32, i32, u32, u32)],
) -> Option<u32> {
    let (cx, cy) = cursor;
    displays.iter().find_map(|&(id, x, y, w, h)| {
        let x0 = x as f64;
        let y0 = y as f64;
        let x1 = x0 + w as f64;
        let y1 = y0 + h as f64;
        (cx >= x0 && cx < x1 && cy >= y0 && cy < y1).then_some(id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(id: u32, name: &str, x: i32, y: i32) -> CapMonitorInfo {
        CapMonitorInfo {
            id,
            name: name.to_string(),
            x,
            y,
        }
    }

    fn tauri(name: &str, x: i32, y: i32, w: u32, h: u32) -> TauriMonInfo {
        TauriMonInfo {
            name: Some(name.to_string()),
            x,
            y,
            width: w,
            height: h,
        }
    }

    fn tauri_no_name(x: i32, y: i32, w: u32, h: u32) -> TauriMonInfo {
        TauriMonInfo {
            name: None,
            x,
            y,
            width: w,
            height: h,
        }
    }

    #[test]
    fn exact_name_matching_two_displays() {
        let caps = vec![cap(1, "Display A", 0, 0), cap(2, "Display B", 1920, 0)];
        let tauris = vec![
            tauri("Display A", 0, 0, 1920, 1080),
            tauri("Display B", 1920, 0, 1024, 768),
        ];
        let result = pair_monitor_targets(&caps, &tauris).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0, 1);
        assert_eq!(result[1].0, 2);
    }

    #[test]
    fn duplicate_cap_names_falls_back_to_position() {
        let caps = vec![cap(10, "DELL X100", 0, 0), cap(20, "DELL X100", 1920, 0)];
        let tauris = vec![
            tauri("DELL X100", 0, 0, 1920, 1080),
            tauri("DELL X100", 1920, 0, 1920, 1080),
        ];
        let result = pair_monitor_targets(&caps, &tauris).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0, 10);
        assert_eq!(result[1].0, 20);
    }

    #[test]
    fn changed_ordering_uses_position_fallback() {
        let caps = vec![cap(1, "A", 1920, 0), cap(2, "B", 0, 0)];
        let tauris = vec![tauri("X", 0, 0, 1920, 1080), tauri("Y", 1920, 0, 1024, 768)];
        let result = pair_monitor_targets(&caps, &tauris).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0, 2);
        assert_eq!(result[1].0, 1);
    }

    #[test]
    fn position_fallback_with_negative_origins() {
        let caps = vec![
            cap(1, "A", -1920, 0),
            cap(2, "B", 0, 0),
            cap(3, "C", 1920, 0),
        ];
        let tauris = vec![
            tauri("X", -1920, 0, 1920, 1080),
            tauri("Y", 0, 0, 1920, 1080),
            tauri("Z", 1920, 0, 1920, 1080),
        ];
        let result = pair_monitor_targets(&caps, &tauris).unwrap();
        assert_eq!(result[0].0, 1);
        assert_eq!(result[1].0, 2);
        assert_eq!(result[2].0, 3);
    }

    #[test]
    fn position_fallback_with_mixed_y_ordering() {
        let caps = vec![cap(1, "A", 0, 1080), cap(2, "B", 0, 0)];
        let tauris = vec![
            tauri("X", 0, 0, 1920, 1080),
            tauri("Y", 0, 1080, 1920, 1080),
        ];
        let result = pair_monitor_targets(&caps, &tauris).unwrap();
        assert_eq!(result[0].0, 2);
        assert_eq!(result[1].0, 1);
    }

    #[test]
    fn count_mismatch_returns_error() {
        let caps = vec![cap(1, "A", 0, 0), cap(2, "B", 1920, 0)];
        let tauris = vec![tauri("A", 0, 0, 1920, 1080)];
        let err = pair_monitor_targets(&caps, &tauris).unwrap_err();
        assert!(err.contains("count mismatch"));
    }

    #[test]
    fn empty_inputs_return_error() {
        let caps: Vec<CapMonitorInfo> = vec![];
        let tauris = vec![tauri("A", 0, 0, 1920, 1080)];
        let err = pair_monitor_targets(&caps, &tauris).unwrap_err();
        assert!(err.contains("No displays"));

        let caps = vec![cap(1, "A", 0, 0)];
        let tauris: Vec<TauriMonInfo> = vec![];
        let err = pair_monitor_targets(&caps, &tauris).unwrap_err();
        assert!(err.contains("No displays"));
    }

    #[test]
    fn tauri_without_names_falls_back_to_position() {
        let caps = vec![cap(1, "A", 0, 0), cap(2, "B", 1920, 0)];
        let tauris = vec![
            tauri_no_name(0, 0, 1920, 1080),
            tauri_no_name(1920, 0, 1024, 768),
        ];
        let result = pair_monitor_targets(&caps, &tauris).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0, 1);
        assert_eq!(result[1].0, 2);
    }

    #[test]
    fn mixed_scale_does_not_affect_pairing() {
        let caps = vec![cap(1, "Retina", 0, 0), cap(2, "Standard", 1920, 0)];
        let tauris = vec![
            tauri("Retina", 0, 0, 3840, 2160),
            tauri("Standard", 1920, 0, 1920, 1080),
        ];
        let result = pair_monitor_targets(&caps, &tauris).unwrap();
        assert_eq!(result[0].0, 1);
        assert_eq!(result[1].0, 2);
    }

    #[test]
    fn duplicate_names_with_same_positions_still_falls_back() {
        let caps = vec![
            cap(1, "LG", 0, 0),
            cap(2, "LG", 1920, 0),
            cap(3, "Samsung", 3840, 0),
        ];
        let tauris = vec![
            tauri("LG", 0, 0, 1920, 1080),
            tauri("LG", 1920, 0, 1920, 1080),
            tauri("Samsung", 3840, 0, 1920, 1080),
        ];
        let result = pair_monitor_targets(&caps, &tauris).unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].0, 1);
        assert_eq!(result[1].0, 2);
        assert_eq!(result[2].0, 3);
    }

    #[test]
    fn single_monitor_pairs_trivially() {
        let caps = vec![cap(42, "Solo", 0, 0)];
        let tauris = vec![tauri("Solo", 0, 0, 2560, 1440)];
        let result = pair_monitor_targets(&caps, &tauris).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, 42);
    }

    #[test]
    fn monitor_at_point_picks_display_containing_cursor() {
        // Two side-by-side 1920-wide displays sharing the x=1920 seam.
        let displays = vec![(1, 0, 0, 1920, 1080), (2, 1920, 0, 1920, 1080)];

        // Clearly inside the second display.
        assert_eq!(monitor_at_point((2000.0, 500.0), &displays), Some(2));
        // Just left of the seam belongs to display 1 (right edge exclusive).
        assert_eq!(monitor_at_point((1919.9, 500.0), &displays), Some(1));
        // The seam itself belongs to display 2 (left edge inclusive).
        assert_eq!(monitor_at_point((1920.0, 500.0), &displays), Some(2));
        // Below both displays: no hit, so the caller falls back to primary.
        assert_eq!(monitor_at_point((500.0, 2000.0), &displays), None);
        // Negative-origin display (secondary left of primary) still matches.
        let with_negative = vec![(7, -1920, 0, 1920, 1080), (8, 0, 0, 1920, 1080)];
        assert_eq!(monitor_at_point((-10.0, 50.0), &with_negative), Some(7));
    }

    #[test]
    fn has_duplicate_names_detects_duplicates() {
        let caps = vec![cap(1, "A", 0, 0), cap(2, "B", 0, 0), cap(3, "A", 0, 0)];
        assert!(has_duplicate_names(&caps));

        let unique = vec![cap(1, "A", 0, 0), cap(2, "B", 0, 0)];
        assert!(!has_duplicate_names(&unique));
    }
}
