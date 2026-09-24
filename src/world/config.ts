/** World-scale constants shared by simulation and rendering. */
export const WORLD_SIZE = 220; // square extent in world units, centered at origin
export const WORLD_HALF = WORLD_SIZE / 2;
export const HEIGHT_RES = 257; // heightmap samples per side
export const SEA_LEVEL = 0;
export const ISLAND_RADIUS = 80;

/** Real seconds per in-game day at 1x speed. */
export const DAY_LENGTH = 480;
export const HOUR = DAY_LENGTH / 24;
/** Fixed simulation step in game seconds. */
export const SIM_DT = 0.05;
