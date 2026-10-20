// Sound effects: synthesized with the Web Audio API, plus recorded CC0 samples for Kart Battle and
// Ball & Chain (public/audio, see CREDITS.md).
(function () {
  let ctx = null;
  let master = null;
  let direct = null; // for mixes with their own limiter (Kart Battle's), past the compressor
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
    direct = ctx.createGain();
    direct.gain.value = muted ? 0 : 1;
    direct.connect(ctx.destination);
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

  // A clean tone with a fast attack and a smooth decay: a sine, a quiet octave and a touch of
  // the fifth, through a gentle low-pass so nothing buzzes.
  function chime(freq, dur = 0.3, vol = 0.2, delay = 0) {
    if (!ready()) return;
    const t = ctx.currentTime + delay;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    out.gain.exponentialRampToValueAtTime(vol * 0.55, t + dur * 0.35);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = Math.min(9000, freq * 5);
    lp.connect(out); out.connect(master);
    for (const [mult, g] of [[1, 1], [2, 0.28], [3, 0.08]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq * mult, t);
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og); og.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
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

  // Continuous engine sound for your own kart. surface: 0 road, 1 run-off, 2 grass (K.stepKart).
  let engine = null;
  function engineUpdate(speedRatio, boosting, drifting, surface = 0, throttle = true) {
    if (!ready()) { engineStop(); return; }
    const t = ctx.currentTime;
    // The recorded engine has arrived: swap the synthesized one out for it.
    if (engine && engine.kind === 'synth' && buf('engine')) engineStop(true);
    if (!engine && buf('engine')) { engine = sampleEngine(t); return; }
    if (engine && engine.kind === 'sample') { sampleEngineUpdate(t, speedRatio, boosting, drifting, surface, throttle); return; }
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
      // Off-road rumble: low filtered noise under the engine while on grass or gravel.
      const rumble = ctx.createBufferSource();
      rumble.buffer = noiseBuf; rumble.loop = true;
      const rf = ctx.createBiquadFilter();
      rf.type = 'lowpass'; rf.frequency.value = 300; rf.Q.value = 0.9;
      const rg = ctx.createGain();
      rg.gain.value = 0;
      rumble.connect(rf); rf.connect(rg); rg.connect(master);
      rumble.start(t, Math.random());
      engine = { kind: 'synth', voices, lp, out, s, sg, rumble, rg, warm: t + 0.9 };
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
    engine.rg.gain.setTargetAtTime(surface === 2 ? 0.08 * Math.min(1, r) : surface === 1 ? 0.035 * Math.min(1, r) : 0, t, 0.08);
  }
  // The recorded engine (Kenney's racing kit): pitched from half speed at idle to about three times
  // flat out (as the kit's own car does), a little higher with the throttle down, the filter
  // opening up as it revs. Drifting adds the recorded tyre skid; grass and gravel a low rumble.
  function sampleEngine(t) {
    const out = ctx.createGain();
    out.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1400; lp.Q.value = 0.7;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 40;
    hp.connect(lp); lp.connect(out); out.connect(master);
    const src = ctx.createBufferSource();
    src.buffer = buf('engine'); src.loop = true;
    src.playbackRate.setValueAtTime(0.3, t);
    src.playbackRate.linearRampToValueAtTime(1.1, t + 0.35); // catches and flares...
    src.playbackRate.setTargetAtTime(0.6, t + 0.4, 0.25); // ...and settles to idle
    src.connect(hp);
    src.start(t);
    out.gain.linearRampToValueAtTime(0.2, t + 0.25);
    const skidBuf = buf('skid');
    const s = ctx.createBufferSource();
    s.buffer = skidBuf || noiseBuf; s.loop = true;
    const sf = ctx.createBiquadFilter();
    sf.type = skidBuf ? 'highpass' : 'bandpass'; sf.frequency.value = skidBuf ? 300 : 2400; sf.Q.value = skidBuf ? 0.7 : 4;
    const sg = ctx.createGain();
    sg.gain.value = 0;
    s.connect(sf); sf.connect(sg); sg.connect(master);
    s.start(t, Math.random());
    const rumble = ctx.createBufferSource();
    rumble.buffer = noiseBuf; rumble.loop = true;
    const rf = ctx.createBiquadFilter();
    rf.type = 'lowpass'; rf.frequency.value = 260; rf.Q.value = 0.9;
    const rg = ctx.createGain();
    rg.gain.value = 0;
    rumble.connect(rf); rf.connect(rg); rg.connect(master);
    rumble.start(t, Math.random());
    if (!skidBuf) loadSample(KART.skid);
    return { kind: 'sample', voices: [{ src, mult: 1 }], lp, out, s, sg, skid: !!skidBuf, rumble, rg, warm: t + 0.7 };
  }
  function sampleEngineUpdate(t, speedRatio, boosting, drifting, surface, throttle) {
    if (t < engine.warm) return;
    const r = Math.max(0, Math.min(1.4, speedRatio));
    const rate = 0.55 + r * 2.3 + (throttle ? 0.18 : 0) + (boosting ? 0.35 : 0);
    engine.voices[0].src.playbackRate.setTargetAtTime(rate, t, throttle ? 0.12 : 0.25);
    engine.lp.frequency.setTargetAtTime(1300 + r * 3600 + (boosting ? 1500 : 0), t, 0.1);
    engine.out.gain.setTargetAtTime(0.16 + Math.min(1, r) * 0.14 + (throttle ? 0.03 : 0) + (boosting ? 0.05 : 0), t, 0.12);
    engine.sg.gain.setTargetAtTime(drifting ? (engine.skid ? 0.2 : 0.07) * Math.min(1, 0.5 + r) : 0, t, 0.05);
    if (engine.skid) engine.s.playbackRate.setTargetAtTime(0.85 + Math.min(1, r) * 0.35, t, 0.1);
    engine.rg.gain.setTargetAtTime(surface === 2 ? 0.09 * Math.min(1, r) : surface === 1 ? 0.04 * Math.min(1, r) : 0, t, 0.08);
  }
  function engineStop(quick) {
    if (!engine) return;
    const e = engine;
    engine = null;
    if (quick) {
      try { e.out.gain.setTargetAtTime(0, ctx.currentTime, 0.03); e.sg.gain.setTargetAtTime(0, ctx.currentTime, 0.03); e.rg.gain.setTargetAtTime(0, ctx.currentTime, 0.03); } catch { /* gone */ }
      setTimeout(() => { [...e.voices.map((v) => v.src), e.s, e.rumble].forEach((n) => { try { n.stop(); } catch { /* stopped */ } }); }, 200);
      return;
    }
    try {
      const t = ctx.currentTime;
      for (const v of e.voices) v.src.playbackRate.setTargetAtTime(0.3 * v.mult, t, 0.2); // winds down
      e.out.gain.setTargetAtTime(0, t, 0.15);
      e.sg.gain.setTargetAtTime(0, t, 0.05);
      e.rg.gain.setTargetAtTime(0, t, 0.05);
      setTimeout(() => { [...e.voices.map((v) => v.src), e.s, e.rumble].forEach((n) => n.stop()); }, 800);
    } catch { /* already stopped */ }
  }

  // Short CC0 samples (Kenney starter kits) layered under some Ball & Chain sounds.
  const BC_SAMPLES = { impact: '/audio/ballchain/impact.mp3', coin: '/audio/ballchain/coin.mp3', jump: '/audio/ballchain/jump.mp3' };
  const samples = {};
  let bcRumble = null;
  function loadSample(url) {
    if (samples[url] || !ctx) return;
    samples[url] = { buf: null };
    fetch(url).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).then((buf) => { samples[url].buf = buf; }).catch(() => {});
  }
  function sample(url, vol = 0.5, rate = 1) {
    if (!ready()) return;
    loadSample(url);
    const buf = samples[url]?.buf;
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(master);
    src.start();
  }

  // Kart Battle's recorded sounds (CC0: Kenney's racing, FPS and platformer starter kits; see
  // CREDITS.md). Loaded when a kart game starts; until they arrive the synthesized versions play.
  const KART = {
    engine: '/audio/kart/engine.wav', skid: '/audio/kart/skid.wav', impact: '/audio/kart/impact.mp3',
    explode: '/audio/kart/explode.mp3', hurt: '/audio/kart/hurt.mp3', blaster: '/audio/kart/blaster.mp3',
    repeater: '/audio/kart/repeater.mp3', swap: '/audio/kart/swap.mp3', hop: '/audio/kart/hop.mp3',
    land: '/audio/kart/land.mp3', coin: '/audio/kart/coin.mp3', break: '/audio/kart/break.mp3',
    fall: '/audio/kart/fall.mp3', whoosh: '/audio/kart/whoosh.mp3',
  };
  const buf = (name) => samples[KART[name]]?.buf || null;
  // Play a kart sample: vol, playback rate, start delay (s) and stereo pan (-1 left .. 1 right).
  // Returns false when it isn't loaded yet, so the caller can fall back to a synthesized sound.
  function ks(name, vol = 0.5, rate = 1, delay = 0, pan = 0) {
    if (!ready()) return true;
    const b = buf(name);
    if (!b) { loadSample(KART[name]); return false; }
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      p.connect(master);
    } else g.connect(master);
    src.start(t);
    return true;
  }
  const jitter = (r = 0.08) => 1 + (Math.random() * 2 - 1) * r;

  // Rival karts' engines: the nearest few, panned to where they are and fading with distance.
  const rivalVoices = new Map(); // id -> { src, g, p }
  function rivalsUpdate(list) {
    if (!ready() || !buf('engine')) { rivalsStop(); return; }
    const t = ctx.currentTime;
    const keep = new Set();
    for (const r of list.slice(0, 3)) {
      keep.add(r.id);
      let v = rivalVoices.get(r.id);
      if (!v) {
        const src = ctx.createBufferSource();
        src.buffer = buf('engine');
        src.loop = true;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 1600;
        const g = ctx.createGain();
        g.gain.value = 0;
        const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        src.connect(lp); lp.connect(g);
        if (p) { g.connect(p); p.connect(master); } else g.connect(master);
        src.start(t, Math.random() * 3);
        v = { src, g, p, lp, pitch: 0.94 + Math.random() * 0.12 };
        rivalVoices.set(r.id, v);
      }
      const near = Math.max(0, 1 - r.dist / 1100);
      const sp = Math.max(0, Math.min(1.3, r.speed));
      v.src.playbackRate.setTargetAtTime((0.55 + sp * 2.1) * v.pitch, t, 0.1);
      v.lp.frequency.setTargetAtTime(900 + sp * 2200, t, 0.1);
      v.g.gain.setTargetAtTime(0.11 * near * near * (0.45 + 0.55 * Math.min(1, sp)), t, 0.12);
      if (v.p) v.p.pan.setTargetAtTime(Math.max(-0.9, Math.min(0.9, r.pan)), t, 0.08);
    }
    for (const [id, v] of rivalVoices) {
      if (keep.has(id)) continue;
      rivalVoices.delete(id);
      v.g.gain.setTargetAtTime(0, t, 0.1);
      setTimeout(() => { try { v.src.stop(); } catch { /* stopped */ } }, 600);
    }
  }
  function rivalsStop() {
    for (const v of rivalVoices.values()) {
      try { v.g.gain.setTargetAtTime(0, ctx.currentTime, 0.05); setTimeout(() => { try { v.src.stop(); } catch { /* stopped */ } }, 400); } catch { /* gone */ }
    }
    rivalVoices.clear();
  }

  // Star power: a bright looping arpeggio over a bass pulse while it lasts.
  let starNodes = [];
  function starStop() {
    const t = ctx ? ctx.currentTime : 0;
    for (const n of starNodes) { try { n.stop(t + 0.02); } catch { /* already stopped */ } }
    starNodes = [];
  }
  function starStart(seconds) {
    starStop();
    if (!ready()) return;
    const t0 = ctx.currentTime + 0.02;
    const beat = 0.125;
    const melody = [784, 988, 1175, 1568, 1175, 988, 880, 1109, 1319, 1760, 1319, 1109];
    const bass = [196, 196, 220, 220];
    const steps = Math.floor(seconds / beat);
    for (let i = 0; i < steps; i++) {
      const t = t0 + i * beat;
      const voices = [[melody[i % melody.length], 'square', 0.045]];
      if (i % 2 === 0) voices.push([bass[Math.floor(i / 12) % bass.length], 'triangle', 0.09]);
      for (const [f, type, vol] of voices) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f, t);
        env(g, t, 0.004, 0.03, 0.08, vol);
        o.connect(g);
        g.connect(master);
        o.start(t);
        o.stop(t + 0.13);
        starNodes.push(o);
      }
    }
  }

  const Sfx = {
    get muted() { return muted; },
    // The shared audio context (made on first use; it runs after the first tap or key press) and
    // an output that mutes with the rest but skips the compressor.
    context: init,
    output() { init(); return direct; },
    setMuted(m) {
      muted = m;
      try { localStorage.setItem('teamup-muted', m ? '1' : '0'); } catch { /* ignore */ }
      if (master) master.gain.value = m ? 0 : 0.55;
      if (direct) direct.gain.value = m ? 0 : 1;
      if (m) { engineStop(); rivalsStop(); starStop(); }
    },
    engine: engineUpdate,
    engineStop() { engineStop(); rivalsStop(); },
    rivals: rivalsUpdate,
    kartPreload() { init(); if (ctx) Object.values(KART).forEach(loadSample); },
    // Start lights: 3, 2, 1 are a clean, round tone (a sine with a soft octave over it, like a race
    // start's timing beacon); GO is the same an octave up with a fifth on top and a whoosh.
    beep() { chime(587, 0.32, 0.22); },
    go() { chime(1175, 0.65, 0.24); chime(1760, 0.6, 0.1, 0.01); ks('whoosh', 0.35, 1.1); },
    pickup() { if (!ks('coin', 0.5)) [660, 880, 1100, 1320].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.09, vol: 0.18, delay: i * 0.05 })); },
    rocket() { if (ks('blaster', 0.42, 0.72 * jitter(0.05))) { ks('whoosh', 0.35, 0.8); return; } noise({ dur: 0.45, vol: 0.35, filter: 'bandpass', from: 600, to: 3500, q: 1.5 }); tone(220, { type: 'sawtooth', dur: 0.3, vol: 0.08, slide: 3 }); },
    banana() { tone(300, { type: 'triangle', dur: 0.15, vol: 0.2, slide: 0.6 }); },
    shield() { tone(400, { type: 'sine', dur: 0.5, vol: 0.2, slide: 2.5 }); tone(600, { type: 'sine', dur: 0.5, vol: 0.1, slide: 2.5, delay: 0.05 }); },
    boost() { ks('whoosh', 0.45, 0.75); noise({ dur: 0.7, vol: 0.28, filter: 'bandpass', from: 300, to: 2500, q: 0.8 }); },
    miniTurbo(level) { ks('whoosh', 0.4, level > 1 ? 1.15 : 1); noise({ dur: 0.35, vol: 0.2, filter: 'highpass', from: 1500, to: 5000 }); tone(level > 1 ? 880 : 660, { type: 'square', dur: 0.1, vol: 0.08 }); },
    explosion(volume = 1, pan = 0) {
      const v = Math.max(0.05, Math.min(1, volume));
      // The recorded blast, with a sub thump under it so it lands on small speakers too.
      if (ks('explode', 0.85 * v, 0.78 * jitter(0.08), 0, pan)) ks('impact', 0.5 * v, 0.7, 0, pan);
      else noise({ dur: 1.1, vol: 0.7 * v, filter: 'lowpass', from: 2500, to: 60 });
      tone(80, { type: 'sine', dur: 0.55, vol: 0.45 * v, slide: 0.35 });
    },
    hit() {
      if (ks('hurt', 0.6, 0.9)) { ks('impact', 0.7, 0.85); tone(120, { type: 'sine', dur: 0.3, vol: 0.35, slide: 0.4 }); return; }
      noise({ dur: 0.25, vol: 0.45, filter: 'lowpass', from: 1800, to: 120 });
      tone(140, { type: 'sine', dur: 0.3, vol: 0.4, slide: 0.4 });
      tone(520, { type: 'square', dur: 0.35, vol: 0.1, slide: 0.25 });
    },
    bump(volume = 0.4, pan = 0) { if (!ks('impact', Math.min(1, volume * 1.5), jitter(0.1), 0, pan)) noise({ dur: 0.12, vol: volume, filter: 'lowpass', from: 1200, to: 150 }); },
    shock(volume = 1) {
      const v = Math.max(0.1, Math.min(1, volume));
      noise({ dur: 0.6, vol: 0.5 * v, filter: 'highpass', from: 6000, to: 800 });
      tone(1800, { type: 'sawtooth', dur: 0.35, vol: 0.12 * v, slide: 0.2 });
      tone(60, { type: 'sine', dur: 0.5, vol: 0.4 * v, slide: 0.5 });
    },
    minigun() {
      if (buf('repeater')) { for (let i = 0; i < 5; i++) ks('repeater', 0.32, jitter(0.04), i * 0.38); return; }
      ks('repeater', 0);
      for (let i = 0; i < 24; i++) noise({ dur: 0.05, vol: 0.18, filter: 'bandpass', from: 2200, to: 900, q: 2, delay: i * 0.08 });
    },
    kill() { tone(1046, { type: 'triangle', dur: 0.12, vol: 0.22 }); tone(1568, { type: 'triangle', dur: 0.25, vol: 0.22, delay: 0.08 }); },
    // Your shot landed: a short bright tick.
    hitConfirm() { tone(1760, { type: 'triangle', dur: 0.06, vol: 0.16 }); noise({ dur: 0.05, vol: 0.1, filter: 'highpass', from: 3000, to: 5000 }); },
    // Low health: two soft thumps.
    heartbeat() {
      tone(60, { type: 'sine', dur: 0.14, vol: 0.5, slide: 0.7 }); tone(120, { type: 'sine', dur: 0.1, vol: 0.12, slide: 0.7 });
      tone(60, { type: 'sine', dur: 0.14, vol: 0.38, slide: 0.7, delay: 0.12 }); tone(120, { type: 'sine', dur: 0.1, vol: 0.09, slide: 0.7, delay: 0.12 });
    },
    streak() { [523, 659, 784, 1046].forEach((f, i) => tone(f, { type: 'square', dur: 0.14, vol: 0.13, delay: i * 0.07 })); },
    correct() { [784, 988, 1175].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.16, vol: 0.2, delay: i * 0.07 })); },
    tick() { tone(1200, { type: 'square', dur: 0.04, vol: 0.06 }); },
    pop() { tone(500, { type: 'sine', dur: 0.08, vol: 0.15, slide: 1.8 }); },
    finish() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, { type: 'square', dur: 0.16, vol: 0.12, delay: i * 0.11 })); },
    // Jumps and falls on race tracks.
    trick() { noise({ dur: 0.3, vol: 0.25, filter: 'bandpass', from: 900, to: 3200, q: 1.2 }); [784, 1175].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.12, vol: 0.14, delay: i * 0.07 })); },
    land(volume = 0.6) {
      const v = Math.max(0.1, Math.min(1, volume));
      if (ks('land', 0.9 * v, 0.9)) { ks('impact', 0.45 * v, 0.75); tone(80, { type: 'sine', dur: 0.18, vol: 0.25 * v, slide: 0.5 }); return; }
      noise({ dur: 0.18, vol: 0.45 * v, filter: 'lowpass', from: 900, to: 90 });
      tone(85, { type: 'sine', dur: 0.2, vol: 0.35 * v, slide: 0.5 });
    },
    splash(volume = 1) {
      const v = Math.max(0.05, Math.min(1, volume));
      noise({ dur: 0.9, vol: 0.55 * v, filter: 'bandpass', from: 2400, to: 300, q: 0.7 });
      tone(320, { type: 'sine', dur: 0.25, vol: 0.18 * v, slide: 0.4 });
      for (let i = 0; i < 4; i++) tone(500 + Math.random() * 600, { type: 'sine', dur: 0.08, vol: 0.06 * v, slide: 1.6, delay: 0.25 + i * 0.09 });
    },
    // Layered arenas: a jump pad's launch (a spring and a rising whoosh), a pinball bumper's boing,
    // and the bell that rings before a drawbridge goes up.
    pad(volume = 1) {
      const v = Math.max(0.05, Math.min(1, volume));
      ks('whoosh', 0.45 * v, 0.7);
      tone(150, { type: 'sine', dur: 0.3, vol: 0.4 * v, slide: 3.2 });
      noise({ dur: 0.55, vol: 0.3 * v, filter: 'bandpass', from: 500, to: 3800, q: 0.9 });
      tone(620, { type: 'triangle', dur: 0.22, vol: 0.1 * v, slide: 1.8, delay: 0.05 });
    },
    boing(volume = 1) {
      const v = Math.max(0.05, Math.min(1, volume));
      tone(260, { type: 'sine', dur: 0.28, vol: 0.32 * v, slide: 1.9 });
      tone(390, { type: 'triangle', dur: 0.2, vol: 0.12 * v, slide: 1.7, delay: 0.03 });
      noise({ dur: 0.08, vol: 0.2 * v, filter: 'lowpass', from: 1500, to: 300 });
    },
    bell(volume = 1) {
      const v = Math.max(0.05, Math.min(1, volume));
      for (const [f, k] of [[523, 0.22], [1046, 0.08], [1569, 0.05], [784, 0.06]]) tone(f, { type: 'sine', dur: 1.4, vol: k * v, attack: 0.002 });
    },
    sizzle(volume = 1) {
      const v = Math.max(0.05, Math.min(1, volume));
      noise({ dur: 1.2, vol: 0.5 * v, filter: 'highpass', from: 5000, to: 1500 });
      tone(110, { type: 'sawtooth', dur: 0.5, vol: 0.12 * v, slide: 0.4 });
    },
    // Into a golf cup: the knock on its bottom, a rattle round the rim, then a polite little clap.
    holeOut(volume = 1) {
      const v = Math.max(0.05, Math.min(1, volume));
      tone(430, { type: 'sine', dur: 0.12, vol: 0.34 * v, slide: 0.55 });
      tone(250, { type: 'sine', dur: 0.18, vol: 0.3 * v, slide: 0.7, delay: 0.09 });
      for (let i = 0; i < 3; i++) noise({ dur: 0.03, vol: 0.12 * v, filter: 'bandpass', from: 2800, to: 2200, q: 2, delay: 0.2 + i * 0.07 });
      for (let i = 0; i < 7; i++) noise({ dur: 0.05, vol: 0.16 * v, filter: 'bandpass', from: 1800, to: 1200, q: 1.4, delay: 0.6 + i * 0.12 + Math.random() * 0.05 });
    },
    fall(volume = 1) {
      const v = Math.max(0.05, Math.min(1, volume));
      ks('fall', 0.6 * v, 0.75);
      tone(700, { type: 'triangle', dur: 0.7, vol: 0.16 * v, slide: 0.25 });
      noise({ dur: 0.6, vol: 0.2 * v, filter: 'lowpass', from: 1500, to: 200, delay: 0.5 });
    },
    // ---- item roulette ----
    rouletteTick(i = 0) {
      tone(1350 + (i % 3) * 170, { type: 'square', dur: 0.03, vol: 0.05 });
      noise({ dur: 0.03, vol: 0.06, filter: 'highpass', from: 5000, to: 3000 });
    },
    // New items: snow, ice, goo and steel.
    snowThrow() { noise({ dur: 0.18, vol: 0.22, filter: 'bandpass', from: 1800, to: 700, q: 0.9 }); },
    freeze(volume = 1) {
      const v = Math.max(0.05, Math.min(1, volume));
      noise({ dur: 0.45, vol: 0.3 * v, filter: 'highpass', from: 6000, to: 2500 });
      [1568, 2093, 2637].forEach((f, i) => tone(f, { type: 'sine', dur: 0.25, vol: 0.05 * v, delay: i * 0.05 }));
    },
    shatter(volume = 1) {
      const v = Math.max(0.05, Math.min(1, volume));
      if (ks('break', 0.75 * v, 1.15)) { noise({ dur: 0.25, vol: 0.2 * v, filter: 'highpass', from: 7000, to: 3000 }); return; }
      noise({ dur: 0.35, vol: 0.45 * v, filter: 'highpass', from: 7000, to: 3000 });
      for (let i = 0; i < 6; i++) tone(2000 + Math.random() * 2500, { type: 'triangle', dur: 0.08, vol: 0.06 * v, delay: 0.02 + i * 0.035 });
    },
    stick() {
      noise({ dur: 0.16, vol: 0.3, filter: 'lowpass', from: 900, to: 200 });
      tone(180, { type: 'sine', dur: 0.12, vol: 0.18, slide: 0.6 });
    },
    stickyBeep() { tone(1760, { type: 'square', dur: 0.05, vol: 0.07 }); },
    spikes() {
      noise({ dur: 0.4, vol: 0.2, filter: 'bandpass', from: 2500, to: 5000, q: 2 });
      tone(880, { type: 'sawtooth', dur: 0.3, vol: 0.05, slide: 1.6 });
    },
    // Hop: a springy little boing.
    hop() {
      if (ks('hop', 0.4, 1.1 * jitter(0.05))) return;
      tone(260, { type: 'sine', dur: 0.13, vol: 0.13, slide: 2.1 });
      noise({ dur: 0.05, vol: 0.05, filter: 'highpass', from: 2500, to: 4000 });
    },
    // Swapping to the reserve item: a quick two-note flick.
    swap() {
      if (ks('swap', 0.45)) return;
      tone(660, { type: 'triangle', dur: 0.07, vol: 0.14, slide: 1.5 });
      tone(990, { type: 'triangle', dur: 0.09, vol: 0.12, slide: 1.3, delay: 0.06 });
      noise({ dur: 0.08, vol: 0.06, filter: 'highpass', from: 3500, to: 6000 });
    },
    rouletteDing() {
      ks('coin', 0.45, 1.2);
      tone(1568, { type: 'sine', dur: 0.5, vol: 0.1 });
      tone(2093, { type: 'sine', dur: 0.55, vol: 0.09, delay: 0.015 });
      tone(3136, { type: 'triangle', dur: 0.3, vol: 0.04, delay: 0.03 });
    },
    // ---- newer items ----
    bouncer() {
      tone(420, { type: 'triangle', dur: 0.14, vol: 0.2, slide: 1.8 });
      noise({ dur: 0.12, vol: 0.25, filter: 'lowpass', from: 1500, to: 200 });
    },
    bounce(volume = 0.5) { tone(950, { type: 'sine', dur: 0.07, vol: 0.14 * volume, slide: 0.55 }); },
    comet() {
      noise({ dur: 1.1, vol: 0.35, filter: 'bandpass', from: 300, to: 3200, q: 1.2 });
      tone(260, { type: 'sawtooth', dur: 0.9, vol: 0.06, slide: 4 });
      tone(1320, { type: 'sine', dur: 0.6, vol: 0.06, slide: 1.5, delay: 0.3 });
    },
    // The comet is coming for you: a two-tone alarm.
    cometWarn() {
      tone(988, { type: 'square', dur: 0.1, vol: 0.09 });
      tone(740, { type: 'square', dur: 0.1, vol: 0.09, delay: 0.13 });
    },
    starStart,
    starStop,
    ink() {
      noise({ dur: 0.35, vol: 0.4, filter: 'lowpass', from: 900, to: 90 });
      tone(240, { type: 'sine', dur: 0.3, vol: 0.28, slide: 0.4 });
      tone(150, { type: 'triangle', dur: 0.2, vol: 0.18, slide: 0.6, delay: 0.09 });
    },
    inked() {
      noise({ dur: 0.5, vol: 0.5, filter: 'lowpass', from: 1400, to: 120 });
      tone(200, { type: 'sine', dur: 0.45, vol: 0.3, slide: 0.35 });
      tone(320, { type: 'sine', dur: 0.2, vol: 0.12, slide: 0.5, delay: 0.12 });
    },
    thunder(volume = 1) {
      const v = Math.max(0.2, Math.min(1, volume));
      noise({ dur: 0.3, vol: 0.65 * v, filter: 'highpass', from: 9000, to: 1500 });
      noise({ dur: 1.8, vol: 0.6 * v, filter: 'lowpass', from: 700, to: 40, delay: 0.05 });
      tone(55, { type: 'sine', dur: 1.3, vol: 0.4 * v, slide: 0.5 });
    },
    shrink() {
      tone(1000, { type: 'square', dur: 0.4, vol: 0.07, slide: 0.3 });
      tone(700, { type: 'square', dur: 0.4, vol: 0.05, slide: 0.3, delay: 0.06 });
    },
    block() {
      tone(1250, { type: 'triangle', dur: 0.18, vol: 0.16, slide: 0.55 });
      noise({ dur: 0.15, vol: 0.2, filter: 'highpass', from: 3000, to: 1200 });
    },
    // Control Room: a different click per control type, chimes, buzzers, klaxon and warp.
    crPress(type) {
      if (type === 'button') { tone(1180, { type: 'square', dur: 0.05, vol: 0.1 }); tone(590, { type: 'triangle', dur: 0.1, vol: 0.16, delay: 0.012 }); } else if (type === 'toggle') { noise({ dur: 0.05, vol: 0.4, filter: 'highpass', from: 2600, to: 1800 }); tone(240, { type: 'square', dur: 0.05, vol: 0.07 }); } else if (type === 'lever') { noise({ dur: 0.25, vol: 0.35, filter: 'lowpass', from: 900, to: 120 }); tone(140, { type: 'sawtooth', dur: 0.22, vol: 0.12, slide: 0.5 }); } else if (type === 'multi') { tone(780, { type: 'square', dur: 0.045, vol: 0.09 }); noise({ dur: 0.03, vol: 0.2, filter: 'highpass', from: 4200, to: 3000 }); } else tone(type === 'dial' ? 2300 : 1600, { type: 'square', dur: 0.022, vol: 0.05 }); // slider / dial detents
    },
    crGood() { [880, 1175, 1568].forEach((f, i) => tone(f, { type: 'sine', dur: 0.2, vol: 0.18, delay: i * 0.06 })); tone(2350, { type: 'triangle', dur: 0.28, vol: 0.05, delay: 0.18 }); },
    crFail() { tone(110, { type: 'sawtooth', dur: 0.42, vol: 0.2 }); tone(117, { type: 'square', dur: 0.42, vol: 0.1 }); noise({ dur: 0.3, vol: 0.25, filter: 'lowpass', from: 700, to: 80 }); },
    crAlarm() { [0, 0.44].forEach((d) => { tone(620, { type: 'sawtooth', dur: 0.2, vol: 0.11, delay: d }); tone(880, { type: 'sawtooth', dur: 0.2, vol: 0.11, delay: d + 0.22 }); }); },
    crEvent() { [0, 0.15, 0.3].forEach((d) => tone(1046, { type: 'square', dur: 0.09, vol: 0.11, delay: d })); },
    crWarp() { noise({ dur: 2.8, vol: 0.32, filter: 'bandpass', from: 180, to: 5200, q: 0.9 }); tone(70, { type: 'sawtooth', dur: 2.6, vol: 0.12, slide: 9, attack: 0.7 }); },
    crRelay() { tone(1400, { type: 'sine', dur: 0.08, vol: 0.12, slide: 1.5 }); tone(1900, { type: 'sine', dur: 0.1, vol: 0.1, delay: 0.09, slide: 0.8 }); },
    crPowerDown() { tone(620, { type: 'sawtooth', dur: 0.9, vol: 0.12, slide: 0.08 }); noise({ dur: 0.5, vol: 0.2, filter: 'lowpass', from: 1200, to: 60 }); },

    // ---------- Ball & Chain ----------
    bcPreload() { if (ctx) Object.values(BC_SAMPLES).forEach(loadSample); },
    bcHeave() {
      sample(BC_SAMPLES.jump, 0.35, 0.8 + Math.random() * 0.15);
      noise({ dur: 0.22, vol: 0.28, filter: 'bandpass', from: 500, to: 1800, q: 1.2 });
      tone(150, { type: 'triangle', dur: 0.2, vol: 0.25, slide: 1.6 });
    },
    // A chord that stacks up with every extra teammate in sync.
    bcSync(k) {
      const notes = [523, 659, 784, 1046, 1319, 1568];
      for (let i = 0; i < Math.min(k, notes.length); i++) tone(notes[i], { type: 'triangle', dur: 0.5, vol: 0.13, delay: i * 0.045 });
      if (k >= 3) tone(notes[Math.min(k, notes.length) - 1] * 2, { type: 'sine', dur: 0.6, vol: 0.07, delay: 0.2 });
    },
    bcCreak(v = 0.5) {
      noise({ dur: 0.18 + v * 0.15, vol: 0.12 + v * 0.12, filter: 'bandpass', from: 380 + Math.random() * 200, to: 900, q: 9 });
      tone(90 + Math.random() * 30, { type: 'sawtooth', dur: 0.2, vol: 0.05 * v, slide: 1.3 });
    },
    // Continuous rolling rumble for your team's ball (level 0..1).
    bcRumble(level) {
      if (!ready()) { Sfx.bcRumbleStop(); return; }
      const t = ctx.currentTime;
      if (!bcRumble) {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf; src.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 160; f.Q.value = 0.9;
        const g = ctx.createGain();
        g.gain.value = 0;
        src.connect(f); f.connect(g); g.connect(master);
        src.start();
        bcRumble = { src, f, g };
      }
      bcRumble.g.gain.setTargetAtTime(level * 0.32, t, 0.12);
      bcRumble.f.frequency.setTargetAtTime(110 + level * 260, t, 0.15);
    },
    bcRumbleStop() {
      if (!bcRumble) return;
      const r = bcRumble;
      bcRumble = null;
      try { r.g.gain.setTargetAtTime(0, ctx.currentTime, 0.08); setTimeout(() => r.src.stop(), 400); } catch { /* already stopped */ }
    },
    bcCheckpoint() {
      sample(BC_SAMPLES.coin, 0.4);
      [659, 784, 988, 1319].forEach((f, i) => tone(f, { type: 'square', dur: 0.14, vol: 0.09, delay: 0.05 + i * 0.07 }));
      tone(1319, { type: 'triangle', dur: 0.6, vol: 0.1, delay: 0.33 });
    },
    // A falling whistle, then a soft cloud poof.
    bcFall(big) {
      tone(big ? 1100 : 1400, { type: 'sine', dur: big ? 0.9 : 0.6, vol: 0.16, slide: 0.25, attack: 0.02 });
      noise({ dur: 0.8, vol: big ? 0.3 : 0.15, filter: 'lowpass', from: 900, to: 120, delay: big ? 0.8 : 0.55 });
    },
    bcLaunch() {
      tone(180, { type: 'sine', dur: 0.55, vol: 0.3, slide: 4 });
      noise({ dur: 0.6, vol: 0.3, filter: 'bandpass', from: 400, to: 4000, q: 0.8 });
      [1046, 1319, 1568].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.25, vol: 0.08, delay: 0.25 + i * 0.06 }));
    },
    bcBoing(v = 1) {
      const p = Math.max(0.3, Math.min(1, v));
      tone(420, { type: 'sine', dur: 0.35, vol: 0.28 * p, slide: 0.45 });
      tone(840, { type: 'triangle', dur: 0.22, vol: 0.08 * p, slide: 0.6 });
    },
    bcThump(v = 1) {
      const p = Math.max(0.2, Math.min(1, v));
      sample(BC_SAMPLES.impact, 0.5 * p, 0.9 + Math.random() * 0.2);
      tone(80, { type: 'sine', dur: 0.25, vol: 0.3 * p, slide: 0.5 });
    },
    bcAlarm() {
      [0, 0.28].forEach((d) => tone(880, { type: 'square', dur: 0.22, vol: 0.1, slide: 0.6, delay: d }));
    },
  };
  window.Sfx = Sfx;
})();
