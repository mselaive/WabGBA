// Los lugares de Rojo Fuego / Verde Hoja, por el número que el juego guarda dentro de cada
// Pokémon ("lugar de encuentro"). El orden sale del desensamblado público
// (pret/pokefirered, region_map_sections); Kanto empieza en el 88.

const FIRST = 88;

const NAMES = [
  'Pueblo Paleta', 'Ciudad Verde', 'Ciudad Plateada', 'Ciudad Celeste', 'Pueblo Lavanda',
  'Ciudad Carmín', 'Ciudad Azulona', 'Ciudad Fucsia', 'Isla Canela', 'Meseta Añil',
  'Ciudad Azafrán', 'Ruta 4', 'Ruta 10',
  ...Array.from({ length: 25 }, (_, i) => `Ruta ${i + 1}`),
  'Bosque Verde', 'Mt. Moon', 'S.S. Anne', 'Vía Subterránea', 'Vía Subterránea',
  'Cueva Diglett', 'Calle Victoria', 'Guarida Rocket', 'Silph S.A.', 'Mansión Pokémon',
  'Zona Safari', 'Liga Pokémon', 'Túnel Roca', 'Islas Espuma', 'Torre Pokémon',
  'Cueva Celeste', 'Central Energía',
  'Isla Prima', 'Isla Secunda', 'Isla Tera', 'Isla Quarta', 'Isla Inta', 'Isla Sétima', 'Isla Exta',
  'Camino Candente', 'Playa Tesoro', 'Cabo Extremo', 'Puente Unión', 'Puerto Isla Tera',
  'Archi7', 'Archi7', 'Archi7', 'Archi7',
  'Resort Magnífico', 'Laberinto Agua', 'Pradera Isla Inta', 'Pilar Recuerdo', 'Isla Aislada',
  'Camino Verde', 'Vía Acuática', 'Valle Ruinas', 'Torre Desafío', 'Entrada Cañón',
  'Cañón Sétimo', 'Ruinas Sete', 'Archi7', 'Archi7', 'Archi7',
  'Roca Ombligo', 'Monte Ascuas', 'Bosque Baya', 'Cueva Helada', 'Almacén Rocket',
  'Torre Desafío', 'Agujero Punteado', 'Cueva Perdida', 'Bosque Patrón', 'Cueva Cambiante',
  'Cámaras Sete', 'Camino Isla Tera', 'Llave Sete', 'Isla Origen',
  'Cámara Monean', 'Cámara Liptoo', 'Cámara Weepth', 'Cámara Dilford', 'Cámara Scufib',
  'Cámara Rixy', 'Cámara Viapois', 'Aguas Termales',
];

/** Lugares donde no se camina por hierba: sirve para elegir la frase. */
const CAVES = new Set([127, 131, 132, 138, 139, 141, 175, 177, 181, 183]);

/** El nombre del lugar, o '' si el número no dice nada útil (intercambio, evento, otro juego). */
export function placeName(id: number | null | undefined): string {
  if (id === 254) return 'un intercambio';
  if (id === 255) return 'un encuentro especial';
  if (typeof id !== 'number') return '';
  return NAMES[id - FIRST] ?? '';
}

export const isCave = (id: number | null | undefined) => typeof id === 'number' && CAVES.has(id);
