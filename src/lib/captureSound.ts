// A short, soft confirmation chime played after a successful hotkey capture.
// Synthesized with the Web Audio API so there's no binary asset to ship and no
// network/file load on the hot path.

let audioCtx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) {
    try {
      audioCtx = new Ctor();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

// Webviews start an AudioContext suspended until a user gesture. Call this from
// an input handler once so a later capture triggered by a background hotkey is
// still allowed to make sound.
export function unlockCaptureSound(): void {
  const ctx = context();
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

// Play a brief two-tone rising chime. Best-effort: silently does nothing if the
// Web Audio API is unavailable or the context can't be resumed.
export function playCaptureSound(): void {
  const ctx = context();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();

  const start = ctx.currentTime + 0.001;
  const tones = [
    { freq: 660, at: 0, dur: 0.08 },
    { freq: 990, at: 0.07, dur: 0.11 }
  ];

  for (const tone of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = tone.freq;

    // Quick attack then exponential decay so the blips don't click.
    const t0 = start + tone.at;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.dur);

    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + tone.dur + 0.02);
  }
}
