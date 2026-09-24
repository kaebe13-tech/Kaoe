import type { Rng } from '../core/rng';

const NAMES = [
  'Aru', 'Bela', 'Cato', 'Dara', 'Eni', 'Faro', 'Gia', 'Hano', 'Ila', 'Juno', 'Kai', 'Lio', 'Mira', 'Nilo',
  'Oren', 'Pia', 'Rua', 'Sena', 'Taro', 'Ula', 'Vesa', 'Wren', 'Yara', 'Zeph', 'Ansa', 'Bram', 'Cira', 'Dov',
  'Elin', 'Fen', 'Gael', 'Hesta', 'Ivo', 'Jora', 'Kesi', 'Lumi', 'Maro', 'Nia', 'Odo', 'Pell', 'Quin', 'Rhea',
  'Sol', 'Tove', 'Uri', 'Veda', 'Wyn', 'Ysa', 'Zan', 'Asha', 'Bodi', 'Coro', 'Edda', 'Fia', 'Hale', 'Isla',
  'Jem', 'Kora', 'Lark', 'Moss', 'Nova', 'Opal', 'Pim', 'Rook', 'Sage', 'Tamsin', 'Umi', 'Vale', 'Willa',
  'Yori', 'Zuri', 'Anko', 'Brisa', 'Emeka', 'Iko', 'Lune', 'Meri', 'Noor', 'Oska', 'Ren', 'Suvi', 'Tiko',
];

const A = ['Ka', 'Mi', 'Ta', 'Lo', 'Re', 'Na', 'Si', 'O', 'Be', 'Da', 'E', 'Fe', 'Ha', 'I', 'Ju', 'Ke', 'Li', 'Ma', 'No', 'Pa', 'Ra', 'Sa', 'Te', 'U', 'Va', 'Wi', 'Ya', 'Zo'];
const B = ['', 'la', 'ri', 'no', 'ka', 'mi', 're', 'sa', 'to', 'na', 'vi', 'lu'];
const C = ['', 'n', 'a', 'o', 'i', 'el', 'an', 'ra', 'ko', 'ss', 'ia'];

export function makeName(rng: Rng, taken: Set<string>): string {
  const pool = NAMES.filter((n) => !taken.has(n));
  if (pool.length && rng.chance(0.85)) return rng.pick(pool);
  for (let i = 0; i < 50; i++) {
    const n = rng.pick(A) + rng.pick(B) + rng.pick(C);
    if (n.length >= 3 && n.length <= 7 && !taken.has(n)) return n;
  }
  return `${rng.pick(NAMES)} ${taken.size}`;
}
