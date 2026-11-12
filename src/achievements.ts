import type { Progress } from './save';

/** Una baja, vista por los logros. */
export interface Death {
  at: number;
  /** Medallas que tenía el entrenador cuando cayó. */
  badges: number;
}

/** Con qué se evalúa un logro: la partida guardada y las bajas del randomlocke. */
export interface Run {
  p: Progress;
  deaths: Death[];
}

export interface Achievement {
  id: string;
  icon: string;
  title: string;
  desc: string;
  /** Experiencia que suma al rango de entrenador. Los logros "de la vergüenza" dan 0. */
  points: number;
  group: GroupId;
  done: (run: Run) => boolean;
  /** Avance parcial para mostrar, si aplica. */
  progress?: (run: Run) => [current: number, goal: number];
}

export type GroupId = 'aventura' | 'medallas' | 'randomlocke' | 'equipo';

export const GROUPS: { id: GroupId; title: string }[] = [
  { id: 'aventura', title: 'La aventura' },
  { id: 'medallas', title: 'Medallas' },
  { id: 'randomlocke', title: 'Randomlocke' },
  { id: 'equipo', title: 'Equipo y Pokédex' },
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

/** Llegó a la medalla `n` sin haber perdido a nadie antes de conseguirla. */
const cleanUntil = (n: number) => (run: Run) => run.p.badgeCount >= n && !run.deaths.some((d) => d.badges < n);

const TEN_MINUTES = 10 * 60 * 1000;

function closeDeaths(deaths: Death[], count: number): boolean {
  const times = deaths.map((d) => d.at).sort((a, b) => a - b);
  for (let i = 0; i + count - 1 < times.length; i++) {
    if (times[i + count - 1] - times[i] <= TEN_MINUTES) return true;
  }
  return false;
}

export const ACHIEVEMENTS: Achievement[] = [
  // ----- La aventura -----
  {
    id: 'first-pokemon',
    icon: '🌱',
    title: 'El comienzo',
    desc: 'Recibí tu primer Pokémon del Profesor Oak.',
    points: 10,
    group: 'aventura',
    done: ({ p }) => p.hasPokemon,
  },
  {
    id: 'pokedex',
    icon: '📟',
    title: 'Encargo del Profesor',
    desc: 'Conseguí la Pokédex.',
    points: 10,
    group: 'aventura',
    done: ({ p }) => p.hasPokedex,
  },
  {
    id: 'hours-10',
    icon: '⏱️',
    title: 'Diez horas de viaje',
    desc: 'Jugá diez horas en la misma partida.',
    points: 20,
    group: 'aventura',
    done: ({ p }) => p.hours >= 10,
    progress: ({ p }) => [p.hours, 10],
  },
  {
    id: 'champion',
    icon: '👑',
    title: 'Campeón de la Liga',
    desc: 'Vencé al Alto Mando y al Campeón.',
    points: 200,
    group: 'aventura',
    done: ({ p }) => p.champion,
  },

  // ----- Medallas -----
  ...GYMS.map(
    ([leader, city], i): Achievement => ({
      id: `badge-${i + 1}`,
      icon: '🏅',
      title: `Medalla ${BADGES[i]}`,
      desc: `Vencé a ${leader} en el gimnasio de ${city}.`,
      points: 30,
      group: 'medallas',
      done: ({ p }) => p.badges[i],
    }),
  ),

  // ----- Randomlocke -----
  {
    id: 'clean-1',
    icon: '🛡️',
    title: 'Arranque limpio',
    desc: 'Conseguí la primera medalla sin perder a ningún Pokémon.',
    points: 60,
    group: 'randomlocke',
    done: cleanUntil(1),
  },
  {
    id: 'clean-3',
    icon: '🛡️',
    title: 'Tres sin bajas',
    desc: 'Llegá a la tercera medalla sin perder a ningún Pokémon.',
    points: 120,
    group: 'randomlocke',
    done: cleanUntil(3),
  },
  {
    id: 'clean-8',
    icon: '💎',
    title: 'Intocable',
    desc: 'Juntá las ocho medallas sin perder a ningún Pokémon.',
    points: 300,
    group: 'randomlocke',
    done: cleanUntil(8),
  },
  {
    id: 'champion-clean',
    icon: '🏆',
    title: 'Campeón sin funerales',
    desc: 'Vencé a la Liga sin una sola baja en toda la partida.',
    points: 500,
    group: 'randomlocke',
    done: ({ p, deaths }) => p.champion && deaths.length === 0,
  },
  {
    id: 'first-blood',
    icon: '🩸',
    title: 'Primera sangre',
    desc: 'Perdé a tu primer Pokémon. Pasa en las mejores familias.',
    points: 0,
    group: 'randomlocke',
    done: ({ deaths }) => deaths.length >= 1,
  },
  {
    id: 'double-funeral',
    icon: '⚰️',
    title: 'Funeral doble',
    desc: 'Perdé dos Pokémon en menos de diez minutos.',
    points: 0,
    group: 'randomlocke',
    done: ({ deaths }) => closeDeaths(deaths, 2),
  },
  {
    id: 'graveyard',
    icon: '🪦',
    title: 'Cementerio propio',
    desc: 'Acumulá cinco bajas.',
    points: 0,
    group: 'randomlocke',
    done: ({ deaths }) => deaths.length >= 5,
    progress: ({ deaths }) => [deaths.length, 5],
  },

  // ----- Equipo y Pokédex -----
  {
    id: 'full-team',
    icon: '🧑‍🤝‍🧑',
    title: 'Equipo completo',
    desc: 'Llevá seis Pokémon en el equipo.',
    points: 20,
    group: 'equipo',
    done: ({ p }) => p.partyCount >= 6,
    progress: ({ p }) => [p.partyCount, 6],
  },
  {
    id: 'level-30',
    icon: '💪',
    title: 'Entrenamiento serio',
    desc: 'Tené un Pokémon de nivel 30 en el equipo.',
    points: 30,
    group: 'equipo',
    done: ({ p }) => p.maxLevel >= 30,
    progress: ({ p }) => [p.maxLevel, 30],
  },
  {
    id: 'level-50',
    icon: '🔥',
    title: 'Peso pesado',
    desc: 'Tené un Pokémon de nivel 50 en el equipo.',
    points: 60,
    group: 'equipo',
    done: ({ p }) => p.maxLevel >= 50,
    progress: ({ p }) => [p.maxLevel, 50],
  },
  {
    id: 'dex-25',
    icon: '📕',
    title: 'Coleccionista',
    desc: 'Registrá 25 Pokémon capturados en la Pokédex.',
    points: 40,
    group: 'equipo',
    done: ({ p }) => p.owned >= 25,
    progress: ({ p }) => [p.owned, 25],
  },
  {
    id: 'dex-75',
    icon: '📚',
    title: 'Experto en Pokémon',
    desc: 'Registrá 75 Pokémon capturados en la Pokédex.',
    points: 100,
    group: 'equipo',
    done: ({ p }) => p.owned >= 75,
    progress: ({ p }) => [p.owned, 75],
  },
];

// ---------- Rango de entrenador ----------

const RANKS: [from: number, name: string][] = [
  [0, 'Novato'],
  [50, 'Aprendiz'],
  [150, 'Entrenador'],
  [300, 'Veterano'],
  [500, 'As'],
  [800, 'Élite'],
  [1200, 'Maestro'],
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
export const pointsFor = (run: Run | null) =>
  run ? ACHIEVEMENTS.reduce((n, a) => n + (a.done(run) ? a.points : 0), 0) : 0;

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
export function evaluate(game: string, run: Run): Achievement[] {
  const unlocked = loadUnlocked(game);
  const fresh = ACHIEVEMENTS.filter((a) => !unlocked[a.id] && a.done(run));
  if (fresh.length) {
    const now = Date.now();
    for (const a of fresh) unlocked[a.id] = now;
    localStorage.setItem(storageKey(game), JSON.stringify(unlocked));
  }
  return fresh;
}
