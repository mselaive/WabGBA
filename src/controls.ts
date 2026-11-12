// Controles de teclado, editables por cada usuario.
// Se guardan por tecla física (`KeyboardEvent.code`), así no dependen del idioma del teclado.

export const ACTIONS = ['Up', 'Down', 'Left', 'Right', 'A', 'B', 'L', 'R', 'Start', 'Select', 'Fast'] as const;
export type Action = (typeof ACTIONS)[number];
export type Bindings = Record<Action, string>;

export const DEFAULTS: Bindings = {
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  A: 'KeyX',
  B: 'KeyZ',
  L: 'KeyA',
  R: 'KeyS',
  Start: 'Enter',
  Select: 'Backspace',
  Fast: 'Space',
};

export const LABELS: Record<Action, string> = {
  Up: 'Arriba',
  Down: 'Abajo',
  Left: 'Izquierda',
  Right: 'Derecha',
  A: 'Botón A',
  B: 'Botón B',
  L: 'Gatillo L',
  R: 'Gatillo R',
  Start: 'Start',
  Select: 'Select',
  Fast: 'Acelerar (mantener)',
};

const STORAGE = 'wabgba.controls';

/** Deja sólo lo que tenga forma de controles, completando con los de fábrica. */
export function normalize(raw: unknown): Bindings {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const action of ACTIONS) {
      const code = (raw as Record<string, unknown>)[action];
      if (typeof code === 'string' && code.length > 0 && code.length < 30) out[action] = code;
    }
  }
  return out;
}

export function load(): Bindings {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE) ?? 'null'));
  } catch {
    return { ...DEFAULTS };
  }
}

export function store(bindings: Bindings) {
  localStorage.setItem(STORAGE, JSON.stringify(bindings));
}

const NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Espacio',
  Enter: 'Enter',
  NumpadEnter: 'Enter (num)',
  Backspace: 'Retroceso',
  Tab: 'Tab',
  ShiftLeft: 'Shift izq',
  ShiftRight: 'Shift der',
  ControlLeft: 'Ctrl izq',
  ControlRight: 'Ctrl der',
  AltLeft: 'Alt izq',
  AltRight: 'Alt der',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
};

/** Nombre legible de una tecla física. */
export function keyLabel(code: string): string {
  if (NAMES[code]) return NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}
