import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateState, STARTUP_CHECK_DELAY_MS, type UpdatePhase } from "./updateState.svelte";
import type { PendingUpdate } from "./updaterCommands";

// The adapter is the seam: it owns every @tauri-apps import, so mocking it here
// is what lets the state machine be tested without a Tauri runtime.
vi.mock("./updaterCommands", () => ({
  checkForUpdates: vi.fn(),
  relaunch: vi.fn(),
  openReleasesPage: vi.fn()
}));

// Logging is fire-and-forget over IPC and would reject under jsdom.
vi.mock("./diagnosticsLog", () => ({
  logError: vi.fn(),
  logWarn: vi.fn()
}));

vi.mock("./bindings", () => ({
  commands: { updateTransition: vi.fn() },
  events: { updateCheckRequested: { listen: vi.fn() } }
}));

const { checkForUpdates, relaunch, openReleasesPage } = await import("./updaterCommands");
const { commands, events } = await import("./bindings");
const { logError, logWarn } = await import("./diagnosticsLog");

const checkMock = vi.mocked(checkForUpdates);
const relaunchMock = vi.mocked(relaunch);
const openReleasesMock = vi.mocked(openReleasesPage);
const transitionMock = vi.mocked(commands.updateTransition);
const listenMock = vi.mocked(events.updateCheckRequested.listen);

function pending(version = "26.8.0", overrides: Partial<PendingUpdate> = {}): PendingUpdate {
  return {
    version,
    notes: null,
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UpdateState.check", () => {
  it("reports up to date when no update is offered", async () => {
    checkMock.mockResolvedValue(null);
    const state = new UpdateState();

    await state.check("manual");

    expect(state.phase).toEqual({ kind: "upToDate" });
    expect(state.showBanner).toBe(false);
  });

  it("surfaces an available update and shows the banner", async () => {
    checkMock.mockResolvedValue(pending("26.8.0"));
    const state = new UpdateState();

    await state.check("manual");

    expect(state.phase).toEqual({ kind: "available", version: "26.8.0", notes: null });
    expect(state.showBanner).toBe(true);
  });

  it("stays silent when a background check fails", async () => {
    // An unreachable endpoint at launch is not something the user asked about
    // or can act on — surfacing it would be pure noise.
    checkMock.mockRejectedValue(new Error("offline"));
    const state = new UpdateState();

    await state.check("startup");

    expect(state.phase).toEqual({ kind: "idle" });
    expect(state.showBanner).toBe(false);
    expect(logWarn).toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("reports an error when a check the user asked for fails", async () => {
    checkMock.mockRejectedValue(new Error("offline"));
    const state = new UpdateState();

    await state.check("manual");

    expect(state.phase.kind).toBe("error");
    expect(state.showBanner).toBe(true);
    expect(logError).toHaveBeenCalled();
  });

  it("ignores a second check while one is in flight", async () => {
    let release: (value: null) => void = () => {};
    checkMock.mockReturnValue(
      new Promise<null>((resolve) => {
        release = resolve;
      })
    );
    const state = new UpdateState();

    const first = state.check("manual");
    await state.check("manual");
    expect(checkMock).toHaveBeenCalledTimes(1);

    release(null);
    await first;
  });

  it("clears a previous dismissal when a new update appears", async () => {
    checkMock.mockResolvedValue(pending("26.8.0"));
    const state = new UpdateState();
    state.dismiss();

    await state.check("manual");

    expect(state.dismissed).toBe(false);
    expect(state.showBanner).toBe(true);
  });
});

describe("UpdateState.installAndRestart", () => {
  it("reports download progress, then installing, then relaunches", async () => {
    const state = new UpdateState();
    const seen: UpdatePhase[] = [];
    const download = vi.fn<PendingUpdate["download"]>(async (onProgress) => {
      onProgress(0, 100);
      seen.push(state.phase);
      onProgress(40, 100);
      seen.push(state.phase);
    });
    // The installing state has to be up while the install runs: once this
    // promise resolves the install has already finished.
    const install = vi.fn<PendingUpdate["install"]>(async () => {
      seen.push(state.phase);
    });
    checkMock.mockResolvedValue(pending("26.8.0", { download, install }));
    await state.check("manual");

    await state.installAndRestart();

    expect(seen).toEqual([
      { kind: "downloading", version: "26.8.0", downloaded: 0, total: 100 },
      { kind: "downloading", version: "26.8.0", downloaded: 40, total: 100 },
      { kind: "installing", version: "26.8.0" }
    ]);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(state.phase).toEqual({ kind: "installing", version: "26.8.0" });
  });

  // On Windows the installer ends the process from inside `install`, past the
  // exit handshake, so this flush is the only thing that saves an annotation
  // drawn during the download. It has to finish before `install` starts.
  it("flushes pending work after the download and before the install", async () => {
    const order: string[] = [];
    let finishFlush = () => {};
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push("flush started");
          finishFlush = () => {
            order.push("flush finished");
            resolve();
          };
        })
    );
    const download = vi.fn<PendingUpdate["download"]>(async () => {
      order.push("download");
    });
    const install = vi.fn<PendingUpdate["install"]>(async () => {
      order.push("install");
    });
    checkMock.mockResolvedValue(pending("26.8.0", { download, install }));
    const state = new UpdateState();
    state.flushBeforeInstall(flush);
    await state.check("manual");

    const done = state.installAndRestart();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    // The flush is still running: the install must be waiting for it.
    expect(install).not.toHaveBeenCalled();
    finishFlush();
    await done;

    expect(order).toEqual(["download", "flush started", "flush finished", "install"]);
  });

  // Same rule as the exit handshake: losing the pending write is bad, an
  // update that can never be installed is worse.
  it("installs anyway when the flush fails, and logs it", async () => {
    const install = vi.fn<PendingUpdate["install"]>().mockResolvedValue(undefined);
    checkMock.mockResolvedValue(pending("26.8.0", { install }));
    const state = new UpdateState();
    state.flushBeforeInstall(() => Promise.reject(new Error("disk full")));
    await state.check("manual");

    await state.installAndRestart();

    expect(install).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "Could not flush pending work before installing the update",
      expect.any(Error)
    );
  });

  it("offers a manual download when the download fails", async () => {
    const download = vi.fn().mockRejectedValue(new Error("connection reset"));
    const install = vi.fn();
    checkMock.mockResolvedValue(pending("26.8.0", { download, install }));
    const state = new UpdateState();
    await state.check("manual");

    await state.installAndRestart();

    expect(state.phase.kind).toBe("error");
    expect(install).not.toHaveBeenCalled();
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("offers a manual download when the install fails", async () => {
    // The realistic macOS failure: the .app is somewhere unwritable, which no
    // amount of retrying the same download can fix.
    const install = vi.fn().mockRejectedValue(new Error("Permission denied"));
    checkMock.mockResolvedValue(pending("26.8.0", { install }));
    const state = new UpdateState();
    await state.check("manual");

    await state.installAndRestart();

    expect(state.phase.kind).toBe("error");
    expect(state.phase.kind === "error" && state.phase.message).toContain("26.8.0");
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("does nothing without a pending update", async () => {
    const state = new UpdateState();

    await state.installAndRestart();

    expect(relaunchMock).not.toHaveBeenCalled();
    expect(state.phase).toEqual({ kind: "idle" });
  });
});

describe("UpdateState.scheduleStartupCheck", () => {
  it("evaluates the opt-out when the timer fires, not when it is scheduled", async () => {
    // Settings load asynchronously, so at schedule time the flag is still at its
    // default. Reading it eagerly would check for updates for a user who had
    // turned that off — the bug this callback exists to prevent.
    vi.useFakeTimers();
    checkMock.mockResolvedValue(null);
    const state = new UpdateState();
    let enabled = true;

    state.scheduleStartupCheck(() => enabled);
    enabled = false;
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS);

    expect(checkMock).not.toHaveBeenCalled();
  });

  it("checks once the delay elapses when enabled", async () => {
    vi.useFakeTimers();
    checkMock.mockResolvedValue(null);
    const state = new UpdateState();

    state.scheduleStartupCheck(() => true);
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS);

    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending check on teardown", async () => {
    vi.useFakeTimers();
    checkMock.mockResolvedValue(null);
    const state = new UpdateState();

    const teardown = state.scheduleStartupCheck(() => true);
    teardown();
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS);

    expect(checkMock).not.toHaveBeenCalled();
  });
});

describe("UpdateState.listenForTrayChecks", () => {
  it("runs a manual check when the tray asks for one", async () => {
    checkMock.mockResolvedValue(null);
    let fire: () => void = () => {};
    listenMock.mockImplementation((handler) => {
      // The real callback receives an Event envelope the handler ignores.
      fire = () => handler({ event: "update-check-requested", id: 0, payload: null });
      return Promise.resolve(() => {});
    });
    const state = new UpdateState();

    state.listenForTrayChecks();
    await Promise.resolve();
    fire();
    await vi.waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
  });

  it("stops a listener that resolves after teardown", async () => {
    // The listener attaches asynchronously, so a page torn down in between
    // would otherwise leak a subscription onto a dead state object.
    const stop = vi.fn();
    let resolveListen: (value: () => void) => void = () => {};
    listenMock.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      })
    );
    const state = new UpdateState();

    const teardown = state.listenForTrayChecks();
    teardown();
    resolveListen(stop);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });
});

describe("UpdateState.loadTransition", () => {
  it("adopts the backend's updated flag verbatim", async () => {
    transitionMock.mockResolvedValue({
      previousVersion: "26.7.5",
      currentVersion: "26.8.0",
      updated: true
    });
    const state = new UpdateState();

    await state.loadTransition();

    expect(state.currentVersion).toBe("26.8.0");
    expect(state.justUpdated).toBe(true);
  });

  it("leaves the version blank when the backend call fails", async () => {
    transitionMock.mockRejectedValue(new Error("no runtime"));
    const state = new UpdateState();

    await state.loadTransition();

    expect(state.currentVersion).toBeNull();
    expect(state.justUpdated).toBe(false);
  });
});

describe("UpdateState.openReleases", () => {
  it("leaves the phase alone when the page opens", async () => {
    openReleasesMock.mockResolvedValue({ status: "ok", data: null });
    const state = new UpdateState();
    state.phase = { kind: "available", version: "26.8.0", notes: null };

    await state.openReleases();

    expect(openReleasesMock).toHaveBeenCalledTimes(1);
    expect(state.phase.kind).toBe("available");
  });

  it.each([
    ["the command reports an error", () => openReleasesMock.mockResolvedValue({ status: "error", error: "no browser" })],
    ["the command throws", () => openReleasesMock.mockRejectedValue(new Error("ipc down"))]
  ])("shows an error with the address when %s", async (_name, arrange) => {
    arrange();
    const state = new UpdateState();
    state.phase = { kind: "error", message: "Couldn't install 26.8.0. Download it manually instead." };

    await state.openReleases();

    expect(state.phase.kind).toBe("error");
    expect((state.phase as { message: string }).message).toContain("github.com/tstone-1/screenpick/releases");
    expect(logError).toHaveBeenCalled();
  });

  it("does not overwrite a running download with the error", async () => {
    openReleasesMock.mockResolvedValue({ status: "error", error: "no browser" });
    const state = new UpdateState();
    state.phase = { kind: "downloading", version: "26.8.0", downloaded: 1, total: 10 };

    await state.openReleases();

    expect(state.phase.kind).toBe("downloading");
  });
});
