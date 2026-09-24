import type { Vector3 } from 'three';
import type { SfxEvent, SfxKind } from '../sim/events';

type Ctx = AudioContext;

interface Layer {
  gain: GainNode;
  target: number;
}

/**
 * All sound is synthesized with WebAudio — no asset files, no licensing questions.
 * Ambient layers crossfade with time of day, weather and camera position; one-shots
 * are attenuated and panned relative to the camera.
 */
export class AudioSystem {
  private ctx: Ctx | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private noise: Record<'white' | 'pink' | 'brown', AudioBuffer> | null = null;
  private layers: Record<string, Layer> = {};
  private volume = 0.7;
  private muted = false;
  private lastPlay = new Map<SfxKind, number>();
  private active = new Map<SfxKind, number>();
  private birdTimer = 2;
  private cricketTimer = 0;
  private crackleTimer = 0;
  private listener = { x: 0, z: 0, dist: 40, rightX: 1, rightZ: 0 };
  private ambient = { daylight: 1, rain: 0, oceanNear: 0.5, fire: 0, height: 40, trees: 0.5 };

  get ready(): boolean {
    return this.ctx !== null;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.ambBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.ambBus.connect(this.master);
    this.applyVolume();
    this.noise = { white: this.makeNoise('white'), pink: this.makeNoise('pink'), brown: this.makeNoise('brown') };
    this.buildLayers();
  }

  setVolume(v: number): void {
    this.volume = v;
    this.applyVolume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolume();
  }

  private applyVolume(): void {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume * 0.9, this.ctx.currentTime, 0.1);
  }

  private makeNoise(kind: 'white' | 'pink' | 'brown'): AudioBuffer {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w * 0.5;
      else if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.2;
      }
    }
    return buf;
  }

  private loopSource(kind: 'white' | 'pink' | 'brown'): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise![kind];
    s.loop = true;
    s.loopStart = Math.random();
    s.start(0, Math.random() * 2);
    return s;
  }

  private buildLayers(): void {
    const ctx = this.ctx!;
    const mk = (name: string, src: AudioNode) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(this.ambBus);
      this.layers[name] = { gain: g, target: 0 };
    };
    // Ocean: brown noise, low-passed, with slow swells.
    {
      const s = this.loopSource('brown');
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 520;
      const swell = ctx.createGain();
      swell.gain.value = 0.6;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.11;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.35;
      lfo.connect(lfoGain).connect(swell.gain);
      lfo.start();
      s.connect(lp).connect(swell);
      mk('ocean', swell);
    }
    // Wind: band-passed pink noise with a wandering centre frequency.
    {
      const s = this.loopSource('pink');
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 700;
      bp.Q.value = 0.8;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const lg = ctx.createGain();
      lg.gain.value = 300;
      lfo.connect(lg).connect(bp.frequency);
      lfo.start();
      s.connect(bp);
      mk('wind', bp);
    }
    // Rain: bright hiss.
    {
      const s = this.loopSource('white');
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1400;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 7000;
      s.connect(hp).connect(lp);
      mk('rain', lp);
    }
  }

  /** Update listener + ambience mix. Call every frame. */
  update(dt: number, focus: Vector3, camDist: number, camYaw: number, env: { daylight: number; rain: number; oceanNear: number; fire: number; trees: number }): void {
    this.listener.x = focus.x;
    this.listener.z = focus.z;
    this.listener.dist = camDist;
    this.listener.rightX = Math.cos(camYaw);
    this.listener.rightZ = -Math.sin(camYaw);
    Object.assign(this.ambient, env);
    this.ambient.height = camDist;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const hi = Math.min(1, camDist / 140);
    const set = (name: string, v: number) => {
      const l = this.layers[name];
      if (l) l.gain.gain.setTargetAtTime(v, t, 0.6);
    };
    set('ocean', 0.16 + env.oceanNear * 0.28 + hi * 0.12);
    set('wind', 0.05 + hi * 0.2 + env.rain * 0.08);
    set('rain', env.rain * 0.32);

    // Birds by day near trees; crickets at night; crackle near fire.
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 0.6 + Math.random() * 3.5 / Math.max(0.2, env.daylight * (0.4 + env.trees));
      if (env.daylight > 0.3 && env.rain < 0.4 && camDist < 120) this.bird(env.daylight * (1 - hi * 0.7));
    }
    this.cricketTimer -= dt;
    if (this.cricketTimer <= 0) {
      this.cricketTimer = 0.25 + Math.random() * 0.5;
      if (env.daylight < 0.3 && env.rain < 0.3 && camDist < 110) this.cricket((1 - env.daylight) * (1 - hi * 0.6));
    }
    this.crackleTimer -= dt;
    if (this.crackleTimer <= 0) {
      this.crackleTimer = 0.04 + Math.random() * 0.18;
      if (env.fire > 0.05) this.crackle(env.fire);
    }
  }

  // ---------------------------------------------------------------- synthesis helpers

  private env(g: GainNode, t: number, attack: number, peak: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private out(pan: number, vol: number): AudioNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = vol;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(this.sfxBus);
    return g;
  }

  private tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, t: number, attack: number, peak: number, decay: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + attack + decay);
    const g = ctx.createGain();
    this.env(g, t, attack, peak, decay);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  private noiseBurst(dest: AudioNode, kind: 'white' | 'pink' | 'brown', filter: BiquadFilterType, freq: number, q: number, t: number, attack: number, peak: number, decay: number, freqEnd?: number): void {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise![kind];
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + decay);
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, attack, peak, decay);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random() * 2);
    s.stop(t + attack + decay + 0.05);
  }

  private bird(vol: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this.out((Math.random() - 0.5) * 1.6, 0.05 * vol);
    const base = 2200 + Math.random() * 1800;
    const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const st = t + i * (0.08 + Math.random() * 0.06);
      this.tone(out, 'sine', base * (1 + Math.random() * 0.3), base * (0.7 + Math.random() * 0.6), st, 0.01, 0.8, 0.07 + Math.random() * 0.05);
    }
  }

  private cricket(vol: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this.out((Math.random() - 0.5) * 1.8, 0.018 * vol);
    const f = 4200 + Math.random() * 600;
    for (let i = 0; i < 3; i++) this.tone(out, 'sine', f, f, t + i * 0.045, 0.005, 1, 0.03);
  }

  private crackle(amount: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this.out((Math.random() - 0.5) * 0.8, 0.12 * Math.min(1, amount));
    this.noiseBurst(out, 'white', 'bandpass', 1500 + Math.random() * 2500, 2, t, 0.002, 1, 0.03 + Math.random() * 0.04);
  }

  /** Positional one-shot for a simulation sound event. */
  play(e: SfxEvent): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const L = this.listener;
    const dx = e.x - L.x;
    const dz = e.z - L.z;
    const horiz = Math.hypot(dx, dz);
    const d = Math.hypot(horiz, L.dist * 0.55);
    const range = e.kind === 'thunder' ? 400 : e.kind === 'complete' || e.kind === 'treeFall' ? 140 : 75;
    let vol = Math.max(0, 1 - d / range);
    vol = vol * vol * (e.volume ?? 1);
    if (vol < 0.01) return;
    // Rate-limit busy sounds so 4x speed doesn't turn into noise.
    const now = this.ctx.currentTime;
    const minGap: Partial<Record<SfxKind, number>> = { chop: 0.07, gather: 0.08, hammer: 0.06, eat: 0.15, drink: 0.2, talk: 0.12, deposit: 0.1 };
    const gap = minGap[e.kind] ?? 0;
    if (gap && now - (this.lastPlay.get(e.kind) ?? -1) < gap) return;
    this.lastPlay.set(e.kind, now);
    const pan = horiz > 0.1 ? (dx * L.rightX + dz * L.rightZ) / Math.max(horiz, 12) : 0;
    const out = this.out(pan * 0.8, vol);
    const t = now + 0.005;
    const r = Math.random();
    switch (e.kind) {
      case 'chop':
        this.tone(out, 'sine', 210 + r * 40, 90, t, 0.004, 0.55, 0.12);
        this.noiseBurst(out, 'white', 'bandpass', 1800, 1.2, t, 0.002, 0.45, 0.05);
        break;
      case 'treeFall':
        this.tone(out, 'sawtooth', 120, 60, t, 0.3, 0.06, 1.0);
        this.noiseBurst(out, 'brown', 'lowpass', 300, 0.7, t + 1.35, 0.01, 1.2, 0.8);
        this.noiseBurst(out, 'pink', 'bandpass', 2400, 0.8, t + 1.3, 0.02, 0.3, 0.6);
        break;
      case 'gather':
        this.noiseBurst(out, 'pink', 'bandpass', 3000 + r * 1500, 0.9, t, 0.01, 0.22, 0.12);
        this.tone(out, 'sine', 700 + r * 200, 900, t + 0.05, 0.005, 0.08, 0.05);
        break;
      case 'eat':
        this.noiseBurst(out, 'white', 'highpass', 2500, 0.7, t, 0.003, 0.18, 0.05);
        this.noiseBurst(out, 'white', 'highpass', 2800, 0.7, t + 0.09, 0.003, 0.14, 0.04);
        break;
      case 'drink':
        this.tone(out, 'sine', 320 + r * 60, 700, t, 0.01, 0.2, 0.09);
        break;
      case 'hammer':
        this.tone(out, 'triangle', 420 + r * 90, 260, t, 0.002, 0.45, 0.07);
        this.noiseBurst(out, 'white', 'bandpass', 3200, 2, t, 0.001, 0.3, 0.03);
        break;
      case 'build':
      case 'deposit':
        this.tone(out, 'sine', 150, 90, t, 0.005, 0.35, 0.12);
        break;
      case 'complete': {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => this.tone(out, 'sine', f, f, t + i * 0.11, 0.01, 0.25, 0.6));
        notes.forEach((f, i) => this.tone(out, 'triangle', f * 2, f * 2, t + i * 0.11, 0.01, 0.05, 0.4));
        break;
      }
      case 'thunder': {
        const delay = Math.min(1.2, horiz / 340);
        this.noiseBurst(out, 'white', 'highpass', 900, 0.5, t + delay * 0.2, 0.003, 1.1, 0.35);
        this.noiseBurst(out, 'brown', 'lowpass', 180, 0.6, t + delay, 0.08, 1.4, 3.2, 60);
        this.noiseBurst(out, 'pink', 'lowpass', 500, 0.5, t + delay + 0.1, 0.2, 0.5, 2.4, 120);
        break;
      }
      case 'ignite':
        this.noiseBurst(out, 'pink', 'bandpass', 400, 1, t, 0.15, 0.6, 0.7, 2500);
        break;
      case 'splash':
        this.noiseBurst(out, 'white', 'bandpass', 1200, 1, t, 0.01, 0.4, 0.2, 400);
        break;
      case 'heal': {
        const base = 660;
        for (let i = 0; i < 5; i++) this.tone(out, 'sine', base * Math.pow(1.26, i), base * Math.pow(1.26, i) * 1.01, t + i * 0.07, 0.02, 0.18, 0.9);
        break;
      }
      case 'bless': {
        const scale = [784, 988, 1175, 1568, 1976];
        scale.forEach((f, i) => this.tone(out, 'triangle', f, f, t + i * 0.06, 0.005, 0.14, 0.5));
        this.noiseBurst(out, 'white', 'highpass', 6000, 0.5, t, 0.2, 0.08, 0.6);
        break;
      }
      case 'talk': {
        // Cute gibberish: a few quick blips at speaking pitch.
        const base = 260 + r * 180;
        const n = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) {
          const f = base * (0.85 + Math.random() * 0.4);
          this.tone(out, 'square', f, f * (0.9 + Math.random() * 0.2), t + i * 0.085, 0.005, 0.045, 0.05);
        }
        break;
      }
      case 'death':
        this.tone(out, 'sine', 220, 110, t, 0.2, 0.25, 1.8);
        this.tone(out, 'sine', 330, 165, t + 0.1, 0.2, 0.12, 1.6);
        break;
      case 'yelp':
        this.tone(out, 'triangle', 700, 1100, t, 0.01, 0.2, 0.12);
        break;
    }
    this.active.set(e.kind, (this.active.get(e.kind) ?? 0) + 1);
  }

  /** Small UI click. */
  click(): void {
    if (!this.ctx) return;
    const out = this.out(0, 0.25);
    this.tone(out, 'sine', 880, 660, this.ctx.currentTime, 0.002, 0.3, 0.05);
  }
}
