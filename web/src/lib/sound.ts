import type { ChangeKind } from './changes.ts';

/** Pitch pair and loudness per cue. Attention rises; the rest settle. */
const CUES: Record<ChangeKind, { notes: number[]; gain: number }> = {
  'needs-you': { notes: [659.25, 880], gain: 0.11 },
  planned: { notes: [659.25, 783.99], gain: 0.06 },
  done: { notes: [783.99, 587.33], gain: 0.06 },
  started: { notes: [523.25], gain: 0.035 },
};

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (context) return context;
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
    return context;
  } catch {
    return null;
  }
}

/**
 * A browser refuses to make noise before the user has interacted with the
 * page, and an AudioContext created up front sits suspended. Resume it on the
 * first gesture; until then cues are dropped rather than throwing.
 */
export function primeAudio(): void {
  const ctx = audio();
  if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
}

export function playCue(kind: ChangeKind): void {
  const ctx = audio();
  if (!ctx || ctx.state !== 'running') return;

  const { notes, gain } = CUES[kind];
  const start = ctx.currentTime;

  notes.forEach((frequency, index) => {
    const at = start + index * 0.11;
    const osc = ctx.createOscillator();
    const envelope = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.value = frequency;

    // A hard start and stop clicks; ramp both ends.
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.19);

    osc.connect(envelope).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.2);
  });
}
