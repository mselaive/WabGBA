// Sonidos de menú: ondas cuadradas generadas al vuelo, como un chip de 8 bits.

let ctx: AudioContext | null = null;
let enabled = true;

export const setSfx = (on: boolean) => {
  enabled = on;
};

function tone(freq: number, at: number, duration: number, volume = 0.035) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  const t = ctx.currentTime + at;
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + duration);
}

const SOUNDS = {
  move: () => tone(880, 0, 0.05),
  ok: () => {
    tone(660, 0, 0.06);
    tone(990, 0.06, 0.09);
  },
  back: () => {
    tone(520, 0, 0.06);
    tone(390, 0.06, 0.09);
  },
  error: () => {
    tone(180, 0, 0.12);
    tone(140, 0.12, 0.16);
  },
  unlock: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.16, 0.045)),
};

export function sfx(name: keyof typeof SOUNDS) {
  if (!enabled) return;
  try {
    ctx ??= new AudioContext();
    // Sin un gesto previo el navegador lo deja suspendido: no insistir.
    if (ctx.state === 'suspended') void ctx.resume();
    if (ctx.state === 'running') SOUNDS[name]();
  } catch {
    /* sin audio */
  }
}
