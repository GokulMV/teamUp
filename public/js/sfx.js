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

  // Continuous engine sound for your own kart.
  let engine = null;
  function engineUpdate(speedRatio, boosting, drifting) {
    if (!ready()) { engineStop(); return; }
    if (!engine) {
      const o1 = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      const f = ctx.createBiquadFilter();
      const g = ctx.createGain();
      o1.type = 'sawtooth';
      o2.type = 'square';
      f.type = 'lowpass';
      f.frequency.value = 600;
      g.gain.value = 0;
      o1.connect(f); o2.connect(f); f.connect(g); g.connect(master);
      o1.start(); o2.start();
      // Tire screech layer for drifting.
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf; s.loop = true;
      const sf = ctx.createBiquadFilter();
      sf.type = 'bandpass'; sf.frequency.value = 2400; sf.Q.value = 4;
      const sg = ctx.createGain();
      sg.gain.value = 0;
      s.connect(sf); sf.connect(sg); sg.connect(master);
      s.start();
      engine = { o1, o2, f, g, s, sg };
    }
    const t = ctx.currentTime;
    const r = Math.max(0, Math.min(1.6, speedRatio));
    const base = 55 + r * 95 + (boosting ? 40 : 0);
    engine.o1.frequency.setTargetAtTime(base, t, 0.06);
    engine.o2.frequency.setTargetAtTime(base * 0.5, t, 0.06);
    engine.f.frequency.setTargetAtTime(400 + r * 900 + (boosting ? 800 : 0), t, 0.08);
    engine.g.gain.setTargetAtTime(0.05 + r * 0.06, t, 0.1);
    engine.sg.gain.setTargetAtTime(drifting ? 0.07 : 0, t, 0.05);
  }
  function engineStop() {
    if (!engine) return;
    const e = engine;
    engine = null;
    try {
      e.g.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      e.sg.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      setTimeout(() => { e.o1.stop(); e.o2.stop(); e.s.stop(); }, 300);
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
    hit() { tone(520, { type: 'square', dur: 0.45, vol: 0.18, slide: 0.25 }); },
    kill() { tone(1046, { type: 'triangle', dur: 0.12, vol: 0.22 }); tone(1568, { type: 'triangle', dur: 0.25, vol: 0.22, delay: 0.08 }); },
    streak() { [523, 659, 784, 1046].forEach((f, i) => tone(f, { type: 'square', dur: 0.14, vol: 0.13, delay: i * 0.07 })); },
    correct() { [784, 988, 1175].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.16, vol: 0.2, delay: i * 0.07 })); },
    tick() { tone(1200, { type: 'square', dur: 0.04, vol: 0.06 }); },
    pop() { tone(500, { type: 'sine', dur: 0.08, vol: 0.15, slide: 1.8 }); },
    finish() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, { type: 'square', dur: 0.16, vol: 0.12, delay: i * 0.11 })); },
  };
  window.Sfx = Sfx;
})();
