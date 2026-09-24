import { Color } from 'three';

/** Art-direction palette (sRGB hex). Kept in one place so the look stays coherent. */
export const PAL = {
  sandDry: 0xf0dca6,
  sandWet: 0xcfb07a,
  sandUnder: 0xc9b27c,
  seabed: 0x8fb39a,
  grassLight: 0x9bcf5a,
  grassMid: 0x74b147,
  grassDark: 0x4f8d37,
  forestFloor: 0x3f7a33,
  meadow: 0xbfd062,
  dirt: 0xa27d52,
  mud: 0x5f6b3a,
  rock: 0x9a958c,
  rockDark: 0x77726b,
  rockLight: 0xb8b2a6,
  snowish: 0xdcd8cc,

  trunk: 0x7a5232,
  trunkDark: 0x5a3b24,
  leafA: 0x5aa83f,
  leafB: 0x4a9538,
  leafC: 0x79bd4c,
  leafAutumn: 0xe0a53a,
  pine: 0x2f7050,
  pineLight: 0x3f8a5c,
  palmLeaf: 0x6cbf46,
  bush: 0x3f8c3a,
  bushLight: 0x5aa94a,
  berry: 0xd9283e,
  fruit: 0xff7a2f,
  charcoal: 0x2c2622,

  waterShallow: 0x59d8cf,
  waterMid: 0x2aa3c2,
  waterDeep: 0x17507e,
  pondShallow: 0x6fcfb0,
  pondDeep: 0x2a6f7a,
  foam: 0xf6fbff,
} as const;

export function col(hex: number): Color {
  return new Color(hex);
}
