// Sound effects synthesized with the Web Audio API (no audio files needed).
(function () {
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem('teamup-muted') === '1'; } catch { /* ignore */ }

  function init() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.55;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp);
    comp.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  // Browsers only allow audio after a user gesture.
  const unlock = () => { init(); if (ctx && ctx.state === 'suspended') ctx.resume(); };
  ['pointerdown', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, unlock, { passive: true }));

  const ready = () => ctx && ctx.state === 'running' && !muted;

  function env(gain, t, attack, hold, release, peak) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.setValueAtTime(peak, t + attack + hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  }

  function tone(freq, { type = 'sine', dur = 0.15, vol = 0.3, slide = 0, delay = 0, attack = 0.005 } = {}) {
    if (!ready()) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    env(g, t, attack, dur * 0.3, dur * 0.7, vol);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function noise({ dur = 0.3, vol = 0.3, filter = 'lowpass', from = 4000, to = 200, q = 1, delay = 0 } = {}) {
    if (!ready()) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + dur);
    const g = ctx.createGain();
    env(g, t, 0.005, dur * 0.15, dur * 0.85, vol);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  // Kart engine. Same idea as moonlit-cove's van: one engine cycle on a loop, played faster as the
  // engine revs, filtered so it carries on small speakers. Here the loop is generated rather than
  // recorded: a small single-cylinder kart engine, each firing a thump + mechanical rasp + exhaust
  // crackle, with a little variation between strokes so it doesn't sound like a buzzer.
  const ENGINE_FIRING_HZ = 50; // firing rate at playbackRate 1
  let engineBuf = null;
  function makeEngineBuffer() {
    const sr = ctx.sampleRate;
    const cycles = 100;
    const len = Math.round((sr * cycles) / ENGINE_FIRING_HZ);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const period = sr / ENGINE_FIRING_HZ;
    const pulseLen = Math.round(period * 1.6);
    const TAU = Math.PI * 2;
    for (let c = 0; c < cycles; c++) {
      const start = Math.round(c * period + (rand() - 0.5) * period * 0.06);
      const amp = 0.7 + rand() * 0.3;
      const body = ENGINE_FIRING_HZ * (2.9 + rand() * 0.4);
      const rasp = ENGINE_FIRING_HZ * (10 + rand() * 2);
      for (let k = 0; k < pulseLen; k++) {
        const t = k / sr;
        const v = Math.exp(-t * 55) * Math.sin(TAU * body * t) * 0.9
          + Math.exp(-t * 170) * Math.sin(TAU * rasp * t) * 0.35
          + Math.exp(-t * 320) * (rand() * 2 - 1) * 0.5;
        d[(start + k + len) % len] += amp * v; // wrap so the loop is seamless
      }
    }
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < len; i++) d[i] *= 0.9 / peak;
    return buf;
  }

  function gritCurve() {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(2.4 * x); }
    return curve;
  }

  // Continuous engine sound for your own kart.
  let engine = null;
  function engineUpdate(speedRatio, boosting, drifting) {
    if (!ready()) { engineStop(); return; }
    const t = ctx.currentTime;
    if (!engine) {
      engineBuf = engineBuf || makeEngineBuffer();
      const out = ctx.createGain();
      out.gain.value = 0;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 45; hp.Q.value = 0.7; // no sub-bass rumble on small speakers
      const shaper = ctx.createWaveShaper();
      shaper.curve = gritCurve();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.8;
      hp.connect(shaper); shaper.connect(lp); lp.connect(out); out.connect(master);
      // Two voices: the engine itself, and a quieter one an octave up for the intake whine.
      const voices = [1, 2.01].map((mult, i) => {
        const src = ctx.createBufferSource();
        src.buffer = engineBuf;
        src.loop = true;
        const g = ctx.createGain();
        g.gain.value = i ? 0.22 : 1;
        src.connect(g); g.connect(hp);
        src.start(t, i * 0.37);
        return { src, mult };
      });
      // Starting up: the engine catches, flares and settles to idle.
      for (const v of voices) {
        v.src.playbackRate.setValueAtTime(0.35 * v.mult, t);
        v.src.playbackRate.linearRampToValueAtTime(1.5 * v.mult, t + 0.45);
        v.src.playbackRate.setTargetAtTime(0.8 * v.mult, t + 0.5, 0.25);
      }
      out.gain.linearRampToValueAtTime(0.16, t + 0.3);
      // Tire screech layer for drifting.
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf; s.loop = true;
      const sf = ctx.createBiquadFilter();
      sf.type = 'bandpass'; sf.frequency.value = 2400; sf.Q.value = 4;
      const sg = ctx.createGain();
      sg.gain.value = 0;
      s.connect(sf); sf.connect(sg); sg.connect(master);
      s.start();
      engine = { voices, lp, out, s, sg, warm: t + 0.9 };
      return;
    }
    if (t < engine.warm) return; // let the start-up flare play out
    const r = Math.max(0, Math.min(1.6, speedRatio));
    // Idle around 40 firings/s, flat out around 150 (a kart engine at ~9000 rpm), more on boost.
    const rate = 0.8 + r * 2.1 + (boosting ? 0.45 : 0);
    for (const v of engine.voices) v.src.playbackRate.setTargetAtTime(rate * v.mult, t, 0.07);
    engine.lp.frequency.setTargetAtTime(900 + r * 2400 + (boosting ? 1200 : 0), t, 0.08);
    engine.out.gain.setTargetAtTime(0.13 + r * 0.07 + (boosting ? 0.04 : 0), t, 0.1);
    engine.sg.gain.setTargetAtTime(drifting ? 0.07 : 0, t, 0.05);
  }
  function engineStop() {
    if (!engine) return;
    const e = engine;
    engine = null;
    try {
      const t = ctx.currentTime;
      for (const v of e.voices) v.src.playbackRate.setTargetAtTime(0.3 * v.mult, t, 0.2); // winds down
      e.out.gain.setTargetAtTime(0, t, 0.15);
      e.sg.gain.setTargetAtTime(0, t, 0.05);
      setTimeout(() => { [...e.voices.map((v) => v.src), e.s].forEach((n) => n.stop()); }, 800);
    } catch { /* already stopped */ }
  }

  const Sfx = {
    get muted() { return muted; },
    setMuted(m) {
      muted = m;
      try { localStorage.setItem('teamup-muted', m ? '1' : '0'); } catch { /* ignore */ }
      if (master) master.gain.value = m ? 0 : 0.55;
      if (m) engineStop();
    },
    engine: engineUpdate,
    engineStop,
    beep() { tone(660, { type: 'square', dur: 0.18, vol: 0.18 }); },
    go() { tone(990, { type: 'square', dur: 0.45, vol: 0.2 }); tone(1320, { type: 'square', dur: 0.45, vol: 0.12, delay: 0.02 }); },
    pickup() { [660, 880, 1100, 1320].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.09, vol: 0.18, delay: i * 0.05 })); },
    rocket() { noise({ dur: 0.45, vol: 0.35, filter: 'bandpass', from: 600, to: 3500, q: 1.5 }); tone(220, { type: 'sawtooth', dur: 0.3, vol: 0.08, slide: 3 }); },
    banana() { tone(300, { type: 'triangle', dur: 0.15, vol: 0.2, slide: 0.6 }); },
    shield() { tone(400, { type: 'sine', dur: 0.5, vol: 0.2, slide: 2.5 }); tone(600, { type: 'sine', dur: 0.5, vol: 0.1, slide: 2.5, delay: 0.05 }); },
    boost() { noise({ dur: 0.7, vol: 0.4, filter: 'bandpass', from: 300, to: 2500, q: 0.8 }); },
    miniTurbo(level) { noise({ dur: 0.35, vol: 0.3, filter: 'highpass', from: 1500, to: 5000 }); tone(level > 1 ? 880 : 660, { type: 'square', dur: 0.12, vol: 0.12 }); },
    explosion(volume = 1) {
      const v = Math.max(0.05, Math.min(1, volume));
      noise({ dur: 1.1, vol: 0.7 * v, filter: 'lowpass', from: 2500, to: 60 });
      tone(90, { type: 'sine', dur: 0.6, vol: 0.5 * v, slide: 0.3 });
    },
    hit() {
      noise({ dur: 0.25, vol: 0.45, filter: 'lowpass', from: 1800, to: 120 });
      tone(140, { type: 'sine', dur: 0.3, vol: 0.4, slide: 0.4 });
      tone(520, { type: 'square', dur: 0.35, vol: 0.1, slide: 0.25 });
    },
    bump(volume = 0.4) { noise({ dur: 0.12, vol: volume, filter: 'lowpass', from: 1200, to: 150 }); },
    shock(volume = 1) {
      const v = Math.max(0.1, Math.min(1, volume));
      noise({ dur: 0.6, vol: 0.5 * v, filter: 'highpass', from: 6000, to: 800 });
      tone(1800, { type: 'sawtooth', dur: 0.35, vol: 0.12 * v, slide: 0.2 });
      tone(60, { type: 'sine', dur: 0.5, vol: 0.4 * v, slide: 0.5 });
    },
    minigun() {
      for (let i = 0; i < 24; i++) noise({ dur: 0.05, vol: 0.18, filter: 'bandpass', from: 2200, to: 900, q: 2, delay: i * 0.08 });
    },
    kill() { tone(1046, { type: 'triangle', dur: 0.12, vol: 0.22 }); tone(1568, { type: 'triangle', dur: 0.25, vol: 0.22, delay: 0.08 }); },
    streak() { [523, 659, 784, 1046].forEach((f, i) => tone(f, { type: 'square', dur: 0.14, vol: 0.13, delay: i * 0.07 })); },
    correct() { [784, 988, 1175].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.16, vol: 0.2, delay: i * 0.07 })); },
    tick() { tone(1200, { type: 'square', dur: 0.04, vol: 0.06 }); },
    pop() { tone(500, { type: 'sine', dur: 0.08, vol: 0.15, slide: 1.8 }); },
    finish() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, { type: 'square', dur: 0.16, vol: 0.12, delay: i * 0.11 })); },
  };
  window.Sfx = Sfx;
})();
