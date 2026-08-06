import {
  commands,
  events,
  type CaptureMode,
  type CaptureResult,
  type CaptureSettings,
  type ShortcutStatus
} from "./bindings";
import type { Result } from "./commandResult";
import { pickDirectory } from "./editorCommands";
import { editor } from "./editor.svelte";
import { playCaptureSound } from "./captureSound";
import { logError } from "./diagnosticsLog";
import { acceleratorKey, acceleratorMatches } from "./shortcutRecording";

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

// "shortcut" = a registered global shortcut (ScreenPick is in the background, so
// the foreground window is the user's). "fallback" = the in-app keydown handler
// used when a global shortcut failed to register, which only fires while
// ScreenPick is focused — so it must not treat ScreenPick as the "active window".
type CaptureSource = "button" | "shortcut" | "fallback";

// Backstop for a wedged capture: a start_* command can resolve Ok while its
// overlay is still being built on a spawned Rust task. If that task dies before
// emitting a terminal event, capturePending would stay true forever and disable
// all capture. This recovers the UI after a generous delay — long enough never
// to interrupt a normal interactive selection.
const CAPTURE_WATCHDOG_MS = 60_000;

// The capture modes this build knows how to drive. `CaptureMode.id` crosses the
// specta boundary as a plain `string`, so the typed-IPC contract cannot check
// that the frontend handles every mode Rust lists — this union and the table
// below are the frontend's own check. Adding a mode to `capture_modes.rs`
// without adding it here now fails at the table (a missing `Record` key is a
// compile error) instead of shipping a button that silently does nothing.
type KnownCaptureModeId = "region" | "window" | "screen" | "screen-pick";

// A start either hands the interaction to an overlay — the shot arrives later
// as a `CaptureCompleted` event, so the pending flag stays up — or captures
// immediately and resolves with the result. Which of the two a mode does is the
// table's business; the caller must not re-derive it from the mode id.
type CaptureStart =
  | { kind: "pending"; result: Result<null, string> }
  | { kind: "completed"; result: Result<CaptureResult, string> };

// Everything the two dispatch sites need, per mode, in one place: the status
// line, the start command (including the shortcut-vs-button split where the two
// differ), and the cancel command. The start/cancel mapping used to exist twice
// — `requestCapture` and `#cancelPendingCapture` each held their own if/else —
// which left the watchdog's cancel able to fall a mode behind the start path,
// with nothing to fail until a wedged session's overlays needed cleaning up.
type CaptureModeDispatch = {
  // Set before the command is awaited, so the status line describes the
  // interaction that is on screen rather than the request that started it.
  activity: (source: CaptureSource) => string;
  start: (source: CaptureSource) => Promise<CaptureStart>;
  cancel: () => Promise<Result<null, string>>;
};

const captureDispatch: Record<KnownCaptureModeId, CaptureModeDispatch> = {
  region: {
    activity: () => "Region selection active.",
    start: async () => ({ kind: "pending", result: await commands.startRegionSelection() }),
    cancel: () => commands.cancelRegionSelection()
  },
  window: {
    // From a global shortcut, capture the active (foreground) window directly
    // — like the OS Alt+PrintScreen. The in-app button keeps the click-to-pick
    // overlay, since ScreenPick itself is the foreground window when clicked.
    activity: (source) =>
      source === "shortcut" ? "Capturing active window." : "Window selection active.",
    start: async (source) =>
      source === "shortcut"
        ? { kind: "completed", result: await commands.captureActiveWindow() }
        : { kind: "pending", result: await commands.startWindowSelection() },
    cancel: () => commands.cancelWindowSelection()
  },
  screen: {
    // From a global shortcut, capture the display under the cursor directly
    // — no picker, so nothing steals focus and a context menu (or other
    // transient UI) open at that moment survives and is captured. The in-app
    // button keeps the picker: ScreenPick is the foreground window when it's
    // clicked, so there's no background menu to preserve and choosing a
    // display visually is the more useful behavior.
    activity: (source) =>
      source === "shortcut" ? "Capturing screen under cursor." : "Screen selection active.",
    start: async (source) => ({
      kind: "pending",
      result:
        source === "shortcut"
          ? await commands.captureScreenUnderCursor()
          : await commands.startScreenSelection()
    }),
    cancel: () => commands.cancelScreenSelection()
  },
  "screen-pick": {
    // Dedicated "choose a display" path (its own hotkey + in-app fallback):
    // always opens the picker overlays.
    activity: () => "Screen selection active.",
    start: async () => ({ kind: "pending", result: await commands.startScreenSelection() }),
    cancel: () => commands.cancelScreenSelection()
  }
};

function isKnownCaptureModeId(modeId: string): modeId is KnownCaptureModeId {
  return Object.hasOwn(captureDispatch, modeId);
}

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

export class CaptureOrchestration {
  captureModes = $state<CaptureMode[]>([]);
  registrations = $state<ShortcutStatus[]>([]);
  activeCapture = $state("region");
  status = $state("Starting");
  captureActivity = $state("Choose a capture mode or press a shortcut.");
  shortcutStatus = $state("Shortcuts loading");
  capturePending = $state(false);
  shortcutLog = $state<string[]>([]);
  shortcutStatusByKey = $state<Record<string, ShortcutStatus>>({});
  effectiveAccelerators = $state<Record<string, string[]>>({});
  dismissedConflicts = $state(false);
  // macOS Screen Recording (TCC) permission state, polled from the backend
  // (`screen_recording_access`, which never prompts). Default granted so the
  // banner never flashes before the first check resolves and so it stays hidden
  // on Windows, where there is no such gate. `screenRecordingNoticeDismissed`
  // lets the user hide the banner for now; a subsequent capture that still fails
  // on permission re-surfaces it (see #reassertScreenRecordingAfterFailure).
  screenRecordingGranted = $state(true);
  screenRecordingNoticeDismissed = $state(false);
  showScreenRecordingNotice = $derived(
    this.isMac && !this.screenRecordingGranted && !this.screenRecordingNoticeDismissed
  );
  settingsPanelOpen = $state(false);
  autostartEnabled = $state(false);
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
  failedShortcuts = $derived(
    this.dismissedConflicts
      ? []
      : Object.values(this.shortcutStatusByKey).filter((s) => s.state === "failed")
  );

  // Source of the in-flight capture, so completion handling can tell a hotkey
  // capture (which may finish with ScreenPick in the background) from a button.
  #pendingSource: CaptureSource | null = null;

  #unlistenCapture: (() => void) | null = null;
  #unlistenRegistration: (() => void) | null = null;
  #captureWatchdog: ReturnType<typeof setTimeout> | null = null;
  #pendingMode: string | null = null;
  #cancelled = false;
  #shortcutQueue: Promise<void> = Promise.resolve();
  #isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  get isMac(): boolean {
    return this.#isMac;
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
            return this.#isMac ? "⌘" : "Ctrl";
          case "Control":
            return this.#isMac ? "⌃" : "Ctrl";
          case "Shift":
            return this.#isMac ? "⇧" : "Shift";
          case "Alt":
          case "Option":
            return this.#isMac ? "⌥" : "Alt";
          default:
            return part;
        }
      })
      // macOS writes chords as unseparated modifier glyphs. Spelling them out
      // and then joining with nothing produced "CmdShiftOption4"; the defaults
      // there carry three modifiers, so the glyphs are both idiomatic and the
      // only rendering that fits the panel. UI-only — never console output.
      .join(this.#isMac ? "" : "+");
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

  setActivity(message: string) {
    this.captureActivity = message;
  }

  toggleSettingsPanel() {
    this.settingsPanelOpen = !this.settingsPanelOpen;
  }

  dismissShortcutConflicts() {
    this.dismissedConflicts = true;
  }

  dismissScreenRecordingNotice() {
    this.screenRecordingNoticeDismissed = true;
  }

  // Poll the (non-prompting) backend permission state and update the banner
  // flag. On grant, clear the dismissed flag so the banner is fully reset for a
  // future revocation. Best-effort: a failed query leaves the last known state.
  // Returns the resolved grant state so callers can branch on it.
  async refreshScreenRecordingAccess(): Promise<boolean> {
    if (!this.#isMac) return true;
    try {
      const granted = await commands.screenRecordingAccess();
      this.screenRecordingGranted = granted;
      if (granted) this.screenRecordingNoticeDismissed = false;
      return granted;
    } catch {
      return this.screenRecordingGranted;
    }
  }

  // Open the macOS Screen Recording settings pane. The backend deep-links via
  // the `x-apple.systempreferences` URL scheme (the webview can't open external
  // URLs itself — no opener plugin is registered).
  async openScreenRecordingSettings() {
    try {
      const result = await commands.openScreenRecordingSettings();
      if (result.status === "error") {
        this.captureActivity = result.error || "Could not open System Settings.";
      }
    } catch (error) {
      this.captureActivity =
        error instanceof Error ? error.message : "Could not open System Settings.";
    }
  }

  // Called after any capture failure: re-query permission and, if it's actually
  // missing, force the banner back into view even if the user had dismissed it.
  // This is the fix for "dismiss the notice, press the shortcut again, nothing
  // happens" — the denied state now re-announces itself on every failed attempt.
  // Non-permission failures leave `screenRecordingGranted` true, so the banner
  // stays hidden and this is a no-op beyond the cheap re-query.
  async #reassertScreenRecordingAfterFailure() {
    if (!this.#isMac) return;
    const granted = await this.refreshScreenRecordingAccess();
    if (!granted) this.screenRecordingNoticeDismissed = false;
  }

  activeAccelerator(mode: CaptureMode): string | null {
    const registered = this.registrations.find(
      (entry) => entry.mode === mode.id && entry.state === "registered"
    );
    if (registered) return registered.accelerator;
    return this.registrations.length === 0 ? (mode.accelerators[0] ?? null) : null;
  }

  getModeDefaultAccelerators(modeId: string): string[] {
    const mode = this.captureModes.find((m) => m.id === modeId);
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
      if (result.status === "error") this.captureActivity = result.error;
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
      if (result.status === "error") this.captureActivity = result.error;
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
    if (this.#duplicateAcceleratorKeys().has(acceleratorKey(accelerator, this.#isMac) ?? "")) {
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
    for (const mode of this.captureModes) {
      for (const accelerator of this.getModeAccelerators(mode.id)) {
        const key = acceleratorKey(accelerator, this.#isMac);
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

  async quitApp() {
    // quit_app calls app.exit(0), so this invoke never resolves on success —
    // the catch only fires if the IPC transport fails before the process dies.
    try {
      await commands.quitApp();
    } catch (error) {
      this.captureActivity = error instanceof Error ? error.message : "Failed to quit.";
    }
  }

  async toggleAutostart() {
    const previous = this.autostartEnabled;
    try {
      const result = await commands.setAutostart(!previous);
      if (result.status === "error") {
        this.autostartEnabled = previous;
        this.captureActivity = result.error || "Failed to update login startup.";
        return;
      }
      this.autostartEnabled = result.data;
    } catch (error) {
      this.autostartEnabled = previous;
      this.captureActivity = error instanceof Error ? error.message : "Failed to update login startup.";
    }
  }

  async resetShortcuts() {
    try {
      const result = await commands.resetShortcutSettings();
      if (result.status === "error") {
        this.captureActivity = result.error || "Failed to reset shortcuts.";
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
      this.captureActivity = error instanceof Error ? error.message : "Reset failed.";
    }
  }

  async refreshShortcutStatuses() {
    const statuses = await commands.shortcutStatus();
    this.effectiveAccelerators = await commands.effectiveShortcutAccelerators();
    this.#setShortcutStatuses(statuses);
    this.shortcutLog = statuses.slice(-4).map((entry) => this.#formatStatusEntry(entry));
  }

  // Set capturePending and (re)arm or clear the wedge-recovery watchdog in
  // lockstep, so every path that flips the flag keeps the backstop consistent.
  #setCapturePending(pending: boolean) {
    this.capturePending = pending;
    // Clearing on every "not pending" transition covers all capture endings —
    // completion, cancel, error, and the catch path — in one place.
    if (!pending) this.#pendingSource = null;
    if (!pending) this.#pendingMode = null;
    if (this.#captureWatchdog !== null) {
      clearTimeout(this.#captureWatchdog);
      this.#captureWatchdog = null;
    }
    if (pending && typeof setTimeout !== "undefined") {
      this.#captureWatchdog = setTimeout(() => {
        this.#captureWatchdog = null;
        void this.#cancelPendingCapture();
      }, CAPTURE_WATCHDOG_MS);
    }
  }

  async requestCapture(modeId: string, source: CaptureSource) {
    if (this.capturePending) return;
    const mode = this.captureModes.find((entry) => entry.id === modeId);
    this.#pendingSource = source;
    this.#pendingMode = modeId;
    this.activeCapture = modeId;
    this.#setCapturePending(true);
    this.captureActivity = `${mode?.label ?? "Capture"} capture requested from ${source}.`;

    if (!isKnownCaptureModeId(modeId)) {
      // Rust owns the mode list and `captureDispatch` owns the wiring; a mode in
      // one and not the other is a build-time wiring mistake that used to reach
      // the user as a control that did nothing at all — no command, no error, no
      // log line. Say so where a bug report can find it.
      logError(`No capture dispatch for mode "${modeId}"; the mode list and the table disagree.`);
      this.captureActivity = `Capture mode "${modeId}" is not available in this build.`;
      this.#setCapturePending(false);
      return;
    }
    const dispatch = captureDispatch[modeId];

    try {
      this.captureActivity = dispatch.activity(source);
      const started = await dispatch.start(source);
      if (started.kind === "completed") {
        if (started.result.status === "error") {
          this.#failCapture(started.result.error);
          return;
        }
        this.#ingestCompletedCapture(started.result.data);
        return;
      }
      if (started.result.status === "error") {
        this.#failCapture(started.result.error);
      }
    } catch (error) {
      this.#failCapture(error instanceof Error ? error.message : null);
    }
  }

  // Every failed start ends the same way: report it, drop the pending flag so
  // the UI unblocks, and re-query the macOS Screen Recording grant — a revoked
  // grant is the most common cause and the banner has to come back even after
  // the user dismissed it.
  #failCapture(message: string | null) {
    this.captureActivity = message || "Capture failed.";
    this.#setCapturePending(false);
    void this.#reassertScreenRecordingAfterFailure();
  }

  // Route a finished capture (from the completion event or a direct command like
  // capture_active_window) into the editor/recents, update status, clear the
  // pending flag, and honor the copy-to-clipboard setting.
  #ingestCompletedCapture(payload: CaptureResult) {
    const capture = this.settings.autoOpenEditor
      ? editor.ingestCompleted(payload)
      : editor.ingestWithoutOpening(payload);
    this.captureActivity = `${capture.title} captured at ${capture.width} x ${capture.height}.`;
    // Audible confirmation for hotkey captures, where ScreenPick may be in the
    // background and there's no on-screen feedback. Button captures already open
    // the editor in front of the user, so they don't chime.
    const viaHotkey = this.#pendingSource === "shortcut" || this.#pendingSource === "fallback";
    if (viaHotkey && this.settings.playCaptureSound) {
      playCaptureSound();
    }
    // #setCapturePending(false) clears #pendingSource for us.
    this.#setCapturePending(false);
    if (this.settings.copyToClipboard) {
      void commands.copyImageToClipboard(capture.path).then((result) => {
        if (result.status === "error") {
          this.captureActivity = `${capture.title} saved but copy to clipboard failed.`;
        }
      });
    }
  }

  handleFallbackShortcut(event: KeyboardEvent): boolean {
    for (const mode of this.captureModes) {
      for (const accelerator of this.#effectiveAcceleratorsForMode(mode)) {
        if (this.#isRegisteredAccelerator(accelerator, mode.id)) continue;
        if (acceleratorMatches(event, accelerator, this.#isMac)) {
          event.preventDefault();
          void this.requestCapture(mode.id, "fallback");
          return true;
        }
      }
    }
    return false;
  }

  setup(): () => void {
    this.#cancelled = false;
    void this.#start();
    void this.refreshScreenRecordingAccess();

    // Re-check permission whenever the window regains focus — the user typically
    // leaves to toggle the setting in System Settings and returns, and we want
    // the banner to clear (or the capture buttons to just work) the moment they
    // do, without a restart.
    const onFocus = () => void this.refreshScreenRecordingAccess();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
    }

    return () => {
      this.#cancelled = true;
      this.#unlistenCapture?.();
      this.#unlistenRegistration?.();
      this.#unlistenCapture = null;
      this.#unlistenRegistration = null;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
      }
      if (this.#captureWatchdog !== null) {
        clearTimeout(this.#captureWatchdog);
        this.#captureWatchdog = null;
      }
    };
  }

  async #start() {
    try {
      this.status = await commands.appStatus();
      if (this.#cancelled) return;
    } catch {
      if (!this.#cancelled) this.status = "offline";
    }

    try {
      const modes = await commands.listCaptureModes();
      if (this.#cancelled) return;
      this.captureModes = modes;
      if (modes[0] && !modes.some((mode) => mode.id === this.activeCapture)) {
        this.activeCapture = modes[0].id;
      }

      const existing = await commands.shortcutStatus();
      const effective = await commands.effectiveShortcutAccelerators();
      if (this.#cancelled) return;
      this.shortcutLog = existing.map((entry) => this.#formatStatusEntry(entry));
      this.effectiveAccelerators = effective;
      this.#setShortcutStatuses(existing);

      const loadedSettings = await commands.getSettings();
      if (!this.#cancelled) {
        this.settings = loadedSettings;
        this.appliedSettings = loadedSettings;
        this.shortcutEditorDrafts = { ...(loadedSettings.shortcutOverrides ?? {}) };
        this.settingsLoaded = true;
      }

      try {
        const autostart = await commands.autostartEnabled();
        if (this.#cancelled) return;
        if (autostart.status === "error") {
          this.captureActivity = autostart.error || "Could not read login startup state.";
        } else {
          this.autostartEnabled = autostart.data;
        }
      } catch (error) {
        if (!this.#cancelled) {
          this.captureActivity =
            error instanceof Error ? error.message : "Could not read login startup state.";
        }
      }

      const uCapture = await events.captureShortcut.listen((event) => {
        void this.requestCapture(event.payload, "shortcut");
      });
      const uRegistration = await events.shortcutRegistration.listen((event) => {
        const nextStatuses = [
          ...this.registrations.filter((entry) => this.statusKey(entry) !== this.statusKey(event.payload)),
          event.payload
        ];
        this.#setShortcutStatuses(nextStatuses);
        this.shortcutLog = [...this.shortcutLog.slice(-3), this.#formatStatusEntry(event.payload)];
      });
      const uCaptureCompleted = await events.captureCompleted.listen((event) => {
        this.#ingestCompletedCapture(event.payload);
      });
      const uCaptureCancelled = await events.captureCancelled.listen((event) => {
        this.captureActivity = event.payload;
        this.#setCapturePending(false);
      });

      if (this.#cancelled) {
        uCapture();
        uRegistration();
        uCaptureCompleted();
        uCaptureCancelled();
        return;
      }

      this.#unlistenCapture = uCapture;
      this.#unlistenRegistration = () => {
        uRegistration();
        uCaptureCompleted();
        uCaptureCancelled();
      };
    } catch (error) {
      if (!this.#cancelled) {
        this.shortcutStatus = "Shortcut listener failed";
        this.captureActivity =
          error instanceof Error ? error.message : "Unable to listen for shortcuts.";
      }
    }
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
      this.captureActivity = "Settings are still loading — try that again in a moment.";
      return null;
    }
    try {
      const result = await commands.updateSettings(nextSettings);
      if (result.status === "error") {
        this.#restoreSettings(rollbackSettings);
        this.captureActivity = result.error || "Failed to save settings.";
        return null;
      }
      this.settings = result.data;
      this.appliedSettings = result.data;
      this.shortcutEditorDrafts = this.#reconcileDrafts(result.data.shortcutOverrides ?? {});
      await this.refreshShortcutStatuses();
      return result.data;
    } catch (error) {
      this.#restoreSettings(rollbackSettings);
      this.captureActivity = error instanceof Error ? error.message : "Settings save failed.";
      return null;
    }
  }

  #setShortcutStatuses(statuses: ShortcutStatus[]) {
    this.shortcutStatusByKey = Object.fromEntries(statuses.map((entry) => [this.statusKey(entry), entry]));
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

  #effectiveAcceleratorsForMode(mode: CaptureMode): string[] {
    if (Object.hasOwn(this.effectiveAccelerators, mode.id)) {
      return this.effectiveAccelerators[mode.id] ?? [];
    }
    return mode.accelerators;
  }

  #isRegisteredAccelerator(accelerator: string, mode: string): boolean {
    return this.registrations.some(
      (entry) =>
        entry.mode === mode && entry.accelerator === accelerator && entry.state === "registered"
    );
  }

  async #cancelPendingCapture() {
    const mode = this.#pendingMode;
    try {
      // Same table `requestCapture` started from, so a mode can never be
      // startable and uncancellable — the failure a hand-maintained second
      // copy of the mapping would produce, silently, on the next mode added.
      if (mode !== null && isKnownCaptureModeId(mode)) {
        await captureDispatch[mode].cancel();
      }
    } catch {
      // The watchdog is a recovery path. A failed cancel still must unblock the
      // local UI; the Rust picker commands remain the source of truth for live
      // overlay cleanup.
    } finally {
      this.#setCapturePending(false);
    }
  }
}

export const capture = new CaptureOrchestration();
