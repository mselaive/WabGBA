// Lector de la partida (.sav) de Pokémon Rojo Fuego / Verde Hoja.
//
// El archivo tiene dos copias de la partida (14 sectores de 4 KB cada una); el juego
// alterna entre ellas y la vigente es la de índice de guardado más alto. Los offsets
// salen del desensamblado público (pret/pokefirered, include/global.h) y son los
// mismos en todos los idiomas.

import { readBoxMon, readMon, type Mon } from './party';

const SECTOR = 0x1000;
const SECTOR_DATA = 0xf80;
const SECTORS_PER_SLOT = 14;
const SIGNATURE = 0x08012025;

// SaveBlock2 (sector 0)
const SB2_NAME = 0x00;
const SB2_HOURS = 0x0e;
const SB2_MINUTES = 0x10;
const SB2_DEX_OWNED = 0x28;
const SB2_DEX_SEEN = 0x5c;
const SB2_GAME_CODE = 0xac; // 1 en RF/VH
const SB2_KEY = 0xf20;

// SaveBlock1 (sectores 1 a 4, pegados)
const SB1_PARTY_COUNT = 0x34;
const SB1_PARTY = 0x38;
const SB1_MONEY = 0x290;
const SB1_FLAGS = 0xee0;
const PARTY_MON_SIZE = 100;
const PARTY_MON_LEVEL = 0x54;

const FLAG_BADGE_1 = 0x820;
const FLAG_POKEMON_GET = 0x828;
const FLAG_POKEDEX_GET = 0x829;
const FLAG_GAME_CLEAR = 0x82c;

export interface Progress {
  name: string;
  hours: number;
  minutes: number;
  /** Medallas en orden: Roca, Cascada, Trueno, Arcoíris, Alma, Pantano, Volcán, Tierra. */
  badges: boolean[];
  badgeCount: number;
  hasPokemon: boolean;
  hasPokedex: boolean;
  champion: boolean;
  owned: number;
  seen: number;
  partyCount: number;
  maxLevel: number;
  money: number;
}

export type SaveResult =
  | { ok: true; progress: Progress }
  | { ok: false; reason: 'empty' | 'unsupported' };

function decodeName(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0xff) break;
    if (b >= 0xbb && b <= 0xd4) out += String.fromCharCode(65 + b - 0xbb);
    else if (b >= 0xd5 && b <= 0xee) out += String.fromCharCode(97 + b - 0xd5);
    else if (b >= 0xa1 && b <= 0xaa) out += String.fromCharCode(48 + b - 0xa1);
    else if (b === 0x00) out += ' ';
    else out += '?';
  }
  return out.trim();
}

function popcount(bytes: Uint8Array): number {
  let n = 0;
  for (let b of bytes) for (; b; b &= b - 1) n++;
  return n;
}

/** Devuelve los sectores de la copia vigente, indexados por id de sección. */
function currentSlot(data: Uint8Array, dv: DataView): Uint8Array[] | null {
  let best: { index: number; sections: Uint8Array[] } | null = null;
  for (let slot = 0; slot < 2; slot++) {
    const sections: Uint8Array[] = [];
    let index = -1;
    let valid = true;
    for (let i = 0; i < SECTORS_PER_SLOT; i++) {
      const base = (slot * SECTORS_PER_SLOT + i) * SECTOR;
      if (base + SECTOR > data.length || dv.getUint32(base + 0xff8, true) !== SIGNATURE) {
        valid = false;
        break;
      }
      const id = dv.getUint16(base + 0xff4, true);
      const saveIndex = dv.getUint32(base + 0xffc, true);
      // Si los sectores no comparten índice, la copia está a medio escribir.
      if (id >= SECTORS_PER_SLOT || (index !== -1 && saveIndex !== index)) {
        valid = false;
        break;
      }
      index = saveIndex;
      sections[id] = data.subarray(base, base + SECTOR_DATA);
    }
    if (!valid || sections.filter(Boolean).length !== SECTORS_PER_SLOT) continue;
    if (!best || index > best.index) best = { index, sections };
  }
  return best?.sections ?? null;
}

/**
 * Todos los Pokémon de la partida guardada: el equipo y las cajas del PC. Sirve para ver
 * las capturas que fueron directo al PC porque el equipo estaba lleno.
 */
export function readSavedMons(data: Uint8Array | null): { party: Mon[]; boxed: Mon[] } | null {
  if (!data || data.length < SECTOR * SECTORS_PER_SLOT) return null;
  const sections = currentSlot(data, new DataView(data.buffer, data.byteOffset, data.byteLength));
  if (!sections) return null;

  const sb1 = new Uint8Array(SECTOR_DATA * 4);
  for (let i = 0; i < 4; i++) sb1.set(sections[1 + i], i * SECTOR_DATA);
  const party: Mon[] = [];
  const count = Math.min(new DataView(sb1.buffer).getUint32(SB1_PARTY_COUNT, true), 6);
  for (let i = 0; i < count; i++) {
    const mon = readMon(sb1, SB1_PARTY + i * PARTY_MON_SIZE);
    if (mon) party.push(mon);
  }

  // El PC ocupa los sectores 5 a 13, pegados: 4 bytes y después 14 cajas de 30 Pokémon.
  const pc = new Uint8Array(SECTOR_DATA * 9);
  for (let i = 0; i < 9; i++) pc.set(sections[5 + i], i * SECTOR_DATA);
  const boxed: Mon[] = [];
  for (let i = 0; i < 14 * 30; i++) {
    const mon = readBoxMon(pc, 4 + i * 80);
    if (mon) boxed.push(mon);
  }
  return { party, boxed };
}

export function readSave(data: Uint8Array | null): SaveResult {
  if (!data || data.length < SECTOR * SECTORS_PER_SLOT) return { ok: false, reason: 'empty' };
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sections = currentSlot(data, dv);
  if (!sections) return { ok: false, reason: 'empty' };

  const sb2 = sections[0];
  const sb2v = new DataView(sb2.buffer, sb2.byteOffset, sb2.byteLength);
  if (sb2v.getUint32(SB2_GAME_CODE, true) !== 1) return { ok: false, reason: 'unsupported' };

  const sb1 = new Uint8Array(SECTOR_DATA * 4);
  for (let i = 0; i < 4; i++) sb1.set(sections[1 + i], i * SECTOR_DATA);
  const sb1v = new DataView(sb1.buffer);

  const flag = (id: number) => (sb1[SB1_FLAGS + (id >> 3)] & (1 << (id & 7))) !== 0;
  const badges = Array.from({ length: 8 }, (_, i) => flag(FLAG_BADGE_1 + i));

  const partyCount = Math.min(sb1v.getUint32(SB1_PARTY_COUNT, true), 6);
  let maxLevel = 0;
  for (let i = 0; i < partyCount; i++) {
    maxLevel = Math.max(maxLevel, sb1[SB1_PARTY + i * PARTY_MON_SIZE + PARTY_MON_LEVEL]);
  }

  return {
    ok: true,
    progress: {
      name: decodeName(sb2.subarray(SB2_NAME, SB2_NAME + 8)),
      hours: sb2v.getUint16(SB2_HOURS, true),
      minutes: sb2[SB2_MINUTES],
      badges,
      badgeCount: badges.filter(Boolean).length,
      hasPokemon: flag(FLAG_POKEMON_GET),
      hasPokedex: flag(FLAG_POKEDEX_GET),
      champion: flag(FLAG_GAME_CLEAR),
      owned: popcount(sb2.subarray(SB2_DEX_OWNED, SB2_DEX_OWNED + 52)),
      seen: popcount(sb2.subarray(SB2_DEX_SEEN, SB2_DEX_SEEN + 52)),
      partyCount,
      maxLevel: Math.min(maxLevel, 100),
      money: (sb1v.getUint32(SB1_MONEY, true) ^ sb2v.getUint32(SB2_KEY, true)) >>> 0,
    },
  };
}
