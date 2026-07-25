import { describe, expect, it, vi } from "vitest";

import { listenForExit } from "./shutdown";

// The bindings module is the seam: mocking it lets the handshake be tested with
// no Tauri runtime underneath.
vi.mock("./bindings", () => ({
  commands: { confirmExit: vi.fn().mockResolvedValue(undefined) },
  events: { appExiting: { listen: vi.fn() } }
}));

vi.mock("./diagnosticsLog", () => ({
  logError: vi.fn(),
  logWarn: vi.fn()
}));

const { commands, events } = await import("./bindings");
const confirmExitMock = vi.mocked(commands.confirmExit);
const listenMock = vi.mocked(events.appExiting.listen);

// Hand back the handler the module registered, so a test can fire the event.
async function attach(flush: () => Promise<void>) {
  let handler: (() => void) | undefined;
  const stop = vi.fn();
  listenMock.mockImplementation((cb) => {
    // The real callback receives an event payload the handshake ignores; the
    // test only needs to be able to fire it.
    handler = cb as unknown as () => void;
    return Promise.resolve(stop);
  });
  const teardown = listenForExit(flush);
  // Let the listen() promise settle so the teardown captures its unlisten.
  await Promise.resolve();
  await Promise.resolve();
  return { fire: () => handler?.(), teardown, stop };
}

describe("listenForExit", () => {
  it("flushes before confirming the exit", async () => {
    const order: string[] = [];
    confirmExitMock.mockImplementation(async () => {
      order.push("confirm");
    });
    const flush = vi.fn(async () => {
      order.push("flush");
    });

    const { fire } = await attach(flush);
    fire();
    await vi.waitFor(() => expect(confirmExitMock).toHaveBeenCalled());

    // Order is the whole point: confirming first would release the quit while
    // the write was still in flight, which is the bug this exists to prevent.
    expect(order).toEqual(["flush", "confirm"]);
  });

  it("still confirms the exit when the flush fails", async () => {
    // Losing the pending write is bad; an app that refuses to quit is worse.
    const flush = vi.fn().mockRejectedValue(new Error("disk full"));

    const { fire } = await attach(flush);
    fire();
    await vi.waitFor(() => expect(confirmExitMock).toHaveBeenCalledTimes(1));
  });

  it("stops listening on teardown", async () => {
    const { teardown, stop } = await attach(vi.fn().mockResolvedValue(undefined));

    teardown();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not leak a listener that resolves after teardown", async () => {
    // The listener attaches asynchronously, so a page torn down mid-attach must
    // still end up unsubscribed.
    const stop = vi.fn();
    let resolveListen: ((stop: () => void) => void) | undefined;
    listenMock.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve;
        })
    );

    const teardown = listenForExit(vi.fn().mockResolvedValue(undefined));
    teardown();
    resolveListen?.(stop);
    await Promise.resolve();
    await Promise.resolve();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});
