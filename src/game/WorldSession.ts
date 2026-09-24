import { Group, type Camera, type DataTexture, type Scene } from 'three';
import { World } from '../sim/World';
import { Simulation } from '../sim/Simulation';
import { TerrainView, makeHeightTexture, makeWearTexture } from '../render/TerrainView';
import { WaterView } from '../render/WaterView';
import { VegetationView } from '../render/VegetationView';
import { StructureView } from '../render/StructureView';
import { HumanView } from '../render/HumanView';
import { CloudView } from '../render/CloudView';
import { EffectsView } from '../render/EffectsView';
import { SelectionView } from '../render/SelectionView';
import { BirdView } from '../render/BirdView';
import { WORLD_SIZE } from '../world/config';

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
  readonly wearTex: DataTexture;
  private wearTimer = 0;
  private readonly unsubs: Array<() => void> = [];

  constructor(
    readonly world: World,
    private readonly scene: Scene,
    camera: Camera,
  ) {
    this.sim = new Simulation(world);
    const heightTex = makeHeightTexture(world.terrain);
    this.wearTex = makeWearTexture(WORLD_SIZE);
    this.terrainView = new TerrainView(world.terrain, heightTex, this.wearTex);
    this.water = new WaterView(world.terrain, this.terrainView.uniforms);
    this.vegetation = new VegetationView(world.terrain, [...world.resources.values()], this.terrainView.uniforms.uWearTex);
    this.structures = new StructureView(world.terrain);
    this.humans = new HumanView(world.terrain);
    this.clouds = new CloudView(world.seed);
    this.effects = new EffectsView(world, world.terrain, this.vegetation, camera);
    this.selection = new SelectionView(world.terrain);
    this.birds = new BirdView(world.seed);
    this.root.add(this.terrainView.mesh, this.water.group, this.vegetation.group, this.structures.group, this.humans.group, this.clouds.group, this.effects.group, this.selection.group, this.birds.group);
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
    );
    this.uploadWear();
  }

  /** Push the foot-traffic map to the GPU now and then (it changes slowly). */
  updateWear(dt: number): void {
    this.wearTimer += dt;
    if (this.wearTimer < 0.5 || !this.world.wearDirty) return;
    this.wearTimer = 0;
    this.uploadWear();
  }

  private uploadWear(): void {
    const data = this.wearTex.image.data as Float32Array;
    data.set(this.world.wear);
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
