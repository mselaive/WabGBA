import type { Progress } from './save';

export interface Achievement {
  id: string;
  icon: string;
  title: string;
  desc: string;
  /** Experiencia que suma al rango de entrenador. */
  points: number;
  /** Cadena de misiones a la que pertenece. */
  chain: ChainId;
  done: (p: Progress) => boolean;
  /** Avance parcial para mostrar, si aplica. */
  progress?: (p: Progress) => [current: number, goal: number];
}

export type ChainId = 'historia' | 'medallas' | 'equipo' | 'pokedex' | 'extra';

/** Las misiones son los mismos logros, agrupados en cadenas que se hacen en orden. */
export const CHAINS: { id: ChainId; title: string; icon: string }[] = [
  { id: 'historia', title: 'La aventura', icon: '🗺️' },
  { id: 'medallas', title: 'Camino de las medallas', icon: '🏅' },
  { id: 'equipo', title: 'Entrenamiento', icon: '💪' },
  { id: 'pokedex', title: 'Pokédex', icon: '📕' },
  { id: 'extra', title: 'Desafíos', icon: '⭐' },
];

export const BADGES = ['Roca', 'Cascada', 'Trueno', 'Arcoíris', 'Alma', 'Pantano', 'Volcán', 'Tierra'];

const GYMS: [leader: string, city: string][] = [
  ['Brock', 'Ciudad Plateada'],
  ['Misty', 'Ciudad Celeste'],
  ['Lt. Surge', 'Ciudad Carmín'],
  ['Erika', 'Ciudad Azulona'],
  ['Koga', 'Ciudad Fucsia'],
  ['Sabrina', 'Ciudad Azafrán'],
  ['Blaine', 'Isla Canela'],
  ['Giovanni', 'Ciudad Verde'],
];

const dex = (n: number, title: string, points: number): Achievement => ({
  id: `dex-${n}`,
  icon: '📕',
  title,
  desc: `Registrá ${n} Pokémon capturados en la Pokédex.`,
  points,
  chain: 'pokedex',
  done: (p) => p.owned >= n,
  progress: (p) => [p.owned, n],
});

export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first-pokemon',
    icon: '🌱',
    title: 'El comienzo',
    desc: 'Recibí tu primer Pokémon del Profesor Oak.',
    points: 10,
    chain: 'historia',
    done: (p) => p.hasPokemon,
  },
  {
    id: 'pokedex',
    icon: '📟',
    title: 'Encargo del Profesor',
    desc: 'Conseguí la Pokédex.',
    points: 10,
    chain: 'historia',
    done: (p) => p.hasPokedex,
  },
  {
    id: 'champion',
    icon: '👑',
    title: 'Campeón de la Liga',
    desc: 'Vencé al Alto Mando y al Campeón.',
    points: 200,
    chain: 'historia',
    done: (p) => p.champion,
  },
  ...GYMS.map(
    ([leader, city], i): Achievement => ({
      id: `badge-${i + 1}`,
      icon: '🏅',
      title: `Medalla ${BADGES[i]}`,
      desc: `Vencé a ${leader} en el gimnasio de ${city}.`,
      points: 30,
      chain: 'medallas',
      done: (p) => p.badges[i],
    }),
  ),
  {
    id: 'all-badges',
    icon: '🎖️',
    title: 'Las ocho medallas',
    desc: 'Juntá todas las medallas de Kanto.',
    points: 100,
    chain: 'medallas',
    done: (p) => p.badgeCount === 8,
    progress: (p) => [p.badgeCount, 8],
  },
  {
    id: 'full-team',
    icon: '🧑‍🤝‍🧑',
    title: 'Equipo completo',
    desc: 'Llevá seis Pokémon en el equipo.',
    points: 20,
    chain: 'equipo',
    done: (p) => p.partyCount >= 6,
    progress: (p) => [p.partyCount, 6],
  },
  {
    id: 'level-30',
    icon: '💪',
    title: 'Entrenamiento serio',
    desc: 'Tené un Pokémon de nivel 30 en el equipo.',
    points: 30,
    chain: 'equipo',
    done: (p) => p.maxLevel >= 30,
    progress: (p) => [p.maxLevel, 30],
  },
  {
    id: 'level-50',
    icon: '🔥',
    title: 'Peso pesado',
    desc: 'Tené un Pokémon de nivel 50 en el equipo.',
    points: 60,
    chain: 'equipo',
    done: (p) => p.maxLevel >= 50,
    progress: (p) => [p.maxLevel, 50],
  },
  dex(10, 'Coleccionista novato', 20),
  dex(50, 'Coleccionista', 50),
  dex(100, 'Experto en Pokémon', 100),
  dex(150, 'Hazte con todos', 200),
  {
    id: 'money',
    icon: '💰',
    title: 'Bolsillos llenos',
    desc: 'Juntá ₽100.000.',
    points: 30,
    chain: 'extra',
    done: (p) => p.money >= 100_000,
    progress: (p) => [p.money, 100_000],
  },
  {
    id: 'hours-10',
    icon: '⏱️',
    title: 'Diez horas de viaje',
    desc: 'Jugá diez horas en la misma partida.',
    points: 20,
    chain: 'extra',
    done: (p) => p.hours >= 10,
    progress: (p) => [p.hours, 10],
  },
];

export const TOTAL_POINTS = ACHIEVEMENTS.reduce((n, a) => n + a.points, 0);

// ---------- Rango de entrenador ----------

const RANKS: [from: number, name: string][] = [
  [0, 'Novato'],
  [50, 'Aprendiz'],
  [150, 'Entrenador'],
  [300, 'Veterano'],
  [500, 'As'],
  [800, 'Élite'],
  [1000, 'Maestro'],
];

export interface Rank {
  name: string;
  level: number;
  points: number;
  /** Puntos donde empieza este rango y donde empieza el siguiente (null: es el último). */
  floor: number;
  next: number | null;
}

export function rankFor(points: number): Rank {
  let level = 0;
  while (level + 1 < RANKS.length && points >= RANKS[level + 1][0]) level++;
  return {
    name: RANKS[level][1],
    level: level + 1,
    points,
    floor: RANKS[level][0],
    next: RANKS[level + 1]?.[0] ?? null,
  };
}

/** Puntos que da una partida tal como está ahora. */
export const pointsFor = (p: Progress | null) =>
  p ? ACHIEVEMENTS.reduce((n, a) => n + (a.done(p) ? a.points : 0), 0) : 0;

// ---------- Registro de lo desbloqueado ----------
// Queda en el navegador, por partida: { idDelLogro: fecha en ms }.

export type Unlocked = Record<string, number>;

const storageKey = (game: string) => `wabgba.logros.${game}`;

export function loadUnlocked(game: string): Unlocked {
  try {
    return JSON.parse(localStorage.getItem(storageKey(game)) ?? '{}') as Unlocked;
  } catch {
    return {};
  }
}

/** Marca los logros recién cumplidos y devuelve cuáles son nuevos. */
export function evaluate(game: string, p: Progress): Achievement[] {
  const unlocked = loadUnlocked(game);
  const fresh = ACHIEVEMENTS.filter((a) => !unlocked[a.id] && a.done(p));
  if (fresh.length) {
    const now = Date.now();
    for (const a of fresh) unlocked[a.id] = now;
    localStorage.setItem(storageKey(game), JSON.stringify(unlocked));
  }
  return fresh;
}
