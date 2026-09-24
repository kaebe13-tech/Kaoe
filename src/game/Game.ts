import {
  ACESFilmicToneMapping,
  Color,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { World } from '../sim/World';
import { SIM_DT } from '../world/config';
import { SkyView } from '../render/SkyView';
import { LightingRig } from '../render/LightingRig';
import { CameraController } from '../input/CameraController';
import { raycastTerrain, screenRay } from '../input/picking';
import { WorldSession } from './WorldSession';
import { Emitter } from '../core/events';

export type Speed = 0 | 1 | 2 | 4;
export type Tool = 'select' | 'lightning' | 'rain' | 'bless' | 'heal';

export interface GameEvents {
  select: number | null;
  speed: Speed;
  tool: Tool;
  session: WorldSession;
  frame: number;
}

const MAX_STEPS_PER_FRAME = 40;

/**
 * Owns the renderer, camera, input and the current world session, and runs the
 * fixed-timestep simulation loop with interpolated rendering.
 */
export class Game {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly sky = new SkyView();
  readonly lighting = new LightingRig();
  readonly controls: CameraController;
  readonly events = new Emitter<GameEvents>();
  session: WorldSession;

  speed: Speed = 1;
  private lastSpeed: Speed = 1;
  tool: Tool = 'select';
  selectedId: number | null = null;
  hoveredId: number | null = null;
  /** Extra multiplier for debugging (8x, 16x...). */
  debugSpeed = 1;
  private acc = 0;
  private last = performance.now();
  private realTime = 0;
  fps = 60;
  frameMs = 0;
  simMsFrame = 0;
  stepsLastFrame = 0;
  private readonly mouse = { x: -1, y: -1, inside: false };

  constructor(private readonly container: HTMLElement, seed: number) {
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.domElement.id = 'world-canvas';
    container.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.3, 2400);
    this.scene.background = new Color(0x88bbee);
    this.scene.add(this.sky.mesh, ...this.lighting.objects);
    this.scene.fog = this.lighting.fog;

    const world = new World(seed);
    world.spawnTribe(6);
    this.session = new WorldSession(world, this.scene, this.camera);
    this.session.effects.onFlash = (k) => this.onFlash?.(k);
    this.controls = new CameraController(this.camera, this.renderer.domElement, world.terrain);
    this.frameStart();

    window.addEventListener('resize', this.onResize);
    const dom = this.renderer.domElement;
    dom.addEventListener('pointermove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.inside = true;
    });
    dom.addEventListener('pointerleave', () => (this.mouse.inside = false));
    dom.addEventListener('click', this.onClick);
    dom.addEventListener('dblclick', this.onDoubleClick);
  }

  get world(): World {
    return this.session.world;
  }

  /** Frame the camera on the tribe at the start of a world. */
  private frameStart(): void {
    const w = this.world;
    this.controls.follow = null;
    this.controls.jumpTo(w.start.x, w.start.z, 34);
    this.controls.yaw = Math.atan2(w.start.x, w.start.z) + 0.5;
    this.controls.pitch = 0.62;
    this.controls.snap();
  }

  replaceWorld(world: World): void {
    this.select(null);
    this.session.dispose();
    this.session = new WorldSession(world, this.scene, this.camera);
    this.controls.terrain = world.terrain;
    this.acc = 0;
    this.frameStart();
    this.events.emit('session', this.session);
  }

  setSpeed(s: Speed): void {
    if (s !== 0) this.lastSpeed = s;
    this.speed = s;
    this.events.emit('speed', s);
  }

  togglePause(): void {
    this.setSpeed(this.speed === 0 ? this.lastSpeed : 0);
  }

  setTool(t: Tool): void {
    this.tool = t;
    this.events.emit('tool', t);
  }

  select(id: number | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    if (id === null && this.controls.follow) this.controls.follow = null;
    this.events.emit('select', id);
  }

  follow(id: number | null): void {
    if (id === null) {
      this.controls.follow = null;
      return;
    }
    this.controls.follow = () => this.session.humans.positionOf(id) ?? null;
    if (this.controls.distance > 30) this.controls.distance = 22;
  }

  get following(): boolean {
    return this.controls.follow !== null;
  }

  /** Nearest visible human to a screen point (generous hit area). */
  pickHuman(clientX: number, clientY: number, radiusPx = 26): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    let best: number | null = null;
    let bestD = Infinity;
    const v = new Vector3();
    for (const a of this.world.agents) {
      const p = this.session.humans.positionOf(a.id);
      if (!p) continue;
      v.set(p.x, p.y + 0.6, p.z).project(this.camera);
      if (v.z > 1) continue;
      const sx = rect.left + ((v.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - v.y) / 2) * rect.height;
      const d = Math.hypot(sx - clientX, sy - clientY);
      const dist = this.camera.position.distanceTo(p);
      const r = radiusPx + 900 / Math.max(dist, 8);
      if (d < r && d < bestD) {
        bestD = d;
        best = a.id;
      }
    }
    return best;
  }

  pickGround(clientX: number, clientY: number): Vector3 | null {
    return raycastTerrain(screenRay(this.camera, this.renderer.domElement, clientX, clientY), this.world.terrain);
  }

  /** Lightning flash hook (UI overlay + camera shake). */
  onFlash: ((strength: number) => void) | null = null;

  /** Hook for god powers; set by the powers module. */
  onGroundClick: ((p: Vector3, humanId: number | null) => void) | null = null;

  private onClick = (e: MouseEvent) => {
    if (this.controls.wasDrag) return;
    const human = this.pickHuman(e.clientX, e.clientY);
    if (this.tool === 'select') {
      this.select(human);
      return;
    }
    const p = this.pickGround(e.clientX, e.clientY);
    if (p && this.onGroundClick) this.onGroundClick(p, human);
  };

  private onDoubleClick = (e: MouseEvent) => {
    if (this.tool !== 'select') return;
    const human = this.pickHuman(e.clientX, e.clientY);
    if (human !== null) {
      this.select(human);
      this.follow(human);
    }
  };

  private onResize = () => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  start(): void {
    this.last = performance.now();
    this.renderer.setAnimationLoop(this.frame);
  }

  stop(): void {
    this.renderer.setAnimationLoop(null);
  }

  /** Advance the simulation by a fixed amount of game time (used by tests/debug). */
  advance(seconds: number): void {
    const steps = Math.round(seconds / SIM_DT);
    for (let i = 0; i < steps; i++) this.session.sim.step(SIM_DT);
    // Don't dump a backlog of effects spawned while skipping ahead.
    this.session.effects.soft.clear();
    this.session.effects.glow.clear();
  }

  /** Frames rendered so far (tests wait on this). */
  frameCount = 0;

  /**
   * Advance simulation time for one frame of real time, honouring the speed setting.
   * Returns the number of fixed steps taken.
   */
  stepSim(realDt: number): number {
    const sim = this.session.sim;
    let steps = 0;
    if (this.speed > 0) {
      this.acc += realDt * this.speed * this.debugSpeed;
      const maxSteps = MAX_STEPS_PER_FRAME * Math.max(1, this.debugSpeed);
      while (this.acc >= SIM_DT && steps < maxSteps) {
        sim.step(SIM_DT);
        this.acc -= SIM_DT;
        steps++;
      }
      if (steps >= maxSteps) this.acc = Math.min(this.acc, SIM_DT);
    }
    return steps;
  }

  private frame = (now: number) => {
    // Clamp long frames (tab switches, hitches) so the simulation never jumps wildly.
    const realDt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.realTime += realDt;
    this.frameCount++;
    this.fps = this.fps * 0.95 + (1 / Math.max(realDt, 1e-3)) * 0.05;
    const t0 = performance.now();

    const steps = this.stepSim(realDt);
    this.stepsLastFrame = steps;
    this.simMsFrame = performance.now() - t0;
    const alpha = this.speed > 0 ? this.acc / SIM_DT : 1;

    // Hover feedback.
    if (this.mouse.inside && this.tool === 'select') {
      this.hoveredId = this.pickHuman(this.mouse.x, this.mouse.y);
    } else this.hoveredId = null;

    this.controls.update(realDt);
    this.renderWorld(alpha, realDt);
    this.frameMs = performance.now() - t0;
    this.events.emit('frame', realDt);
  };

  private renderWorld(alpha: number, dt: number): void {
    const s = this.session;
    const w = s.world;
    const rainHere = w.rainAt(this.controls.focus.x, this.controls.focus.z);
    const overcast = Math.min(1, Math.max(rainHere, w.weather.anyRain * 0.35));
    const look = this.lighting.update(w.hour, this.controls.focus, overcast);
    const su = this.sky.material.uniforms;
    su.uZenith!.value.copy(look.zenith);
    su.uHorizon!.value.copy(look.horizon);
    su.uGround!.value.copy(look.ground);
    su.uSunDir!.value.copy(look.sunDir);
    su.uSunColor!.value.copy(look.sunColor);
    su.uSunVis!.value = look.sunVisible;
    su.uMoonDir!.value.copy(look.moonDir);
    su.uStarVis!.value = look.starVisible;
    su.uTime!.value = this.realTime;
    su.uCloudy!.value = overcast;
    this.sky.mesh.position.copy(this.camera.position);
    (this.scene.background as Color).copy(look.horizon);

    s.terrainView.uniforms.uTime.value = this.realTime;
    s.terrainView.uniforms.uWet.value += (rainHere - s.terrainView.uniforms.uWet.value) * Math.min(1, dt * 0.5);
    const amb = look.hemiSky.clone().multiplyScalar(look.hemiIntensity * 0.55);
    s.water.setLook({ skyHorizon: look.horizon, skyZenith: look.zenith, sunDir: look.lightDir, sunColor: look.sunColor.clone().multiplyScalar(look.sunIntensity / 2.5), ambient: amb });
    s.vegetation.update(dt, this.realTime);
    s.clouds.update(dt, look.sunColor, look.darkness, overcast);
    s.structures.animate(this.realTime, look.darkness, (id) => w.agents.filter((a) => a.inside === id && a.alive).length);
    s.humans.update(w.agents, alpha, dt, this.speed === 0);
    s.effects.update(dt, this.speed > 0 ? dt * this.speed * this.debugSpeed : 0, this.realTime, this.controls.focus, this.controls.currentDistance, look.darkness);
    const sel = this.selectedId !== null ? w.agent(this.selectedId) ?? null : null;
    const hov = this.hoveredId !== null ? w.agent(this.hoveredId) ?? null : null;
    s.selection.update(this.realTime, sel, sel ? s.humans.positionOf(sel.id) : null, hov, hov ? s.humans.positionOf(hov.id) : null);
    s.updateWear(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
