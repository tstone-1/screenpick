// The settings + shortcut store: the stored `CaptureSettings` lifecycle (the
// loaded baseline, optimistic mutation, save, rollback), the shortcut editor
// (per-mode draft rows, per-row registration status, the serial focus/blur
// queue), the shortcut-registration status pipeline, and the OS autostart
// toggle.
//
// Split out of captureOrchestration.svelte.ts (W2 in the 2026-08 code review),
// mirroring how `EditorState` composes `DocumentStore`: `CaptureOrchestration`
// holds one `SettingsState` and exposes it as `capture.settingsStore`, and the
// module re-exports that instance as the `settingsStore` singleton for
// SettingsPanel.svelte and +page.svelte.
//
// THE SEAM: `captureModes` stays on `CaptureOrchestration` — it is Rust's mode
// registry and the key of the capture dispatch table — and reaches the shortcut
// editor through the `modes` accessor passed to the constructor. The editor
// needs the list to seed a mode's default rows and to spot a chord bound twice
// across modes, but it is not the list's owner and must not mutate it.
// Everything the settings lifecycle mutates (settings / appliedSettings /
// settingsLoaded / drafts) and everything the registration pipeline produces
// (registrations, per-key status, the effective accelerator map, the summary
// line, the log) lives here together, because every save re-registers the
// shortcuts (#saveAndApplySettings ends in refreshShortcutStatuses) — splitting
// the writing half from the reading half across two objects is what made the
// original class hard to follow. Capture-side code reads `registrations` and
// `effectiveAccelerators` from here for the in-app fallback path, and
// `settings` for autoOpenEditor / playCaptureSound / copyToClipboard.
import {
  commands,
  type CaptureMode,
  type CaptureSettings,
  type ShortcutStatus
} from "./bindings";
import { pickDirectory } from "./editorCommands";
import { statusLine } from "./statusLine.svelte";
import { acceleratorKey } from "./shortcutRecording";

const defaultSettings: CaptureSettings = {
  saveDirectory: null,
  copyToClipboard: false,
  playCaptureSound: false,
  autoOpenEditor: true,
  bringToFrontOnHotkeyCapture: false,
  closeToTray: false,
  checkForUpdatesOnStartup: true,
  shortcutOverrides: {}
};

// Platform check for both halves of the app: the shortcut editor renders macOS
// chords as glyphs and matches accelerators per platform, and the capture side
// gates the Screen Recording (TCC) banner on it. `navigator.platform` cannot
// change at runtime, so this is computed once at module load.
export const isMacPlatform =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

// Mirror of the backend's `sanitize_settings`: trim entries, drop blank ones,
// and drop a mode whose entries were *all* blank. An entry that survives as an
// empty array is kept — that is a deliberately disabled mode, not an absent
// override. Deliberately a second implementation rather than an IPC call: the
// dirty check runs on every blur of a shortcut field, and a round trip per
// keystroke would be worse than the duplication. `shortcutSanitizeFixture.json`
// is the pin — one corpus, read by this module's vitest suite and by
// `settings.rs`'s, so drift fails on whichever side drifted.
export function sanitizeShortcutOverrides(
  overrides: Record<string, string[]>
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [mode, accelerators] of Object.entries(overrides)) {
    if (accelerators.length === 0) {
      result[mode] = [];
      continue;
    }
    const sanitized = accelerators.map((a) => a.trim()).filter((a) => a.length > 0);
    if (sanitized.length > 0) result[mode] = sanitized;
  }
  return result;
}

export class SettingsState {
  settings = $state<CaptureSettings>({ ...defaultSettings });
  appliedSettings = $state<CaptureSettings>({ ...defaultSettings });
  // True once `get_settings` has answered. `update_settings` replaces the whole
  // stored struct, so saving from `defaultSettings` — a toggle in the window
  // between startup and that first answer, or any toggle after a failed one —
  // would write `saveDirectory: null` and empty overrides over what the user
  // configured. Rust cannot tell that apart from a deliberate reset, so the
  // frontend refuses to save a baseline it never loaded (see #saveAndApplySettings).
  settingsLoaded = $state(false);
  shortcutEditorDrafts = $state<Record<string, string[]>>({});
  autostartEnabled = $state(false);
  registrations = $state<ShortcutStatus[]>([]);
  shortcutStatusByKey = $state<Record<string, ShortcutStatus>>({});
  effectiveAccelerators = $state<Record<string, string[]>>({});
  shortcutStatus = $state("Shortcuts loading");
  shortcutLog = $state<string[]>([]);

  // Read-only view of the capture-mode registry owned by CaptureOrchestration
  // — see the seam comment above.
  #modes: () => CaptureMode[];
  #shortcutQueue: Promise<void> = Promise.resolve();

  constructor(modes: () => CaptureMode[] = () => []) {
    this.#modes = modes;
  }

  get isMac(): boolean {
    return isMacPlatform;
  }

  statusKey(status: ShortcutStatus): string {
    return `${status.accelerator}:${status.mode}`;
  }

  formatShortcut(accelerator: string | null): string {
    if (!accelerator) return "Unavailable";
    return accelerator
      .split("+")
      .map((part) => {
        switch (part) {
          case "CommandOrControl":
          case "Command":
            return isMacPlatform ? "⌘" : "Ctrl";
          case "Control":
            return isMacPlatform ? "⌃" : "Ctrl";
          case "Shift":
            return isMacPlatform ? "⇧" : "Shift";
          case "Alt":
          case "Option":
            return isMacPlatform ? "⌥" : "Alt";
          default:
            return part;
        }
      })
      // macOS writes chords as unseparated modifier glyphs. Spelling them out
      // and then joining with nothing produced "CmdShiftOption4"; the defaults
      // there carry three modifiers, so the glyphs are both idiomatic and the
      // only rendering that fits the panel. UI-only — never console output.
      .join(isMacPlatform ? "" : "+");
  }

  // Turn the raw plugin error (e.g. the Rust debug dump
  // "HotKey already registered: HotKey { mods: ..., key: ... }") into a short,
  // actionable line. The OS exposes no API to name the owning process, so the
  // best we can say is the combo is taken system-wide. The verbatim error stays
  // available via the element's title/tooltip.
  friendlyShortcutError(error: string | null | undefined): string {
    if (!error) return "Unknown error";
    if (/already registered/i.test(error)) {
      return "Already in use by another app — pick a different combo.";
    }
    return error;
  }

  getModeDefaultAccelerators(modeId: string): string[] {
    const mode = this.#modes().find((m) => m.id === modeId);
    return mode?.accelerators ?? [];
  }

  getModeAccelerators(modeId: string): string[] {
    return this.shortcutEditorDrafts[modeId] ?? this.getModeDefaultAccelerators(modeId);
  }

  // Release the global shortcuts while a shortcut field has focus. The OS
  // consumes a registered global shortcut before the webview sees it, even when
  // ScreenPick is the focused app — so without this, the recorder silently
  // ignores any chord ScreenPick already owns, which is exactly the chord a
  // user re-entering or moving a binding will press.
  async beginShortcutRecording() {
    await this.#enqueueShortcutTask(async () => {
      const result = await commands.suspendShortcuts();
      if (result.status === "error") statusLine.set(result.error);
    });
  }

  // Blur is the commit point: a recorded chord is saved and registered here, so
  // the user can test it immediately instead of hunting for an Apply button.
  // Saving re-registers everything from the stored settings, which subsumes the
  // resume — so resume only runs when there is nothing to save.
  async endShortcutRecording() {
    await this.#enqueueShortcutTask(async () => {
      if (this.#shortcutOverridesDirty()) {
        await this.#saveAndApplySettings(this.settings, this.appliedSettings);
        return;
      }
      const result = await commands.resumeShortcuts();
      if (result.status === "error") statusLine.set(result.error);
      await this.refreshShortcutStatuses();
    });
  }

  // A blank row is a placeholder for the chord about to be recorded into it, so
  // it is deliberately not committed here — the backend drops blank entries, and
  // saving now would delete the row out from under the user before they typed.
  addShortcutEntry(modeId: string) {
    const current = this.getModeAccelerators(modeId);
    this.#updateModeAccelerators(modeId, [...current, ""]);
  }

  setShortcutEntry(modeId: string, index: number, value: string) {
    const current = [...this.getModeAccelerators(modeId)];
    current[index] = value;
    this.#updateModeAccelerators(modeId, current);
  }

  // Committed directly rather than on blur: the click that removes a row also
  // blurs the field, and that blur runs *before* this handler — so it sees the
  // pre-removal draft and would leave the deletion unsaved.
  async removeShortcutEntry(modeId: string, index: number) {
    const current = this.getModeAccelerators(modeId);
    this.#updateModeAccelerators(
      modeId,
      current.filter((_, i) => i !== index)
    );
    await this.#enqueueShortcutTask(async () => {
      if (this.#shortcutOverridesDirty()) {
        await this.#saveAndApplySettings(this.settings, this.appliedSettings);
      }
    });
  }

  // Per-row state for the shortcut editor:
  // - "empty"      blank placeholder row, nothing to report
  // - "duplicate"  the same physical chord is bound elsewhere in this editor;
  //                caught here because only the first registration succeeds and
  //                the loser's failure names no owner
  // - "registered" live, OS-wide
  // - "failed"     the OS refused it (another app holds it)
  // - "pending"    edited but not yet committed, or status not loaded yet
  shortcutRowState(
    modeId: string,
    accelerator: string
  ): "empty" | "duplicate" | "registered" | "failed" | "pending" {
    if (!accelerator.trim()) return "empty";
    if (this.#duplicateAcceleratorKeys().has(acceleratorKey(accelerator, isMacPlatform) ?? "")) {
      return "duplicate";
    }
    const status = this.shortcutStatusByKey[`${accelerator}:${modeId}`];
    if (!status) return "pending";
    return status.state === "registered" ? "registered" : "failed";
  }

  shortcutRowError(modeId: string, accelerator: string): string | null {
    return this.shortcutStatusByKey[`${accelerator}:${modeId}`]?.error ?? null;
  }

  // Keys bound more than once across the whole editor (drafts, falling back to
  // each mode's defaults). Both sides of a collision are reported, because
  // neither is more "correct" than the other.
  #duplicateAcceleratorKeys(): Set<string> {
    const counts = new Map<string, number>();
    for (const mode of this.#modes()) {
      for (const accelerator of this.getModeAccelerators(mode.id)) {
        const key = acceleratorKey(accelerator, isMacPlatform);
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([key]) => key));
  }

  async pickSaveDirectory() {
    const dir = await pickDirectory("Choose save folder for captures");
    if (!dir) return;
    const previous = this.appliedSettings;
    const next = { ...this.settings, saveDirectory: dir };
    this.settings = next;
    await this.#saveAndApplySettings(next, previous);
  }

  async toggleSetting(
    key:
      | "copyToClipboard"
      | "playCaptureSound"
      | "autoOpenEditor"
      | "bringToFrontOnHotkeyCapture"
      | "closeToTray"
      | "checkForUpdatesOnStartup"
  ) {
    const previous = this.appliedSettings;
    const next = { ...this.settings, [key]: !this.settings[key] };
    this.settings = next;
    await this.#saveAndApplySettings(next, previous);
  }

  async toggleAutostart() {
    const previous = this.autostartEnabled;
    try {
      const result = await commands.setAutostart(!previous);
      if (result.status === "error") {
        this.autostartEnabled = previous;
        statusLine.set(result.error || "Failed to update login startup.");
        return;
      }
      this.autostartEnabled = result.data;
    } catch (error) {
      this.autostartEnabled = previous;
      statusLine.set(error instanceof Error ? error.message : "Failed to update login startup.");
    }
  }

  async resetShortcuts() {
    try {
      const result = await commands.resetShortcutSettings();
      if (result.status === "error") {
        statusLine.set(result.error || "Failed to reset shortcuts.");
        return;
      }
      this.settings = result.data;
      this.appliedSettings = result.data;
      // The backend answered with the stored struct, so we have a real baseline
      // even if the initial get_settings never did.
      this.settingsLoaded = true;
      this.shortcutEditorDrafts = { ...(this.settings.shortcutOverrides ?? {}) };
      await this.refreshShortcutStatuses();
    } catch (error) {
      statusLine.set(error instanceof Error ? error.message : "Reset failed.");
    }
  }

  async refreshShortcutStatuses() {
    const statuses = await commands.shortcutStatus();
    this.effectiveAccelerators = await commands.effectiveShortcutAccelerators();
    this.#setShortcutStatuses(statuses);
    this.shortcutLog = statuses.slice(-4).map((entry) => this.#formatStatusEntry(entry));
  }

  // Startup baseline from `get_settings`. Adopting it is what opens the save
  // gate above — nothing else in this class may set `settingsLoaded` from a
  // value the backend did not hand back.
  adoptStoredSettings(loaded: CaptureSettings) {
    this.settings = loaded;
    this.appliedSettings = loaded;
    this.shortcutEditorDrafts = { ...(loaded.shortcutOverrides ?? {}) };
    this.settingsLoaded = true;
  }

  // Startup snapshot: `shortcut_status` reports everything registered so far,
  // so the log is replaced wholesale rather than appended to.
  loadStatusSnapshot(statuses: ShortcutStatus[], effective: Record<string, string[]>) {
    this.shortcutLog = statuses.map((entry) => this.#formatStatusEntry(entry));
    this.effectiveAccelerators = effective;
    this.#setShortcutStatuses(statuses);
  }

  // One `shortcut_registration` event: replace that accelerator/mode's entry
  // and append its line to the (last four) log.
  applyRegistrationEvent(payload: ShortcutStatus) {
    const nextStatuses = [
      ...this.registrations.filter((entry) => this.statusKey(entry) !== this.statusKey(payload)),
      payload
    ];
    this.#setShortcutStatuses(nextStatuses);
    this.shortcutLog = [...this.shortcutLog.slice(-3), this.#formatStatusEntry(payload)];
  }

  #updateModeAccelerators(modeId: string, accelerators: string[]) {
    this.shortcutEditorDrafts = { ...this.shortcutEditorDrafts, [modeId]: accelerators };
    this.settings = {
      ...this.settings,
      shortcutOverrides: { ...this.shortcutEditorDrafts }
    };
  }

  // Focus/blur arrive as separate async handlers, and moving between two
  // shortcut fields fires the old field's blur before the new field's focus.
  // Run them strictly in call order so the blur's re-register can never land
  // *after* the next field's suspend — which would leave the global shortcuts
  // armed while recording, and the OS would eat the next chord typed.
  #enqueueShortcutTask<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#shortcutQueue.then(task, task);
    this.#shortcutQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  #overridesEqual(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((key, i) => key !== bKeys[i])) return false;
    return aKeys.every((key) => {
      const left = a[key] ?? [];
      const right = b[key] ?? [];
      return left.length === right.length && left.every((value, i) => value === right[i]);
    });
  }

  // Compared in sanitized form so a blank placeholder row — which the backend
  // never stores — does not read as an unsaved change and force a pointless
  // save-and-re-register on every blur.
  #shortcutOverridesDirty(): boolean {
    return !this.#overridesEqual(
      sanitizeShortcutOverrides(this.settings.shortcutOverrides ?? {}),
      this.appliedSettings.shortcutOverrides ?? {}
    );
  }

  // Adopt what the backend stored, but keep a draft row the user is still
  // filling in: the backend drops blank entries, so a straight overwrite would
  // make a just-added row vanish the moment an unrelated save ran.
  #reconcileDrafts(saved: Record<string, string[]>): Record<string, string[]> {
    const next: Record<string, string[]> = { ...saved };
    for (const [mode, draft] of Object.entries(this.shortcutEditorDrafts)) {
      const sanitized = sanitizeShortcutOverrides({ [mode]: draft })[mode];
      const savedEntry = saved[mode];
      if (savedEntry && sanitized && this.#overridesEqual({ x: sanitized }, { x: savedEntry })) {
        next[mode] = draft;
      }
    }
    return next;
  }

  #restoreSettings(snapshot: CaptureSettings) {
    this.settings = snapshot;
    this.shortcutEditorDrafts = { ...(snapshot.shortcutOverrides ?? {}) };
  }

  async #saveAndApplySettings(
    nextSettings: CaptureSettings = this.settings,
    rollbackSettings: CaptureSettings = this.appliedSettings
  ): Promise<CaptureSettings | null> {
    // One gate for every mutation path (toggles, save folder, shortcut edits),
    // because they all end here and they all send the whole struct.
    if (!this.settingsLoaded) {
      // Same rollback as a rejected save: callers flip their field optimistically
      // and the switch must not sit in a position nothing stored.
      this.#restoreSettings(rollbackSettings);
      statusLine.set("Settings are still loading — try that again in a moment.");
      return null;
    }
    try {
      const result = await commands.updateSettings(nextSettings);
      if (result.status === "error") {
        this.#restoreSettings(rollbackSettings);
        statusLine.set(result.error || "Failed to save settings.");
        return null;
      }
      this.settings = result.data;
      this.appliedSettings = result.data;
      this.shortcutEditorDrafts = this.#reconcileDrafts(result.data.shortcutOverrides ?? {});
      await this.refreshShortcutStatuses();
      return result.data;
    } catch (error) {
      this.#restoreSettings(rollbackSettings);
      statusLine.set(error instanceof Error ? error.message : "Settings save failed.");
      return null;
    }
  }

  #setShortcutStatuses(statuses: ShortcutStatus[]) {
    this.shortcutStatusByKey = Object.fromEntries(
      statuses.map((entry) => [this.statusKey(entry), entry])
    );
    this.registrations = statuses;
    this.#applyStatusSummary(statuses);
  }

  #formatStatusEntry(entry: ShortcutStatus): string {
    const label = this.formatShortcut(entry.accelerator);
    return entry.state === "registered"
      ? `registered: ${label}`
      : `failed: ${label}${entry.error ? ` (${entry.error})` : ""}`;
  }

  #applyStatusSummary(statuses: ShortcutStatus[] = this.registrations) {
    const successByMode = new Map<string, boolean>();
    for (const entry of statuses) {
      if (entry.state === "registered") {
        successByMode.set(entry.mode, true);
      } else if (!successByMode.has(entry.mode)) {
        successByMode.set(entry.mode, false);
      }
    }
    const failing = [...successByMode.entries()]
      .filter(([, ok]) => !ok)
      .map(([mode]) => mode);
    if (failing.length > 0) {
      this.shortcutStatus = `Some shortcuts unavailable: ${failing.join(", ")}`;
    } else if (successByMode.size > 0) {
      this.shortcutStatus = "Shortcuts ready";
    }
  }
}
