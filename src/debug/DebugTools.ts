import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments, Points, PointsMaterial, Vector3 } from 'three';
import type { Game } from '../game/Game';
import { lastThink } from '../ai/Brain';
import { h, escapeHtml } from '../ui/dom';
import { HOUR } from '../world/config';
import { kill } from '../sim/needs';
import { currentAction } from '../ai/brainCore';

/**
 * Developer overlay (F3 / backquote): performance counters, AI decision scores above heads,
 * path lines, nav grid, and a few cheats for testing. Invisible in normal play.
 */
export class DebugTools {
  private readonly panel = h('div.debug.glass');
  private readonly stats = h('div.cols');
  private readonly aiLayer = h('div.labels');
  private readonly aiLabels = new Map<number, HTMLElement>();
  private on = false;
  private showAI = true;
  private showPaths = true;
  private showNav = false;
  private readonly pathLines: LineSegments;
  private readonly navPoints: Points;
  private navTimer = 0;
  private statTimer = 0;

  constructor(private readonly game: Game) {
    const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = get();
      cb.onchange = () => set(cb.checked);
      return h('label', {}, [cb, label]);
    };
    const btn = (label: string, fn: () => void) => h('button', { onclick: fn }, label);
    this.panel.append(
      this.stats,
      h('div', { style: 'margin-top:6px' }, [
        toggle('AI scores', () => this.showAI, (v) => (this.showAI = v)),
        toggle('Paths', () => this.showPaths, (v) => (this.showPaths = v)),
        toggle('Nav grid', () => this.showNav, (v) => (this.showNav = v)),
      ]),
      h('div.btns', {}, [
        btn('×8 speed', () => (game.debugSpeed = game.debugSpeed === 8 ? 1 : 8)),
        btn('×16', () => (game.debugSpeed = game.debugSpeed === 16 ? 1 : 16)),
        btn('+1 hour', () => game.advance(HOUR)),
        btn('+1 day', () => game.advance(HOUR * 24)),
        btn('Spawn human', () => {
          const f = game.controls.focus;
          const p = game.world.nav.nearestWalkable(f.x, f.z, 10);
          if (p) game.world.spawnAgent(p.x, p.z);
        }),
        btn('Starve sel.', () => this.withSelected((a) => (a.needs.hunger = 0.08))),
        btn('Tire sel.', () => this.withSelected((a) => (a.needs.energy = 0.08))),
        btn('Hurt sel.', () => this.withSelected((a) => (a.needs.health = 0.3))),
        btn('Kill sel.', () => this.withSelected((a) => kill(a, game.world, 'exhaustion'))),
        btn('Storm', () => {
          const f = game.controls.focus;
          game.world.weather.summon(f.x, f.z, false, 70, HOUR * 2, 0.85);
        }),
        btn('Reveal food', () => {
          const w = game.world;
          for (const a of w.agents)
            for (const r of w.resources.values())
              if (r.kind === 'berryBush' || r.kind === 'fruitTree') a.memory.rememberResource({ id: r.id, kind: r.kind, x: r.x, z: r.z, amount: r.amount, seenAt: w.time, source: 'told' });
        }),
      ]),
    );
    document.body.append(this.aiLayer, this.panel);
    this.aiLayer.style.zIndex = '9';
    this.aiLayer.style.position = 'fixed';

    this.pathLines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x7cf0ff, transparent: true, opacity: 0.8, depthTest: false }));
    this.pathLines.frustumCulled = false;
    this.pathLines.renderOrder = 30;
    this.navPoints = new Points(new BufferGeometry(), new PointsMaterial({ color: new Color(0xff4d4d), size: 0.35, depthTest: false }));
    this.navPoints.frustumCulled = false;
    this.navPoints.renderOrder = 30;
    game.scene.add(this.pathLines, this.navPoints);
    this.setOn(false);
  }

  private withSelected(fn: (a: NonNullable<ReturnType<Game['world']['agent']>>) => void): void {
    const a = this.game.world.agent(this.game.selectedId);
    if (a && a.alive) fn(a);
  }

  toggle(): void {
    this.setOn(!this.on);
  }

  private setOn(v: boolean): void {
    this.on = v;
    this.panel.classList.toggle('on', v);
    this.aiLayer.style.display = v ? '' : 'none';
    this.pathLines.visible = v;
    this.navPoints.visible = v;
  }

  update(dt: number): void {
    if (!this.on) return;
    const g = this.game;
    const w = g.world;
    this.statTimer -= dt;
    if (this.statTimer <= 0) {
      this.statTimer = 0.25;
      const info = g.renderer.info;
      const ps = w.paths.finder.stats;
      const fx = g.session.effects;
      const trees = [...w.resources.values()].filter((r) => r.kind === 'tree');
      const grown = trees.filter((r) => r.state === 'grown').length;
      const bushes = [...w.resources.values()].filter((r) => r.kind === 'berryBush');
      const berries = bushes.reduce((s, r) => s + (r.state === 'grown' ? r.amount : 0), 0);
      const stuck = w.stuckLog.filter((s) => w.time - s.time < 60).length;
      const rows = [
        `FPS ${g.fps.toFixed(0)}`,
        `frame ${g.frameMs.toFixed(1)} ms`,
        `sim ${g.simMsFrame.toFixed(2)} ms (${g.stepsLastFrame} steps)`,
        `agents ${w.living.length}/${w.agents.length}`,
        `draw calls ${info.render.calls}`,
        `tris ${(info.render.triangles / 1000).toFixed(0)}k`,
        `paths ${ps.searches} (fail ${ps.failures})`,
        `path avg ${(w.paths.msTotal / Math.max(1, w.paths.solvedTotal)).toFixed(2)} ms`,
        `path queue ${w.paths.pending}`,
        `trees ${grown}/${trees.length}`,
        `berries ${berries} on ${bushes.length}`,
        `structures ${w.structures.length}`,
        `particles ${fx.soft.live + fx.glow.live}`,
        `speed ×${g.speed * g.debugSpeed}`,
        `<span class="${stuck ? 'warn' : ''}">stuck/min ${stuck}</span>`,
        `dangers ${w.dangers.length}`,
        `rain clouds ${w.weather.clouds.length}`,
        `day ${w.day} ${w.clockString()}`,
      ];
      this.stats.innerHTML = rows.map((r) => `<span>${r}</span>`).join('');
    }
    this.updateAILabels();
    this.updatePaths();
    this.navTimer -= dt;
    if (this.navTimer <= 0) {
      this.navTimer = 0.5;
      this.updateNav();
    }
  }

  private updateAILabels(): void {
    const g = this.game;
    const w = g.world;
    const rect = g.renderer.domElement.getBoundingClientRect();
    const v = new Vector3();
    for (const a of w.agents) {
      let el = this.aiLabels.get(a.id);
      const p = g.session.humans.positionOf(a.id);
      if (!p || !this.showAI || !a.alive) {
        if (el) el.style.display = 'none';
        continue;
      }
      if (!el) {
        el = h('div', { style: 'position:absolute;left:0;top:0;font:10.5px ui-monospace,monospace;color:#dff;background:rgba(0,0,0,.6);padding:3px 5px;border-radius:5px;white-space:pre;pointer-events:none;line-height:1.3' });
        this.aiLayer.append(el);
        this.aiLabels.set(a.id, el);
      }
      v.set(p.x, p.y + 2.3, p.z).project(g.camera);
      const dist = g.camera.position.distanceTo(p);
      if (v.z > 1 || dist > 70) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      const x = rect.left + ((v.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - v.y) / 2) * rect.height;
      el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -100%)`;
      const t = lastThink.get(a.id);
      const act = a.brain.active;
      const step = currentAction(a);
      const top = t ? [...t.candidates].sort((x1, y1) => y1.score - x1.score).slice(0, 3) : [];
      const lines = [
        `${a.name} [${a.anim}] nav:${a.nav.status}`,
        `▶ ${act ? `${act.goal} ${act.score.toFixed(2)}` : '-'} › ${step ? step.label : '-'}`,
        ...top.map((c) => `  ${c.goal.padEnd(9)} ${c.score.toFixed(2)} ${c.urgent ? '!' : ''}`),
      ];
      el.textContent = lines.join('\n');
      void escapeHtml;
    }
  }

  private updatePaths(): void {
    const w = this.game.world;
    const pts: number[] = [];
    if (this.showPaths) {
      for (const a of w.agents) {
        if (!a.alive || a.nav.status !== 'moving') continue;
        let px = a.x;
        let pz = a.z;
        for (let i = a.nav.idx; i < a.nav.path.length; i++) {
          const q = a.nav.path[i]!;
          pts.push(px, w.terrain.heightAt(px, pz) + 0.3, pz, q.x, w.terrain.heightAt(q.x, q.z) + 0.3, q.z);
          px = q.x;
          pz = q.z;
        }
      }
    }
    const geo = this.pathLines.geometry;
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    geo.computeBoundingSphere();
  }

  private updateNav(): void {
    const w = this.game.world;
    const f = this.game.controls.focus;
    const pts: number[] = [];
    if (this.showNav) {
      const r = 30;
      for (let z = Math.floor(f.z - r); z < f.z + r; z++) {
        for (let x = Math.floor(f.x - r); x < f.x + r; x++) {
          const cx = w.nav.cellX(x + 0.5);
          const cz = w.nav.cellZ(z + 0.5);
          if (!w.nav.inside(cx, cz)) continue;
          if (!w.nav.walkableCell(cx, cz)) {
            const wx = w.nav.toWorld(cx);
            const wz = w.nav.toWorld(cz);
            const h0 = w.terrain.heightAt(wx, wz);
            if (h0 > -0.5) pts.push(wx, Math.max(h0, 0) + 0.15, wz);
          }
        }
      }
    }
    const geo = this.navPoints.geometry;
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    geo.computeBoundingSphere();
  }
}
