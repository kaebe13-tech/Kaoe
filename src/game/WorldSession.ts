import { Color, Group, type Camera, type DataTexture, type Scene } from 'three';
import { World } from '../sim/World';
import { Simulation } from '../sim/Simulation';
import { TerrainView, makeHeightTexture, makeTerritoryTexture, makeWearTexture } from '../render/TerrainView';
import { LandmarkView } from '../render/LandmarkView';
import { LightPool } from '../render/LightPool';
import { MAP_N } from '../world/config';
import { WEAR_N } from '../sim/World';
import { WaterView } from '../render/WaterView';
import { VegetationView } from '../render/VegetationView';
import { StructureView } from '../render/StructureView';
import { HumanView } from '../render/HumanView';
import { CloudView } from '../render/CloudView';
import { EffectsView } from '../render/EffectsView';
import { SelectionView } from '../render/SelectionView';
import { BirdView } from '../render/BirdView';

/**
 * Everything tied to one world: the simulation plus the views that mirror it.
 * Replaced wholesale on New World / Load.
 */
export class WorldSession {
  readonly sim: Simulation;
  readonly root = new Group();
  readonly terrainView: TerrainView;
  readonly water: WaterView;
  readonly vegetation: VegetationView;
  readonly structures: StructureView;
  readonly humans: HumanView;
  readonly clouds: CloudView;
  readonly effects: EffectsView;
  readonly selection: SelectionView;
  readonly birds: BirdView;
  readonly landmarks: LandmarkView;
  readonly lightPool = new LightPool(4);
  readonly wearTex: DataTexture;
  readonly territoryTex: DataTexture;
  private territorySeen = -1;
  private wearTimer = 0;
  private readonly unsubs: Array<() => void> = [];

  constructor(
    readonly world: World,
    private readonly scene: Scene,
    camera: Camera,
  ) {
    this.sim = new Simulation(world);
    const heightTex = makeHeightTexture(world.terrain);
    this.wearTex = makeWearTexture(WEAR_N);
    this.territoryTex = makeTerritoryTexture();
    this.terrainView = new TerrainView(world.terrain, heightTex, this.wearTex, this.territoryTex);
    this.water = new WaterView(world.terrain, this.terrainView.uniforms);
    this.vegetation = new VegetationView(world.terrain, [...world.resources.values()], this.terrainView.uniforms.uWearTex);
    this.structures = new StructureView(world.terrain, this.lightPool, (id) => world.civs[id]?.culture);
    this.landmarks = new LandmarkView(world.terrain, this.lightPool);
    this.humans = new HumanView(world.terrain);
    this.clouds = new CloudView(world.seed);
    this.effects = new EffectsView(world, world.terrain, this.vegetation, camera);
    this.selection = new SelectionView(world.terrain);
    this.birds = new BirdView(world.seed);
    this.root.add(this.terrainView.mesh, this.water.group, this.vegetation.group, this.structures.group, this.landmarks.group, this.humans.group, this.clouds.group, this.effects.group, this.selection.group, this.birds.group, this.lightPool.group);
    this.root.name = 'world-session';
    scene.add(this.root);

    for (const s of world.structures) this.structures.add(s);
    const ev = world.events;
    this.unsubs.push(
      ev.on('resourceChanged', (r) => this.vegetation.sync(r)),
      ev.on('resourceAdded', (r) => this.vegetation.addResource(r)),
      ev.on('resourceHit', (r) => this.vegetation.poke(r.id)),
      ev.on('structureAdded', (s) => this.structures.add(s)),
      ev.on('structureChanged', (s) => this.structures.sync(s)),
      ev.on('structureRemoved', (s) => this.structures.remove(s.id)),
      ev.on('terrainChanged', (b) => {
        this.terrainView.rebuildRegion(b.x0, b.z0, b.x1, b.z1);
        this.vegetation.invalidateDecor(b.x0, b.z0, b.x1, b.z1);
        for (const p of world.terrain.ponds) this.water.addPond(p);
      }),
    );
    // Springs made in earlier sessions (replayed from the save).
    for (const p of world.terrain.ponds) this.water.addPond(p);
    this.uploadWear();
    this.uploadTerritory();
  }

  /** Push civilization borders to the terrain shader when they change. */
  uploadTerritory(): void {
    if (this.territorySeen === this.world.territoryVersion) return;
    this.territorySeen = this.world.territoryVersion;
    const data = this.territoryTex.image.data as Uint8Array;
    const c = new Color();
    for (let i = 0; i < MAP_N * MAP_N; i++) {
      const owner = this.world.territory[i]!;
      if (owner < 0) {
        data[i * 4 + 3] = 0;
        continue;
      }
      const civ = this.world.civs[owner];
      c.set(civ?.color ?? 0xffffff);
      data[i * 4] = Math.round(c.r * 255);
      data[i * 4 + 1] = Math.round(c.g * 255);
      data[i * 4 + 2] = Math.round(c.b * 255);
      data[i * 4 + 3] = owner + 1;
    }
    this.territoryTex.needsUpdate = true;
  }

  /** Push the foot-traffic map to the GPU now and then (it changes slowly). */
  updateWear(dt: number): void {
    this.wearTimer += dt;
    this.uploadTerritory();
    if (this.wearTimer < 1.5 || !this.world.wearDirty) return;
    this.wearTimer = 0;
    this.uploadWear();
  }

  private uploadWear(): void {
    const data = this.wearTex.image.data as Uint8Array;
    const src = this.world.wear;
    for (let i = 0; i < src.length; i++) data[i] = Math.min(255, Math.round(src[i]! * 255));
    this.wearTex.needsUpdate = true;
    this.world.wearDirty = false;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.effects.dispose();
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } | Array<{ dispose(): void }> };
      m.geometry?.dispose();
      if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose());
      else m.material?.dispose();
    });
    this.wearTex.dispose();
  }
}
