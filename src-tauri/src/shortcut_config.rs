use std::collections::HashMap;

use crate::capture_modes::capture_modes;

#[derive(Clone, Debug)]
pub(crate) struct EffectiveShortcut {
    pub(crate) mode: String,
    pub(crate) accelerator: String,
}

pub(crate) fn effective_accelerators(
    shortcut_overrides: Option<&HashMap<String, Vec<String>>>,
) -> Vec<EffectiveShortcut> {
    let mut result = Vec::new();
    for mode in capture_modes() {
        if let Some(overrides) = shortcut_overrides.and_then(|s| s.get(&mode.id)) {
            for accel in overrides.iter() {
                let accelerator = accel.trim();
                if accelerator.is_empty() {
                    continue;
                }
                result.push(EffectiveShortcut {
                    mode: mode.id.clone(),
                    accelerator: accelerator.to_string(),
                });
            }
        } else {
            for accel in &mode.accelerators {
                result.push(EffectiveShortcut {
                    mode: mode.id.clone(),
                    accelerator: accel.clone(),
                });
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::effective_accelerators;
    use std::collections::HashMap;

    #[test]
    fn uses_defaults_when_no_settings() {
        let result = effective_accelerators(None);
        let region = result.iter().find(|s| s.mode == "region").unwrap();
        assert_eq!(region.accelerator, "CommandOrControl+Shift+4");
    }

    #[test]
    fn uses_defaults_when_no_overrides() {
        let overrides = HashMap::new();
        let result = effective_accelerators(Some(&overrides));
        let window = result.iter().find(|s| s.mode == "window").unwrap();
        assert_eq!(window.accelerator, "CommandOrControl+Shift+W");
    }

    #[test]
    fn replaces_with_override() {
        let mut overrides = HashMap::new();
        overrides.insert("region".to_string(), vec!["CmdOrCtrl+Shift+X".to_string()]);
        let result = effective_accelerators(Some(&overrides));
        let region = result.iter().find(|s| s.mode == "region").unwrap();
        assert_eq!(region.accelerator, "CmdOrCtrl+Shift+X");
        assert!(!result
            .iter()
            .any(|s| s.accelerator == "CommandOrControl+Shift+4"));
    }

    #[test]
    fn supports_multiple_override_accelerators() {
        let mut overrides = HashMap::new();
        overrides.insert(
            "screen".to_string(),
            vec!["CmdOrCtrl+1".to_string(), "CmdOrCtrl+2".to_string()],
        );
        let result = effective_accelerators(Some(&overrides));
        let screen_accels: Vec<&str> = result
            .iter()
            .filter(|s| s.mode == "screen")
            .map(|s| s.accelerator.as_str())
            .collect();
        assert_eq!(screen_accels, vec!["CmdOrCtrl+1", "CmdOrCtrl+2"]);
    }

    #[test]
    fn empty_override_disables_mode() {
        let mut overrides = HashMap::new();
        overrides.insert("region".to_string(), vec![]);
        let result = effective_accelerators(Some(&overrides));
        let region_default = "CommandOrControl+Shift+4";
        assert!(!result
            .iter()
            .any(|s| s.mode == "region" && s.accelerator == region_default));
        assert!(result.iter().all(|s| s.mode != "region"));
    }

    #[test]
    fn blank_override_entries_are_ignored() {
        let mut overrides = HashMap::new();
        overrides.insert(
            "region".to_string(),
            vec![
                "".to_string(),
                "  ".to_string(),
                " CommandOrControl+Shift+X ".to_string(),
            ],
        );
        let result = effective_accelerators(Some(&overrides));
        let region_accels: Vec<&str> = result
            .iter()
            .filter(|s| s.mode == "region")
            .map(|s| s.accelerator.as_str())
            .collect();
        assert_eq!(region_accels, vec!["CommandOrControl+Shift+X"]);
    }
}
