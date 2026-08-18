// Capture dispatch and the capture session lifecycle: the mode table, the
// start/cancel wiring, the wedge-recovery watchdog, ingest of a finished shot,
// the in-app fallback hotkeys, and the macOS Screen Recording (TCC) banner.
//
// W2 in the 2026-08 code review: the settings lifecycle, the shortcut editor
// and the OS autostart toggle used to live here too. They are now
// settingsState.svelte.ts, composed as `settingsStore` below the way
// `EditorState` composes `DocumentStore` — see that file's seam comment for
// what divides the two and why the capture side keeps `captureModes`.
import {
  commands,
  events,
  type CaptureMode,
  type CaptureResult
} from "./bindings";
import type { Result } from "./commandResult";
import { editor } from "./editor.svelte";
import { playCaptureSound } from "./captureSound";
import { logError } from "./diagnosticsLog";
import { acceleratorMatches } from "./shortcutRecording";
import { isMacPlatform, SettingsState } from "./settingsState.svelte";
import { statusLine } from "./statusLine.svelte";

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

export class CaptureOrchestration {
  captureModes = $state<CaptureMode[]>([]);
  activeCapture = $state("region");
  status = $state("Starting");
  capturePending = $state(false);
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

  // The settings + shortcut store. Public so SettingsPanel.svelte and
  // +page.svelte can address it directly (they import the `settingsStore`
  // singleton exported at the foot of this file, which is this instance) — a
  // per-orchestrator instance rather than a module singleton so a test can
  // construct independent orchestrators, as the suite does.
  readonly settingsStore = new SettingsState(() => this.captureModes);

  failedShortcuts = $derived(
    this.dismissedConflicts
      ? []
      : Object.values(this.settingsStore.shortcutStatusByKey).filter((s) => s.state === "failed")
  );

  // Source of the in-flight capture, so completion handling can tell a hotkey
  // capture (which may finish with ScreenPick in the background) from a button.
  #pendingSource: CaptureSource | null = null;

  #unlistenCapture: (() => void) | null = null;
  #unlistenRegistration: (() => void) | null = null;
  #captureWatchdog: ReturnType<typeof setTimeout> | null = null;
  #pendingMode: string | null = null;
  #cancelled = false;

  get isMac(): boolean {
    return isMacPlatform;
  }

  // The capture module's own door onto the shared status line (statusLine.svelte.ts).
  setActivity(message: string) {
    statusLine.set(message);
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
    if (!this.isMac) return true;
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
        this.setActivity(result.error || "Could not open System Settings.");
      }
    } catch (error) {
      this.setActivity(error instanceof Error ? error.message : "Could not open System Settings.");
    }
  }

  // Called after any capture failure: re-query permission and, if it's actually
  // missing, force the banner back into view even if the user had dismissed it.
  // This is the fix for "dismiss the notice, press the shortcut again, nothing
  // happens" — the denied state now re-announces itself on every failed attempt.
  // Non-permission failures leave `screenRecordingGranted` true, so the banner
  // stays hidden and this is a no-op beyond the cheap re-query.
  async #reassertScreenRecordingAfterFailure() {
    if (!this.isMac) return;
    const granted = await this.refreshScreenRecordingAccess();
    if (!granted) this.screenRecordingNoticeDismissed = false;
  }

  activeAccelerator(mode: CaptureMode): string | null {
    const registrations = this.settingsStore.registrations;
    const registered = registrations.find(
      (entry) => entry.mode === mode.id && entry.state === "registered"
    );
    if (registered) return registered.accelerator;
    return registrations.length === 0 ? (mode.accelerators[0] ?? null) : null;
  }

  async quitApp() {
    // quit_app calls app.exit(0), so this invoke never resolves on success —
    // the catch only fires if the IPC transport fails before the process dies.
    try {
      await commands.quitApp();
    } catch (error) {
      this.setActivity(error instanceof Error ? error.message : "Failed to quit.");
    }
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
    this.setActivity(`${mode?.label ?? "Capture"} capture requested from ${source}.`);

    if (!isKnownCaptureModeId(modeId)) {
      // Rust owns the mode list and `captureDispatch` owns the wiring; a mode in
      // one and not the other is a build-time wiring mistake that used to reach
      // the user as a control that did nothing at all — no command, no error, no
      // log line. Say so where a bug report can find it.
      logError(`No capture dispatch for mode "${modeId}"; the mode list and the table disagree.`);
      this.setActivity(`Capture mode "${modeId}" is not available in this build.`);
      this.#setCapturePending(false);
      return;
    }
    const dispatch = captureDispatch[modeId];

    try {
      this.setActivity(dispatch.activity(source));
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
    this.setActivity(message || "Capture failed.");
    this.#setCapturePending(false);
    void this.#reassertScreenRecordingAfterFailure();
  }

  // Route a finished capture (from the completion event or a direct command like
  // capture_active_window) into the editor/recents, update status, clear the
  // pending flag, and honor the copy-to-clipboard setting.
  #ingestCompletedCapture(payload: CaptureResult) {
    const settings = this.settingsStore.settings;
    const capture = settings.autoOpenEditor
      ? editor.ingestCompleted(payload)
      : editor.ingestWithoutOpening(payload);
    this.setActivity(`${capture.title} captured at ${capture.width} x ${capture.height}.`);
    // Audible confirmation for hotkey captures, where ScreenPick may be in the
    // background and there's no on-screen feedback. Button captures already open
    // the editor in front of the user, so they don't chime.
    const viaHotkey = this.#pendingSource === "shortcut" || this.#pendingSource === "fallback";
    if (viaHotkey && settings.playCaptureSound) {
      playCaptureSound();
    }
    // #setCapturePending(false) clears #pendingSource for us.
    this.#setCapturePending(false);
    if (settings.copyToClipboard) {
      void commands.copyImageToClipboard(capture.path).then((result) => {
        if (result.status === "error") {
          this.setActivity(`${capture.title} saved but copy to clipboard failed.`);
        }
      });
    }
  }

  handleFallbackShortcut(event: KeyboardEvent): boolean {
    for (const mode of this.captureModes) {
      for (const accelerator of this.#effectiveAcceleratorsForMode(mode)) {
        if (this.#isRegisteredAccelerator(accelerator, mode.id)) continue;
        if (acceleratorMatches(event, accelerator, this.isMac)) {
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
      this.settingsStore.loadStatusSnapshot(existing, effective);

      const loadedSettings = await commands.getSettings();
      if (!this.#cancelled) {
        this.settingsStore.adoptStoredSettings(loadedSettings);
      }

      try {
        const autostart = await commands.autostartEnabled();
        if (this.#cancelled) return;
        if (autostart.status === "error") {
          this.setActivity(autostart.error || "Could not read login startup state.");
        } else {
          this.settingsStore.autostartEnabled = autostart.data;
        }
      } catch (error) {
        if (!this.#cancelled) {
          this.setActivity(
            error instanceof Error ? error.message : "Could not read login startup state."
          );
        }
      }

      const uCapture = await events.captureShortcut.listen((event) => {
        void this.requestCapture(event.payload, "shortcut");
      });
      const uRegistration = await events.shortcutRegistration.listen((event) => {
        this.settingsStore.applyRegistrationEvent(event.payload);
      });
      const uCaptureCompleted = await events.captureCompleted.listen((event) => {
        this.#ingestCompletedCapture(event.payload);
      });
      const uCaptureCancelled = await events.captureCancelled.listen((event) => {
        this.setActivity(event.payload);
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
        this.settingsStore.shortcutStatus = "Shortcut listener failed";
        this.setActivity(
          error instanceof Error ? error.message : "Unable to listen for shortcuts."
        );
      }
    }
  }

  #effectiveAcceleratorsForMode(mode: CaptureMode): string[] {
    const effective = this.settingsStore.effectiveAccelerators;
    if (Object.hasOwn(effective, mode.id)) {
      return effective[mode.id] ?? [];
    }
    return mode.accelerators;
  }

  #isRegisteredAccelerator(accelerator: string, mode: string): boolean {
    return this.settingsStore.registrations.some(
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

// The live settings/shortcut store — the one `capture` composes, re-exported so
// SettingsPanel.svelte and +page.svelte address it without reaching through the
// orchestrator. Constructed there (not as its own module singleton) so tests
// can build independent orchestrators; see settingsState.svelte.ts.
export const settingsStore = capture.settingsStore;
