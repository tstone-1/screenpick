import { beforeEach, describe, expect, it, vi } from "vitest";

const commandsMock = vi.hoisted(() => ({
  decodeQrInCapture: vi.fn(),
  openQrUrl: vi.fn()
}));

vi.mock("./bindings", () => ({ commands: commandsMock }));
vi.mock("./diagnosticsLog", () => ({ logError: vi.fn() }));

const { QrReader, qrStatusMessage } = await import("./qrReader.svelte");
const { statusLine } = await import("./statusLine.svelte");

const url = { text: "https://example.com", isUrl: true };
const plain = { text: "WIFI:S:home;;", isUrl: false };

beforeEach(() => {
  vi.clearAllMocks();
  statusLine.set("");
});

describe("qrStatusMessage", () => {
  it("says what was found and whether the copy happened", () => {
    expect(qrStatusMessage({ codes: [], copied: false })).toBe("No QR code found.");
    expect(qrStatusMessage({ codes: [url], copied: true })).toBe(
      "QR code read and copied to the clipboard."
    );
    expect(qrStatusMessage({ codes: [url, plain], copied: true })).toBe(
      "2 QR codes read and copied to the clipboard."
    );
    // A failed copy must never be reported as a copy.
    expect(qrStatusMessage({ codes: [url], copied: false })).toBe(
      "QR code read, but copying to the clipboard failed."
    );
  });
});

describe("readCapture", () => {
  it("shows the decoded result for the capture path", async () => {
    const reader = new QrReader();
    const result = { codes: [plain], copied: true };
    commandsMock.decodeQrInCapture.mockResolvedValue({ status: "ok", data: result });

    await reader.readCapture("C:/captures/a.png");

    expect(commandsMock.decodeQrInCapture).toHaveBeenCalledWith("C:/captures/a.png");
    expect(reader.result).toEqual(result);
    expect(reader.readPending).toBe(false);
  });

  it("reports an error without replacing the panel's result", async () => {
    const reader = new QrReader();
    const earlier = { codes: [url], copied: true };
    reader.show(earlier);
    commandsMock.decodeQrInCapture.mockResolvedValue({ status: "error", error: "not a capture" });

    await reader.readCapture("C:/elsewhere.png");

    expect(statusLine.message).toBe("not a capture");
    expect(reader.result).toEqual(earlier);
    expect(reader.readPending).toBe(false);
  });

  it("clears the pending flag when the IPC call rejects", async () => {
    const reader = new QrReader();
    commandsMock.decodeQrInCapture.mockRejectedValue(new Error("ipc down"));

    await reader.readCapture("C:/captures/a.png");

    expect(statusLine.message).toBe("Could not read QR codes.");
    expect(reader.readPending).toBe(false);
  });
});

describe("openUrl", () => {
  it("passes the text to Rust and reports a refusal", async () => {
    const reader = new QrReader();
    commandsMock.openQrUrl.mockResolvedValue({
      status: "error",
      error: "Only http and https links can be opened."
    });

    await reader.openUrl(url);

    expect(commandsMock.openQrUrl).toHaveBeenCalledWith("https://example.com");
    expect(statusLine.message).toBe("Only http and https links can be opened.");
  });
});
