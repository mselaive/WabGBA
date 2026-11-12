import type { Progress } from './save';

export interface Achievement {
  id: string;
  icon: string;
  title: string;
  desc: string;
  done: (p: Progress) => boolean;
  /** Avance parcial para mostrar en el panel, si aplica. */
  progress?: (p: Progress) => [current: number, goal: number];
}

const GYMS: [badge: string, leader: string, city: string][] = [
  ['Roca', 'Brock', 'Ciudad Plateada'],
  ['Cascada', 'Misty', 'Ciudad Celeste'],
  ['Trueno', 'Lt. Surge', 'Ciudad Carmín'],
  ['Arcoíris', 'Erika', 'Ciudad Azulona'],
  ['Alma', 'Koga', 'Ciudad Fucsia'],
  ['Pantano', 'Sabrina', 'Ciudad Azafrán'],
  ['Volcán', 'Blaine', 'Isla Canela'],
  ['Tierra', 'Giovanni', 'Ciudad Verde'],
];

const dex = (n: number, title: string): Achievement => ({
  id: `dex-${n}`,
  icon: '📕',
  title,
  desc: `Registrá ${n} Pokémon capturados en la Pokédex.`,
  done: (p) => p.owned >= n,
  progress: (p) => [p.owned, n],
});

export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first-pokemon',
    icon: '🌱',
    title: 'El comienzo',
    desc: 'Recibí tu primer Pokémon del Profesor Oak.',
    done: (p) => p.hasPokemon,
  },
  {
    id: 'pokedex',
    icon: '📟',
    title: 'Encargo del Profesor',
    desc: 'Conseguí la Pokédex.',
    done: (p) => p.hasPokedex,
  },
  ...GYMS.map(
    ([badge, leader, city], i): Achievement => ({
      id: `badge-${i + 1}`,
      icon: '🏅',
      title: `Medalla ${badge}`,
      desc: `Vencé a ${leader} en el gimnasio de ${city}.`,
      done: (p) => p.badges[i],
    }),
  ),
  {
    id: 'all-badges',
    icon: '🎖️',
    title: 'Las ocho medallas',
    desc: 'Juntá todas las medallas de Kanto.',
    done: (p) => p.badgeCount === 8,
    progress: (p) => [p.badgeCount, 8],
  },
  {
    id: 'champion',
    icon: '👑',
    title: 'Campeón de la Liga',
    desc: 'Vencé al Alto Mando y al Campeón.',
    done: (p) => p.champion,
  },
  {
    id: 'full-team',
    icon: '🧑‍🤝‍🧑',
    title: 'Equipo completo',
    desc: 'Llevá seis Pokémon en el equipo.',
    done: (p) => p.partyCount >= 6,
    progress: (p) => [p.partyCount, 6],
  },
  {
    id: 'level-30',
    icon: '💪',
    title: 'Entrenamiento serio',
    desc: 'Tené un Pokémon de nivel 30 en el equipo.',
    done: (p) => p.maxLevel >= 30,
    progress: (p) => [p.maxLevel, 30],
  },
  {
    id: 'level-50',
    icon: '🔥',
    title: 'Peso pesado',
    desc: 'Tené un Pokémon de nivel 50 en el equipo.',
    done: (p) => p.maxLevel >= 50,
    progress: (p) => [p.maxLevel, 50],
  },
  dex(10, 'Coleccionista novato'),
  dex(50, 'Coleccionista'),
  dex(100, 'Experto en Pokémon'),
  dex(150, 'Hazte con todos'),
  {
    id: 'money',
    icon: '💰',
    title: 'Bolsillos llenos',
    desc: 'Juntá ₽100.000.',
    done: (p) => p.money >= 100_000,
    progress: (p) => [p.money, 100_000],
  },
  {
    id: 'hours-10',
    icon: '⏱️',
    title: 'Diez horas de viaje',
    desc: 'Jugá diez horas en la misma partida.',
    done: (p) => p.hours >= 10,
    progress: (p) => [p.hours, 10],
  },
];

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
