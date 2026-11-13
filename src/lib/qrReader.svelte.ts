// The QR reader's result panel: what the last scan found, from the Scan QR
// capture mode (`QrScanCompleted`) or the editor's Read QR button. Rust
// decodes, copies the texts to the clipboard and decides which texts are
// links (qr.rs); this store only holds the result and drives the panel.
import { commands, type QrCode, type QrScanResult } from "./bindings";
import { logError } from "./diagnosticsLog";
import { statusLine } from "./statusLine.svelte";

export function qrStatusMessage(result: QrScanResult): string {
  const count = result.codes.length;
  if (count === 0) return "No QR code found.";
  const found = count === 1 ? "QR code read" : `${count} QR codes read`;
  return result.copied
    ? `${found} and copied to the clipboard.`
    : `${found}, but copying to the clipboard failed.`;
}

export class QrReader {
  result = $state<QrScanResult | null>(null);
  readPending = $state(false);

  show(result: QrScanResult) {
    this.result = result;
    statusLine.set(qrStatusMessage(result));
  }

  dismiss() {
    this.result = null;
  }

  // Read QR codes in a capture the editor has open. `path` is the capture's
  // base image, so annotations drawn over a code do not hide it.
  async readCapture(path: string) {
    if (this.readPending) return;
    this.readPending = true;
    try {
      const result = await commands.decodeQrInCapture(path);
      if (result.status === "error") {
        statusLine.set(result.error || "Could not read QR codes.");
        return;
      }
      this.show(result.data);
    } catch (error) {
      logError(`Read QR failed: ${String(error)}`);
      statusLine.set("Could not read QR codes.");
    } finally {
      this.readPending = false;
    }
  }

  // Open a decoded link. Only offered for `isUrl` codes, and Rust checks again.
  async openUrl(code: QrCode) {
    try {
      const result = await commands.openQrUrl(code.text);
      if (result.status === "error") statusLine.set(result.error || "Could not open the link.");
    } catch (error) {
      logError(`Open QR link failed: ${String(error)}`);
      statusLine.set("Could not open the link.");
    }
  }

  // Copy one code again, e.g. when a scan found several. The panel is in the
  // focused window when its button is clicked, so the webview clipboard works.
  async copyText(code: QrCode) {
    try {
      await navigator.clipboard.writeText(code.text);
      statusLine.set("QR text copied to the clipboard.");
    } catch (error) {
      logError(`Copy QR text failed: ${String(error)}`);
      statusLine.set("Could not copy the QR text.");
    }
  }
}

export const qrReader = new QrReader();
