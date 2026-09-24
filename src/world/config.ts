/** World-scale constants shared by simulation and rendering. */
export const WORLD_SIZE = 640; // square extent in world units, centered at origin
export const WORLD_HALF = WORLD_SIZE / 2;
export const HEIGHT_RES = 513; // heightmap samples per side (1.25 m spacing)
export const SEA_LEVEL = 0;
/** Rough radius of the main continent (used for weather and coarse placement). */
export const LAND_RADIUS = 270;
/** @deprecated kept for older call sites; the world is a continent now. */
export const ISLAND_RADIUS = LAND_RADIUS;

/** Real seconds per in-game day at 1x speed. */
export const DAY_LENGTH = 480;
export const HOUR = DAY_LENGTH / 24;
/** Fixed simulation step in game seconds. */
export const SIM_DT = 0.05;

/** Coarse grid used for territory, civilization maps and exploration (16 m cells). */
export const MAP_CELL = 16;
export const MAP_N = WORLD_SIZE / MAP_CELL;
