// Lee el equipo del jugador de la memoria del juego, en vivo.
//
// El emulador no expone la RAM, pero sí un "estado": un PNG con la captura de pantalla y,
// en un trozo aparte (gbAs), toda la consola comprimida. Ahí la RAM de trabajo (EWRAM)
// empieza en 0x21000.
//
// En Rojo Fuego / Verde Hoja la memoria tiene, pegados y en este orden:
//   cantidad de Pokémon del jugador (1 byte), cantidad del rival (1 byte), 1 byte de relleno,
//   equipo rival (6 × 100 bytes), equipo del jugador (6 × 100 bytes).
// La dirección cambia según el idioma de la ROM, así que se busca por esa forma en vez de
// usar una dirección fija.

import { isSpecies } from './species';

const EWRAM_OFFSET = 0x21000;
const EWRAM_SIZE = 0x40000;
const MON_SIZE = 100;
const BOX_MON_SIZE = 80;
const PARTY_BYTES = MON_SIZE * 6;

export interface Mon {
  /** Identifica al Pokémon para siempre: personalidad + entrenador original. */
  key: string;
  species: number;
  nickname: string;
  level: number;
  hp: number;
  maxHp: number;
  otId: number;
  poisoned: boolean;
  /** Dónde se lo encontró (número de lugar del juego) y a qué nivel. */
  met: number;
  metLevel: number;
  egg: boolean;
}

export interface Snapshot {
  ram: Uint8Array;
  /** La captura de pantalla sola, sin la consola adentro. */
  image: Uint8Array;
}

/** Separa un estado de mGBA en la RAM de trabajo y la captura de pantalla. */
export async function readState(png: Uint8Array): Promise<Snapshot | null> {
  if (png.length < 16 || png[0] !== 0x89 || png[1] !== 0x50) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const picture: Uint8Array[] = [png.subarray(0, 8)];
  let packed: Uint8Array | null = null;
  for (let o = 8; o + 12 <= png.length; ) {
    const length = view.getUint32(o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    const end = o + 12 + length;
    if (end > png.length) return null;
    if (type === 'gbAs') packed = png.subarray(o + 8, o + 8 + length);
    else if (type === 'IHDR' || type === 'IDAT' || type === 'IEND') picture.push(png.subarray(o, end));
    o = end;
  }
  if (!packed) return null;

  const stream = new Blob([packed.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
  const state = new Uint8Array(await new Response(stream).arrayBuffer());
  if (state.length < EWRAM_OFFSET + EWRAM_SIZE) return null;

  const image = new Uint8Array(picture.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of picture) {
    image.set(part, at);
    at += part.length;
  }
  return { ram: state.subarray(EWRAM_OFFSET, EWRAM_OFFSET + EWRAM_SIZE), image };
}

const u16 = (ram: Uint8Array, o: number) => ram[o] | (ram[o + 1] << 8);
const u32 = (ram: Uint8Array, o: number) => (ram[o] | (ram[o + 1] << 8) | (ram[o + 2] << 16) | (ram[o + 3] << 24)) >>> 0;

/** En qué posición (0-3) queda el bloque "crecimiento" (donde va la especie) según la personalidad. */
const GROWTH_SLOT = [0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 2, 3, 1, 1, 2, 3, 2, 3, 1, 1, 2, 3, 2, 3];
/** Lo mismo para el bloque "varios": lugar y nivel de encuentro, y si es un huevo. */
const MISC_SLOT = [3, 2, 3, 2, 1, 1, 3, 2, 3, 2, 1, 1, 3, 2, 3, 2, 1, 1, 0, 0, 0, 0, 0, 0];

function decodeText(ram: Uint8Array, o: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const b = ram[o + i];
    if (b === 0xff) break;
    if (b >= 0xbb && b <= 0xd4) out += String.fromCharCode(65 + b - 0xbb);
    else if (b >= 0xd5 && b <= 0xee) out += String.fromCharCode(97 + b - 0xd5);
    else if (b >= 0xa1 && b <= 0xaa) out += String.fromCharCode(48 + b - 0xa1);
    else if (b === 0x00) out += ' ';
    else if (b === 0xab) out += '!';
    else if (b === 0xac) out += '?';
    else if (b === 0xad) out += '.';
    else if (b === 0xae) out += '-';
    else if (b === 0xb5) out += '♂';
    else if (b === 0xb6) out += '♀';
    else out += '·';
  }
  return out.trim();
}

/** Lee el Pokémon que hay en `o`, o null si ahí no hay uno válido. */
export function readMon(ram: Uint8Array, o: number): Mon | null {
  if (o < 0 || o + MON_SIZE > ram.length) return null;
  const level = ram[o + 84];
  if (level < 1 || level > 100) return null;
  const hp = u16(ram, o + 86);
  const maxHp = u16(ram, o + 88);
  if (maxHp < 1 || maxHp > 999 || hp > maxHp) return null;
  const mon = readBoxMon(ram, o);
  if (!mon) return null;
  return { ...mon, level, hp, maxHp, poisoned: (u32(ram, o + 80) & 0x88) !== 0 };
}

/**
 * Lee un Pokémon guardado en el PC: los primeros 80 bytes, sin nivel ni PS (ahí se usa el
 * nivel al que se lo encontró).
 */
export function readBoxMon(ram: Uint8Array, o: number): Mon | null {
  if (o < 0 || o + BOX_MON_SIZE > ram.length) return null;
  const language = ram[o + 18];
  if (language < 1 || language > 7) return null;

  const personality = u32(ram, o);
  const otId = u32(ram, o + 4);
  if (personality === 0 && otId === 0) return null;

  // Los 48 bytes de datos van cifrados con personalidad ^ entrenador, y su suma es el
  // checksum: si coincide, esto es un Pokémon de verdad y no basura que se le parece.
  const key = (personality ^ otId) >>> 0;
  let sum = 0;
  const words = new Uint32Array(12);
  for (let i = 0; i < 12; i++) {
    const w = (u32(ram, o + 32 + i * 4) ^ key) >>> 0;
    words[i] = w;
    sum = (sum + (w & 0xffff) + (w >>> 16)) & 0xffff;
  }
  if (sum !== u16(ram, o + 28)) return null;

  const species = words[GROWTH_SLOT[personality % 24] * 3] & 0xffff;
  if (!isSpecies(species)) return null;

  const misc = MISC_SLOT[personality % 24] * 3;
  const metLevel = (words[misc] >>> 16) & 0x7f;
  return {
    key: personality.toString(16).padStart(8, '0') + otId.toString(16).padStart(8, '0'),
    species,
    nickname: decodeText(ram, o + 8, 10),
    level: metLevel,
    hp: 0,
    maxHp: 0,
    otId,
    poisoned: false,
    met: (words[misc] >>> 8) & 0xff,
    metLevel,
    egg: ((words[misc + 1] >>> 30) & 1) === 1,
  };
}

function isPartyAt(ram: Uint8Array, base: number): boolean {
  if (base < PARTY_BYTES + 4 || base + PARTY_BYTES > ram.length) return false;
  const count = ram[base - PARTY_BYTES - 3];
  const enemyCount = ram[base - PARTY_BYTES - 2];
  if (count < 1 || count > 6 || enemyCount > 6) return false;
  for (let i = 0; i < count; i++) if (!readMon(ram, base + i * MON_SIZE)) return false;
  return true;
}

/**
 * Busca dónde está el equipo del jugador. `hint`: dónde estaba la última vez.
 *
 * El equipo rival está justo antes y tiene la misma forma, así que puede pasar por equipo
 * del jugador si los bytes que lo preceden parecen una cantidad. Por eso, cuando un
 * candidato tiene otro equipo válido 600 bytes más adelante, el del jugador es ese otro.
 */
export function findParty(ram: Uint8Array, hint: number | null): number | null {
  if (hint !== null && isPartyAt(ram, hint) && !isPartyAt(ram, hint + PARTY_BYTES)) return hint;
  for (let o = PARTY_BYTES + 4; o + PARTY_BYTES <= ram.length; o += 4) {
    // Descarte rápido antes de la comprobación completa.
    const language = ram[o + 18];
    const level = ram[o + 84];
    if (language < 1 || language > 7 || level < 1 || level > 100) continue;
    if (isPartyAt(ram, o)) return isPartyAt(ram, o + PARTY_BYTES) ? o + PARTY_BYTES : o;
  }
  return null;
}

export function readParty(ram: Uint8Array, base: number): Mon[] {
  const count = Math.min(ram[base - PARTY_BYTES - 3], 6);
  const mons: Mon[] = [];
  for (let i = 0; i < count; i++) {
    const mon = readMon(ram, base + i * MON_SIZE);
    if (mon) mons.push(mon);
  }
  return mons;
}

/** El equipo rival del combate en curso (o del último, si ya terminó). */
export function readEnemies(ram: Uint8Array, base: number): Mon[] {
  const start = base - PARTY_BYTES;
  const count = Math.min(ram[start - 2], 6);
  const mons: Mon[] = [];
  for (let i = 0; i < count; i++) {
    const mon = readMon(ram, start + i * MON_SIZE);
    if (mon) mons.push(mon);
  }
  return mons;
}
