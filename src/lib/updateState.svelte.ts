import { commands, events } from "./bindings";
import { logError, logWarn } from "./diagnosticsLog";
import { checkForUpdates, relaunch, type PendingUpdate } from "./updaterCommands";

// Where the release lives when the in-app path fails. Shown as the escape hatch
// on every error state: a user whose install location isn't writable (running
// from the DMG, or an /Applications owned by another account) can never be
// rescued by retrying the same download.
export const RELEASES_URL = "https://github.com/tstone-1/screenpick/releases/latest";

// A background check that fails is not worth a banner — the user didn't ask,
// and GitHub being briefly unreachable is not their problem. A check they
// explicitly clicked is the opposite: silence would read as a broken button.
export type CheckOrigin = "startup" | "manual";

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; version: string; notes: string | null }
  | { kind: "downloading"; version: string; downloaded: number; total: number | null }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

// Delay before the automatic startup check. Long enough that a launch-time
// capture (the app is often started *for* a capture) never contends with it,
// short enough that the user is still in the app when the banner appears.
export const STARTUP_CHECK_DELAY_MS = 10_000;

export class UpdateState {
  phase = $state<UpdatePhase>({ kind: "idle" });
  // Dismissal is per-sighting, not persisted: an update the user waved away
  // should come back on the next launch, or it will never be installed.
  dismissed = $state(false);

  // The running build's version, and whether this launch is the first after an
  // update. Both come from the Rust `update_transition` command so the "a first
  // run is not an update" rule lives in exactly one place (src-tauri/src/updates.rs).
  currentVersion = $state<string | null>(null);
  justUpdated = $state(false);

  #pending: PendingUpdate | null = null;
  #startupTimer: ReturnType<typeof setTimeout> | null = null;

  showBanner = $derived(
    !this.dismissed &&
      (this.phase.kind === "available" ||
        this.phase.kind === "downloading" ||
        this.phase.kind === "installing" ||
        this.phase.kind === "error")
  );

  // True while a check or install is in flight, so the settings button can
  // disable itself rather than stacking concurrent checks.
  busy = $derived(
    this.phase.kind === "checking" ||
      this.phase.kind === "downloading" ||
      this.phase.kind === "installing"
  );

  // Best-effort: the version line in settings simply stays blank if this fails,
  // which is not worth surfacing as an error.
  async loadTransition(): Promise<void> {
    try {
      const transition = await commands.updateTransition();
      this.currentVersion = transition.currentVersion;
      this.justUpdated = transition.updated;
    } catch (error) {
      logWarn("Could not read the update transition", error);
    }
  }

  // Subscribes to the tray's "Check for Updates..." item. Treated as a manual
  // check — the user asked, so a failure has to be visible. Returns a teardown;
  // the listener attaches asynchronously, so it also has to survive being torn
  // down before it is ready.
  listenForTrayChecks(): () => void {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void events.updateCheckRequested
      .listen(() => {
        void this.check("manual");
      })
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
      })
      .catch((error: unknown) => {
        logWarn("Could not listen for tray update checks", error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }

  // Schedules the automatic startup check. Returns a teardown that cancels a
  // check not yet fired, so a page teardown can't leave a timer running against
  // a torn-down state object.
  //
  // `isEnabled` is a callback, not a boolean, and is evaluated when the timer
  // fires rather than when it is scheduled: settings load asynchronously, so at
  // schedule time the opt-out is still sitting at its default `true` and a
  // snapshot would check for updates for users who had turned that off.
  scheduleStartupCheck(isEnabled: () => boolean): () => void {
    this.#startupTimer = setTimeout(() => {
      this.#startupTimer = null;
      if (!isEnabled()) return;
      void this.check("startup");
    }, STARTUP_CHECK_DELAY_MS);
    return () => {
      if (this.#startupTimer !== null) {
        clearTimeout(this.#startupTimer);
        this.#startupTimer = null;
      }
    };
  }

  async check(origin: CheckOrigin): Promise<void> {
    // A second check while one is running would race two downloads onto the
    // same install path for no benefit.
    if (this.busy) return;

    this.phase = { kind: "checking" };
    try {
      const update = await checkForUpdates();
      this.#pending = update;
      if (!update) {
        this.phase = { kind: "upToDate" };
        return;
      }
      this.dismissed = false;
      this.phase = { kind: "available", version: update.version, notes: update.notes };
    } catch (error) {
      this.#pending = null;
      if (origin === "startup") {
        // Silent by design: an unreachable endpoint at launch is noise, not a
        // problem the user can act on. It still reaches the on-disk log.
        logWarn("Background update check failed", error);
        this.phase = { kind: "idle" };
        return;
      }
      logError("Update check failed", error);
      this.phase = {
        kind: "error",
        message: "Couldn't check for updates. Check your connection and try again."
      };
    }
  }

  // Downloads and installs the pending update, then restarts. Windows never
  // reaches the relaunch — the NSIS installer terminates the app first.
  async installAndRestart(): Promise<void> {
    const update = this.#pending;
    if (!update || this.busy) return;

    this.phase = { kind: "downloading", version: update.version, downloaded: 0, total: null };
    try {
      await update.download((downloaded, total) => {
        this.phase = { kind: "downloading", version: update.version, downloaded, total };
      });
      this.phase = { kind: "installing", version: update.version };
      await relaunch();
    } catch (error) {
      logError("Update install failed", error);
      this.phase = {
        kind: "error",
        message: `Couldn't install ${update.version}. Download it manually instead.`
      };
    }
  }

  dismiss(): void {
    this.dismissed = true;
  }

  // Clears a terminal message without dismissing a genuinely pending update, so
  // the settings panel's "up to date"/error line doesn't linger forever.
  reset(): void {
    if (this.phase.kind === "upToDate" || this.phase.kind === "error") {
      this.phase = { kind: "idle" };
    }
  }
}

export const update = new UpdateState();
