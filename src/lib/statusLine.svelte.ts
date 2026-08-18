// The app's one status line — the message in the bottom status bar.
//
// Split out of captureOrchestration.svelte.ts (W3 in the 2026-08 code review).
// Both halves of the app report here: the capture pipeline (mode started, shot
// ingested, capture failed) and the editor surfaces (crop/cut applied, color
// copied, export failed). Neither owns the other, so the message belongs to
// neither — while it lived on `CaptureOrchestration`, EditorStage and
// ToolProperties imported the capture module for the sole purpose of writing a
// status message, which made the capture orchestrator an app-wide status bus.
class StatusLine {
  // Idle text, shown until the first capture or edit reports something.
  message = $state("Choose a capture mode or press a shortcut.");

  set(message: string) {
    this.message = message;
  }
}

export const statusLine = new StatusLine();
