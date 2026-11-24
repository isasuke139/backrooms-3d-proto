/**
 * Web Audio API procedural soundscape & SFX synthesizer.
 *
 * Requires zero external audio downloads, switching cleanly across Backrooms
 * levels (Level 0 fluorescent hum, Manila Room whispers, Level 1 warehouse HVAC
 * & blackouts, The Hub resonant tunnel & fans, Level 2 steam & rust pipes).
 *
 * Source: The Backrooms Wiki (Fandom) — https://backrooms.fandom.com/wiki/Backrooms_Wiki
 * License: CC-BY-SA-3.0 — https://creativecommons.org/licenses/by-sa/3.0/
 */

export class BackroomsAudio {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.ambientGain = null;
    this.sfxGain = null;
    this.activeNodes = [];
    this.currentLevelId = null;
    this.muted = false;
    this.initialized = false;
  }

  init() {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
      return true;
    }
    if (typeof window === "undefined") return false;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;

    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : 0.45;
    this.masterGain.connect(this.ctx.destination);

    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.value = 0.5;
    this.ambientGain.connect(this.masterGain);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.75;
    this.sfxGain.connect(this.masterGain);

    this.initialized = true;
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return true;
  }

  setMuted(mute) {
    this.muted = Boolean(mute);
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(
        this.muted ? 0 : 0.45,
        this.ctx.currentTime,
        0.04
      );
    }
    return this.muted;
  }

  toggleMute() {
    return this.setMuted(!this.muted);
  }

  _createNoiseBuffer(seconds = 2) {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buffer = this.ctx.createBuffer(1, len, sr);
    const data = buffer.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < len; i += 1) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.04 * white) / 1.04;
      data[i] = lastOut * 2.5;
    }
    return buffer;
  }

  _stopAmbient() {
    for (const node of this.activeNodes) {
      try {
        if (typeof node.stop === "function") node.stop();
        node.disconnect();
      } catch {
        // ignore stopped nodes
      }
    }
    this.activeNodes = [];
  }

  setLevelAmbience(levelId) {
    if (!this.init()) return;
    if (this.currentLevelId === levelId && this.activeNodes.length > 0) return;

    this._stopAmbient();
    this.currentLevelId = levelId;
    const now = this.ctx.currentTime;

    if (levelId === "level_0") {
      // Intense fluorescent 60Hz/120Hz/180Hz hum-buzz with irregular flicker LFO
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 210;
      bp.Q.value = 1.4;

      const bedGain = this.ctx.createGain();
      bedGain.gain.value = 0.22;
      bp.connect(bedGain);
      bedGain.connect(this.ambientGain);

      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      lfo.frequency.value = 7.3;
      lfoGain.gain.value = 0.045;
      lfo.connect(lfoGain);
      lfoGain.connect(bedGain.gain);
      lfo.start(now);

      for (const [freq, type, amp] of [
        [60, "sawtooth", 0.45],
        [120, "triangle", 0.35],
        [180, "sawtooth", 0.2],
      ]) {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        g.gain.value = amp;
        osc.connect(g);
        g.connect(bp);
        osc.start(now);
        this.activeNodes.push(osc, g);
      }
      this.activeNodes.push(lfo, lfoGain, bp, bedGain);
    } else if (levelId === "manila_room") {
      // Subdued Level 0 fluorescent hum bed + warm orange lamp + faint wall whispers
      const humBp = this.ctx.createBiquadFilter();
      humBp.type = "bandpass";
      humBp.frequency.value = 195;
      humBp.Q.value = 1.6;
      const humBed = this.ctx.createGain();
      humBed.gain.value = 0.085;
      humBp.connect(humBed);
      humBed.connect(this.ambientGain);
      for (const [freq, type, amp] of [
        [60, "sawtooth", 0.36],
        [120, "triangle", 0.28],
      ]) {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        g.gain.value = amp;
        osc.connect(g);
        g.connect(humBp);
        osc.start(now);
        this.activeNodes.push(osc, g);
      }

      const noise = this.ctx.createBufferSource();
      noise.buffer = this._createNoiseBuffer(3);
      noise.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 950;
      bp.Q.value = 3.5;
      const ng = this.ctx.createGain();
      ng.gain.value = 0.115;
      noise.connect(bp);
      bp.connect(ng);
      ng.connect(this.ambientGain);
      noise.start(now);

      this.activeNodes.push(humBp, humBed, noise, bp, ng);
    } else if (levelId === "level_1") {
      // Warehouse deep concrete HVAC drone + damp air hiss
      const osc = this.ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 46;
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 160;
      const g = this.ctx.createGain();
      g.gain.value = 0.25;
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.ambientGain);
      osc.start(now);

      const noise = this.ctx.createBufferSource();
      noise.buffer = this._createNoiseBuffer(3);
      noise.loop = true;
      const nLp = this.ctx.createBiquadFilter();
      nLp.type = "lowpass";
      nLp.frequency.value = 380;
      const ng = this.ctx.createGain();
      ng.gain.value = 0.16;
      noise.connect(nLp);
      nLp.connect(ng);
      ng.connect(this.ambientGain);
      noise.start(now);

      this.activeNodes.push(osc, lp, g, noise, nLp, ng);
    } else if (levelId === "the_hub") {
      // Subterranean resonant hum with pitch drift + cooling fan grid wind
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 72;
      const driftLfo = this.ctx.createOscillator();
      driftLfo.frequency.value = 0.08;
      const driftAmt = this.ctx.createGain();
      driftAmt.gain.value = 6.0;
      driftLfo.connect(driftAmt);
      driftAmt.connect(osc.frequency);

      const g = this.ctx.createGain();
      g.gain.value = 0.22;
      osc.connect(g);
      g.connect(this.ambientGain);
      osc.start(now);
      driftLfo.start(now);

      const fan = this.ctx.createBufferSource();
      fan.buffer = this._createNoiseBuffer(2.5);
      fan.loop = true;
      const fanBp = this.ctx.createBiquadFilter();
      fanBp.type = "bandpass";
      fanBp.frequency.value = 280;
      fanBp.Q.value = 0.9;
      const fg = this.ctx.createGain();
      fg.gain.value = 0.2;
      fan.connect(fanBp);
      fanBp.connect(fg);
      fg.connect(this.ambientGain);
      fan.start(now);

      this.activeNodes.push(osc, driftLfo, driftAmt, g, fan, fanBp, fg);
    } else if (levelId === "level_2") {
      // Utility pipe resonance + pressurized steam hiss
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 92;
      const lp = this.ctx.createBiquadFilter();
      lp.type = "bandpass";
      lp.frequency.value = 185;
      lp.Q.value = 2.8;
      const g = this.ctx.createGain();
      g.gain.value = 0.18;
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.ambientGain);
      osc.start(now);

      const steam = this.ctx.createBufferSource();
      steam.buffer = this._createNoiseBuffer(2);
      steam.loop = true;
      const hp = this.ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1800;
      const sg = this.ctx.createGain();
      sg.gain.value = 0.065;
      steam.connect(hp);
      hp.connect(sg);
      sg.connect(this.ambientGain);
      steam.start(now);

      this.activeNodes.push(osc, lp, g, steam, hp, sg);
    }
  }

  playFootstep(levelId = "level_0") {
    if (!this.init() || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const isHardSurface =
      levelId === "level_1" || levelId === "the_hub" || levelId === "level_2";

    osc.type = isHardSurface ? "triangle" : "sine";
    const baseFreq = isHardSurface ? 135 + Math.random() * 25 : 78 + Math.random() * 14;
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(34, now + 0.08);

    g.gain.setValueAtTime(isHardSurface ? 0.14 : 0.09, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  playFlashlightClick(on) {
    if (!this.init() || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(on ? 1150 : 780, now);
    osc.frequency.exponentialRampToValueAtTime(on ? 1680 : 420, now + 0.035);
    g.gain.setValueAtTime(0.16, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  playNoclipGlitch() {
    if (!this.init() || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.linearRampToValueAtTime(65, now + 0.14);
    osc.frequency.linearRampToValueAtTime(880, now + 0.28);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.55);

    g.gain.setValueAtTime(0.28, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.56);

    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.58);
  }

  playDoorTransition() {
    if (!this.init() || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(95, now + 0.22);
    g.gain.setValueAtTime(0.24, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.26);
  }

  playBlackout(isDark) {
    if (!this.init()) return;
    const now = this.ctx.currentTime;
    if (this.ambientGain) {
      this.ambientGain.gain.setTargetAtTime(isDark ? 0.1 : 0.5, now, 0.08);
    }
    if (this.muted) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(isDark ? 180 : 90, now);
    osc.frequency.exponentialRampToValueAtTime(isDark ? 36 : 240, now + 0.25);
    g.gain.setValueAtTime(0.22, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.3);
  }

  playKeyPickup() {
    if (!this.init() || this.muted) return;
    const now = this.ctx.currentTime;
    for (const [idx, freq] of [587.33, 880, 1174.66].entries()) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + idx * 0.07);
      g.gain.setValueAtTime(0.18, now + idx * 0.07);
      g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.26);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(now + idx * 0.07);
      osc.stop(now + idx * 0.07 + 0.28);
    }
  }

  playPuddleSplash() {
    if (!this.init() || this.muted) return;
    const now = this.ctx.currentTime;
    const noise = this.ctx.createBufferSource();
    noise.buffer = this._createNoiseBuffer(0.35);
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(920, now);
    bp.frequency.exponentialRampToValueAtTime(340, now + 0.16);
    bp.Q.value = 1.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.24, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    noise.connect(bp);
    bp.connect(g);
    g.connect(this.sfxGain);
    noise.start(now);
    noise.stop(now + 0.2);
  }

  playTremor() {
    if (!this.init() || this.muted) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(48, now);
    osc.frequency.linearRampToValueAtTime(34, now + 2.1);

    const rumble = this.ctx.createBufferSource();
    rumble.buffer = this._createNoiseBuffer(2.3);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 95;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.01, now);
    g.gain.linearRampToValueAtTime(0.34, now + 0.35);
    g.gain.exponentialRampToValueAtTime(0.002, now + 2.2);

    osc.connect(lp);
    rumble.connect(lp);
    lp.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    rumble.start(now);
    osc.stop(now + 2.25);
    rumble.stop(now + 2.25);
  }
}
