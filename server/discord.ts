// Los avisos que van al canal de Discord de una sala: tarjetas (embeds) con color, miniatura
// del Pokémon, datos en columnas y una frase al azar para que no salga siempre lo mismo.
import { BADGES } from '../src/achievements';
import { isCave, placeName } from '../src/places';
import { speciesName } from '../src/species';

export interface Card {
  color: number;
  title: string;
  description: string;
  /** Frase de color que acompaña al aviso. */
  quote?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  /** Imagen chica arriba a la derecha. */
  thumbnail?: string;
}

/** Lo que se le manda al webhook. Sin menciones: un motivo con @everyone no avisa a nadie. */
export function payloadFor(room: string, card: Card, withImage: boolean) {
  return {
    username: 'WabGBA',
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: card.title.slice(0, 250),
        description: (card.description + (card.quote ? `\n\n*${card.quote}*` : '')).slice(0, 2000),
        color: card.color,
        ...(card.fields ? { fields: card.fields } : {}),
        ...(card.thumbnail ? { thumbnail: { url: card.thumbnail } } : {}),
        // La captura del momento, adjunta al mismo mensaje.
        ...(withImage ? { image: { url: 'attachment://momento.png' } } : {}),
        footer: { text: `Sala ${room} · WabGBA` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

const RED = 0xe63946;
const DARK = 0x2b2d42;
const GOLD = 0xf4b400;
const BLUE = 0x3a86ff;
const PURPLE = 0x8338ec;
const GREEN = 0x2a9d8f;
const GRAY = 0x8d99ae;
const CATCH = 0xff6b35;

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

/** Para que un mote o un motivo no rompa el formato de Discord. */
export const plain = (text: string) => text.replace(/([\\*_~`|>])/g, '\\$1');

/** El sprite del Pokémon, por nombre (los de Pokémon Showdown). */
export function sprite(species: number): string | undefined {
  const name = speciesName(species);
  if (name === '???') return undefined;
  const id = name
    .toLowerCase()
    .replace('♀', 'f')
    .replace('♂', 'm')
    .replace(/[^a-z0-9]/g, '');
  return `https://play.pokemonshowdown.com/sprites/gen5/${id}.png`;
}

function hearts(left: number, total: number): string {
  const alive = Math.max(0, left);
  if (total > 12) return `**${alive}** de ${total}`;
  return '❤️'.repeat(alive) + '🖤'.repeat(Math.max(0, total - alive)) + `  (${alive}/${total})`;
}

const DEATH_ANY = [
  'F en el chat.',
  'Press F to pay respects.',
  'Se fue a la granja, con los otros Pokémon.',
  'Que en paz descanse en la caja del PC.',
  'El Centro Pokémon no hace milagros.',
  'Otro más para la Torre Pokémon de Pueblo Lavanda.',
  'Vivió rápido, murió joven.',
  'No era su día. Ni su semana.',
  'La Enfermera Joy dice que lo intentó todo.',
  'Minuto de silencio. Bueno, ya, sigan jugando.',
  'Se nos adelantó.',
  'Alguien ponga la música triste de Pueblo Lavanda.',
  'El profesor Oak está decepcionado.',
  'Nadie lo vio venir. Bueno, todos menos su entrenador.',
  'Su entrenador jura que fue un crítico.',
  'Dicen que fue lag.',
  '“Tranquilo, aguanta un golpe más”, dijo.',
  'Entrenador del año no va a ser.',
];
const DEATH_WILD = [
  'Lo mató un bicho de la hierba alta. De la hierba alta.',
  'Ni siquiera fue un entrenador. Fue la naturaleza.',
  'Salió a pasear por la hierba y no volvió.',
  'Para eso existen los Repelentes.',
  'Un salvaje cualquiera, sin nombre ni medallas.',
];
const DEATH_SHAME = [
  'Y con ventaja de nivel. Qué vergüenza.',
  'Le ganó uno más chico. Esto queda en el historial para siempre.',
  'Tenía todo para ganar y aun así.',
  'Subestimar al rival: el clásico.',
  'David contra Goliat, y ganó David.',
];
const DEATH_BRAVE = [
  'Murió peleando contra algo mucho más grande que él. Respeto.',
  'Lo mandaron al matadero.',
  '¿Quién lo dejó en el campo contra eso?',
  'Valiente, pero no alcanzó.',
];
const DEATH_POISON = [
  'El veneno no perdona. Los Antídotos cuestan 100 pokés.',
  'Murió caminando. Envenenado. Paso a paso.',
  'Un Antídoto lo habría salvado. Solo decía.',
];
const DEATH_LAST = [
  'Queda UNA sola vida. A partir de acá se juega con el corazón en la boca.',
  'Una vida. Una. Cuidado con los críticos.',
  'Última vida: prohibido pestañear.',
];
const DEATH_OUT = [
  'Game over. Se acabó lo que se daba.',
  'Fin del camino. Gracias por participar.',
  'Se apagó la consola.',
  'A ver los créditos desde afuera.',
];

export interface Death {
  username: string;
  species: number;
  level: number;
  nickname: string;
  enemy: { species: number | null; level: number | null; wild: boolean } | null;
  poisoned: boolean;
  /** Dónde lo había encontrado. */
  met?: number | null;
  left: number;
  lives: number;
}

export function deathCard(d: Death): Card {
  const name = speciesName(d.species);
  const named = d.nickname && d.nickname.toLowerCase() !== name.toLowerCase();
  const who = named ? `**${plain(d.nickname)}** (${name})` : `**${name}**`;
  const foe = d.enemy?.species && d.enemy.level ? { name: speciesName(d.enemy.species), level: d.enemy.level, wild: d.enemy.wild } : null;

  const pool = [...DEATH_ANY];
  let special: string[] = [];
  if (d.poisoned) special = DEATH_POISON;
  else if (foe && foe.level + 5 <= d.level) special = DEATH_SHAME;
  else if (foe && foe.level >= d.level + 8) special = DEATH_BRAVE;
  else if (foe?.wild) special = DEATH_WILD;
  // Si hay frases a medida de lo que pasó, salen la mayoría de las veces.
  let quote = special.length && Math.random() < 0.7 ? pick(special) : pick(pool);
  if (d.left === 1) quote = pick(DEATH_LAST);
  if (d.left <= 0) quote = pick(DEATH_OUT);

  const fields = [
    { name: 'Entrenador', value: d.username, inline: true },
    { name: 'Caído', value: `${named ? plain(d.nickname) + ' · ' : ''}${name} nv ${d.level}`, inline: true },
  ];
  if (foe) fields.push({ name: 'Verdugo', value: `${foe.name}${foe.wild ? ' salvaje' : ''} nv ${foe.level}`, inline: true });
  else if (d.poisoned) fields.push({ name: 'Verdugo', value: 'El veneno', inline: true });
  const origin = placeName(d.met);
  if (origin) fields.push({ name: 'Venía de', value: origin.charAt(0).toUpperCase() + origin.slice(1), inline: true });
  fields.push({ name: d.left > 0 ? 'Vidas' : 'Sin vidas', value: hearts(d.left, d.lives), inline: false });

  return {
    color: d.left > 0 ? RED : DARK,
    title: d.left > 0 ? `💀 ${d.username} perdió un Pokémon` : `☠️ ${d.username} se quedó sin vidas`,
    description: foe
      ? `${who} cayó contra un **${foe.name}**${foe.wild ? ' salvaje' : ''}.`
      : d.poisoned
        ? `${who} no aguantó el veneno.`
        : `${who} ya no está entre nosotros.`,
    quote,
    fields,
    thumbnail: sprite(d.species),
  };
}

const CATCH_ANY = [
  'Bienvenido al equipo. Suerte, la vas a necesitar.',
  'Carne fresca.',
  'Otro valiente que no sabe dónde se metió.',
  'Que le dure más que al anterior.',
  'No te encariñes.',
  'Firmó contrato sin leer la letra chica.',
  'Un integrante más. Una posible baja más.',
  'Hazte con todos.',
  'La Poké Ball hizo clic. Qué alivio.',
  'A ver cuánto dura.',
  'El profesor Oak aprueba esta captura.',
  'Lo que salió, salió. Así es el randomlocke.',
];
const CATCH_CAVE = [
  'Lo sacaron de una cueva oscura. Seguro era un Zubat… ah, no, randomlocke.',
  'Salió de la oscuridad directo a la Poké Ball.',
  'Lo encontró a ciegas, sin Destello.',
];
const CATCH_BOXED = [
  'Equipo lleno: directo al PC, a esperar su turno.',
  'Al banco de suplentes.',
  'Guardado en la caja, por si las moscas. Y va a haber moscas.',
];
const CATCH_STARTER = [
  'Así empieza todo.',
  'El primero de muchos. Ojalá no el primero en caer.',
  'Arranca la aventura. Que alguien anote cuánto dura.',
];
const CATCH_BABY = ['Chiquito pero cumplidor. Esperemos.', 'Nivel bajo, sueños altos.'];
const CATCH_BIG = ['Viene crecidito.', 'Este ya viene entrenado. Menos trabajo.'];

export interface Catch {
  username: string;
  species: number;
  level: number;
  nickname: string;
  met: number | null;
  /** Fue directo al PC porque el equipo estaba lleno. */
  boxed: boolean;
  /** Cuántos lleva esta cuenta en la sala, contando este. */
  total: number;
}

export function catchCard(c: Catch): Card {
  const name = speciesName(c.species);
  const named = c.nickname && c.nickname.toLowerCase() !== name.toLowerCase();
  const who = named ? `**${plain(c.nickname)}** (${name})` : `un **${name}**`;
  const place = placeName(c.met);
  const starter = c.total === 1 && c.met === 88;
  const trade = c.met === 254;

  let special: string[] = [];
  if (starter) special = CATCH_STARTER;
  else if (c.boxed) special = CATCH_BOXED;
  else if (isCave(c.met)) special = CATCH_CAVE;
  else if (c.level <= 4) special = CATCH_BABY;
  else if (c.level >= 40) special = CATCH_BIG;
  const quote = special.length && Math.random() < 0.6 ? pick(special) : pick(CATCH_ANY);

  const where = !place ? '' : c.met === 254 || c.met === 255 ? ` en ${place}` : ` en **${place}**`;
  const fields = [
    { name: 'Entrenador', value: c.username, inline: true },
    { name: 'Pokémon', value: `${name} nv ${c.level}`, inline: true },
  ];
  if (place) fields.push({ name: 'Lugar', value: place.charAt(0).toUpperCase() + place.slice(1), inline: true });
  fields.push({ name: 'Capturas', value: `Lleva **${c.total}** en esta partida${c.boxed ? ' · este fue al PC' : ''}`, inline: false });

  return {
    color: CATCH,
    title: starter ? `🌱 ${c.username} eligió su inicial` : trade ? `🔁 ${c.username} recibió un ${name}` : `🔴 ${c.username} atrapó un ${name}`,
    description: starter ? `Empieza el viaje con ${who}.` : trade ? `Llegó ${who} por intercambio.` : `Se sumó ${who}${where}.`,
    quote,
    fields,
    thumbnail: sprite(c.species),
  };
}

const LEADERS = ['Brock', 'Misty', 'Lt. Surge', 'Erika', 'Koga', 'Sabrina', 'Blaine', 'Giovanni'];
const BADGE_BY_GYM = [
  ['Brock y sus piedras ya son historia.', 'La primera siempre es especial.', 'Empezó el viaje en serio.'],
  ['Misty se quedó sin agua.', 'El Starmie de Misty esta vez no pudo.', 'Dos de ocho. Va tomando forma.'],
  ['El teniente quedó sin corriente.', 'Ni el Raichu de Surge lo paró.', 'Tres medallas: huele a torneo.'],
  ['Erika se despertó de la siesta para perder.', 'Podó el gimnasio entero.', 'Mitad de camino.'],
  ['Koga y sus venenos, superados.', 'Ni el Tóxico lo frenó.', 'Cinco. Ya se ve la Liga a lo lejos.'],
  ['Sabrina no lo vio venir, y eso que es psíquica.', 'Mente sobre materia: ganó la materia.', 'Seis medallas: huele a torneo.'],
  ['Blaine se quemó solo.', 'Apagó el volcán.', 'Falta una sola.'],
  ['Giovanni cerró el gimnasio y se fue a su casa.', 'El Equipo Rocket despega otra vez.', 'Las ocho. A la Liga.'],
];
const BADGE_ANY = ['¡A pulirla!', 'Una menos.', 'Se viene, se viene.', 'Los rivales ya pueden ir preocupándose.'];

export function badgeCard(username: string, n: number, count: number): Card {
  return {
    color: GOLD,
    title: `🏅 ${username} ganó la Medalla ${BADGES[n - 1]}`,
    description: `Venció a **${LEADERS[n - 1]}** en el gimnasio ${n}.`,
    quote: pick([...BADGE_BY_GYM[n - 1], pick(BADGE_ANY)]),
    fields: [{ name: 'Medallas', value: '🏅'.repeat(count) + '▫️'.repeat(Math.max(0, 8 - count)) + `  (${count}/8)` }],
  };
}

export function championCard(username: string): Card {
  return {
    color: PURPLE,
    title: `👑 ${username} es el nuevo Campeón`,
    description: `**${username}** venció al Alto Mando y al Campeón de la Liga Pokémon.`,
    quote: pick([
      'Al Salón de la Fama, con los que quedaron vivos.',
      'Lo logró. Contra todo pronóstico.',
      'Que alguien le avise al profesor Oak.',
      'Inclínense ante su majestad.',
      'El resto puede ir sacando apuntes.',
    ]),
  };
}

export function tournamentCard(n: number, names: string[]): Card {
  return {
    color: BLUE,
    title: `⚔️ ¡Torneo de las ${n} medallas!`,
    description: `Todos llegaron a las **${n} medallas**. Toca pelear entre ustedes.`,
    quote: pick([
      'Se acabó la amistad.',
      'Que gane el menos manco.',
      'Afilen los colmillos.',
      'Acá se ve quién entrenó y quién farmeó Rattatas.',
      'Hagan sus apuestas.',
    ]),
    fields: [{ name: 'Participantes', value: names.map((x) => `• ${x}`).join('\n').slice(0, 1000) }],
  };
}

export function resetCard(username: string): Card {
  return {
    color: GRAY,
    title: `🔄 ${username} reinició su partida`,
    description: 'Borrón y cuenta nueva: se fueron la partida, las bajas y las medallas.',
    quote: pick([
      'Esta vez sí. (Dice.)',
      'El que se rinde y vuelve a empezar, técnicamente no perdió.',
      'Pueblo Paleta lo recibe otra vez.',
      'Mamá ya le había guardado la pieza.',
      'A elegir inicial de nuevo.',
    ]),
  };
}

export function appealCard(username: string, reason: string): Card {
  return {
    color: BLUE,
    title: `🙋 ${username} pide anular un evento`,
    description: reason ? `Motivo: “${plain(reason)}”` : 'No dio motivo.',
    quote: pick([
      'Lo decide el líder de la sala. Sin presión.',
      'Señor juez, mi cliente es inocente.',
      'Llamen al VAR.',
      'A ver qué excusa trae esta vez.',
    ]),
  };
}

export function appealResultCard(username: string, approved: boolean): Card {
  return approved
    ? {
        color: GREEN,
        title: `✅ Anulación aprobada para ${username}`,
        description: 'El evento se borró del historial.',
        quote: pick(['Zafó.', 'El VAR le dio la razón.', 'Se hizo justicia. O algo parecido.', 'Esta vez pasa.']),
      }
    : {
        color: RED,
        title: `🚫 Anulación rechazada para ${username}`,
        description: 'La baja se queda donde está.',
        quote: pick(['Siga, siga.', 'El VAR no vio nada raro.', 'Buen intento.', 'A llorar al Centro Pokémon.']),
      };
}

export function connectedCard(room: string): Card {
  return {
    color: GREEN,
    title: '🎮 WabGBA conectado',
    description: `Este canal ahora recibe los avisos de la sala **${room}**: bajas, medallas, torneos y anulaciones.`,
    quote: 'Que empiece el sufrimiento.',
  };
}
