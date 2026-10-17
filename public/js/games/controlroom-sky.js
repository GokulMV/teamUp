// Control Room viewport: a canvas starfield seen through the ship's window. Cruising stars,
// warp streaks between sectors, a planet per sector, and the team events (asteroid field,
// wormhole, ion storm, blackout) drawn into the same scene.
(function () {
  // One look per sector: nebula colours and a planet.
  const THEMES = [
    { neb: ['#7c5cff', '#ff4fa3'], planet: ['#ffd29a', '#ff7a45'], ring: true },
    { neb: ['#22d3ee', '#3b82f6'], planet: ['#a7f3d0', '#0d9488'], ring: false },
    { neb: ['#ff4fa3', '#ffb547'], planet: ['#fde68a', '#d97706'], ring: true },
    { neb: ['#34d399', '#22d3ee'], planet: ['#c4b5fd', '#6d28d9'], ring: false },
    { neb: ['#fb7185', '#7c5cff'], planet: ['#bae6fd', '#2563eb'], ring: true },
    { neb: ['#ffb547', '#ef4444'], planet: ['#fecaca', '#b91c1c'], ring: false },
  ];
  const STAR_COLORS = ['#ffffff', '#dbeafe', '#fde68a', '#fbcfe8', '#cffafe'];

  function rockShape(rand) {
    const n = 9 + Math.floor(rand() * 4);
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      const r = 0.72 + rand() * 0.34;
      return [Math.cos(a) * r, Math.sin(a) * r];
    });
  }

  class CrSky {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 1;
      this.h = 1;
      this.dpr = 1;
      this.speed = 0.08;
      this.targetSpeed = 0.08;
      this.event = null;
      this.dead = false;
      this.flash = 0;
      this.flashColor = '255,60,80';
      this.shake = 0;
      this.t = 0;
      this.theme = THEMES[0];
      this.crewColor = '#7c5cff';
      this.planet = { x: 0.78, y: 0.4, r: 0.12, drift: 0 };
      this.rocks = [];
      this.bolts = [];
      this.rockTimer = 0;
      this.boltTimer = 0;
      const count = matchMedia('(pointer: coarse)').matches ? 170 : 260;
      this.stars = Array.from({ length: count }, () => this.newStar(true));
      this.bg = document.createElement('canvas');
      this.resize = this.resize.bind(this);
      this.ro = new ResizeObserver(this.resize);
      this.ro.observe(canvas);
      this.resize();
      // Reduced motion: a calm, slow sky drawn at a low frame rate, no shaking.
      this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
      this.calm = this.motionQuery.matches;
      this.onMotion = () => { this.calm = this.motionQuery.matches; };
      this.motionQuery.addEventListener?.('change', this.onMotion);
      this.last = performance.now();
      this.frame = this.frame.bind(this);
      this.raf = requestAnimationFrame(this.frame);
    }

    newStar(anyDepth) {
      return {
        x: (Math.random() * 2 - 1) * 1.3,
        y: (Math.random() * 2 - 1) * 1.3,
        z: anyDepth ? 0.05 + Math.random() * 0.95 : 1,
        c: STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)],
      };
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      const coarse = matchMedia('(pointer: coarse)').matches;
      this.dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.75 : 2);
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.paintBackground();
    }

    setTheme(sector, crewColor) {
      const theme = THEMES[(Math.max(1, sector) - 1) % THEMES.length];
      if (theme === this.theme && crewColor === this.crewColor) return;
      this.theme = theme;
      this.crewColor = crewColor || this.crewColor;
      this.planet = { x: 0.64 + Math.random() * 0.22, y: 0.3 + Math.random() * 0.25, r: 0.1 + Math.random() * 0.05, drift: 0 };
      this.paintBackground();
    }

    // { warp: bool, event: type|null, dead: bool }
    setMode(mode) {
      this.targetSpeed = mode.warp ? 2.6 : mode.dead ? 0.015 : 0.08;
      if (mode.event !== this.event) {
        this.event = mode.event;
        this.rocks = [];
        this.bolts = [];
        // The asteroid field starts full, then more rocks keep coming from the distance.
        if (this.event === 'asteroid') for (let i = 0; i < 14; i++) this.rocks.push(this.newRock(0.35 + Math.random() * 0.9));
      }
      this.dead = !!mode.dead;
    }

    hit(color = '255,60,80', strength = 1) {
      this.flash = Math.max(this.flash, 0.55 * strength);
      this.flashColor = color;
      this.shake = Math.max(this.shake, 14 * strength);
    }

    paintBackground() {
      const { w, h, dpr } = this;
      const c = this.bg;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      const g = c.getContext('2d');
      g.scale(dpr, dpr);
      const base = g.createLinearGradient(0, 0, 0, h);
      base.addColorStop(0, '#04030c');
      base.addColorStop(1, '#0b0720');
      g.fillStyle = base;
      g.fillRect(0, 0, w, h);
      const blob = (x, y, r, color, a) => {
        const rg = g.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, color + Math.round(a * 255).toString(16).padStart(2, '0'));
        rg.addColorStop(1, color + '00');
        g.fillStyle = rg;
        g.fillRect(0, 0, w, h);
      };
      const [a, b] = this.theme.neb;
      const m = Math.max(w, h);
      // Wispy nebula: a few soft clouds towards the edges, the middle stays deep space.
      blob(w * 0.08, h * 0.15, m * 0.42, a, 0.26);
      blob(w * 0.3, h * 0.05, m * 0.25, a, 0.16);
      blob(w * 0.88, h * 1.05, m * 0.4, b, 0.22);
      blob(w * 0.62, h * 0.95, m * 0.22, b, 0.14);
      blob(w * 0.5, h * 1.2, m * 0.5, this.crewColor, 0.07);
      // Distant dust and a faint milky band.
      g.save();
      g.translate(w * 0.5, h * 0.5);
      g.rotate(-0.32);
      for (let i = 0; i < 520; i++) {
        const band = Math.random() < 0.55;
        const x = (Math.random() - 0.5) * w * 1.6;
        const y = band ? (Math.random() + Math.random() + Math.random() - 1.5) * h * 0.18 : (Math.random() - 0.5) * h * 1.6;
        g.fillStyle = `rgba(${Math.random() < 0.2 ? '200,190,255' : '255,255,255'},${Math.random() * (band ? 0.45 : 0.6)})`;
        const s = Math.random() < 0.06 ? 1.5 : 0.75;
        g.fillRect(x, y, s, s);
      }
      g.restore();
    }

    drawPlanet(g, dt) {
      const { w, h } = this;
      const p = this.planet;
      p.drift += dt * (this.speed > 0.5 ? 0.25 : 0.004);
      const r = p.r * Math.min(w, h * 1.6) * (1 + p.drift * 0.6);
      const x = w * p.x + p.drift * w * 0.4;
      const y = h * p.y + p.drift * h * 0.1;
      if (x - r > w) return;
      const [light, dark] = this.theme.planet;
      const ring = (front) => {
        if (!this.theme.ring) return;
        g.save();
        g.translate(x, y);
        g.rotate(-0.38);
        const from = front ? 0 : Math.PI;
        for (const [k, lw, a] of [[1.75, 0.07, front ? 'cc' : '66'], [2.05, 0.035, front ? '77' : '33']]) {
          g.strokeStyle = `${light}${a}`;
          g.lineWidth = Math.max(1.2, r * lw);
          g.beginPath(); g.ellipse(0, 0, r * k, r * k * 0.26, 0, from, from + Math.PI); g.stroke();
        }
        g.restore();
      };
      const glow = g.createRadialGradient(x, y, r * 0.9, x, y, r * 1.5);
      glow.addColorStop(0, `${dark}55`);
      glow.addColorStop(1, `${dark}00`);
      g.fillStyle = glow;
      g.beginPath(); g.arc(x, y, r * 1.5, 0, Math.PI * 2); g.fill();
      ring(false);
      const body = g.createRadialGradient(x - r * 0.45, y - r * 0.5, r * 0.1, x, y, r);
      body.addColorStop(0, light);
      body.addColorStop(0.55, dark);
      body.addColorStop(1, '#0b0820');
      g.fillStyle = body;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      // Bands.
      g.save();
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.clip();
      g.globalAlpha = 0.18;
      g.fillStyle = '#ffffff';
      for (let i = -2; i <= 2; i++) g.fillRect(x - r, y + i * r * 0.32 - r * 0.04, r * 2, r * 0.07);
      g.restore();
      ring(true);
    }

    drawStars(g, dt) {
      const { w, h } = this;
      const cx = w / 2;
      const cy = h * 0.46;
      const f = Math.max(w, h) * 0.55;
      const streak = Math.min(0.6, this.speed * 0.16);
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';
      for (const s of this.stars) {
        s.z -= this.speed * dt * 0.5;
        if (s.z <= 0.03) Object.assign(s, this.newStar(false));
        const x = cx + (s.x / s.z) * f;
        const y = cy + (s.y / s.z) * f;
        if (x < -40 || x > w + 40 || y < -40 || y > h + 40) { Object.assign(s, this.newStar(false)); continue; }
        const near = 1 - s.z;
        const a = Math.min(1, near * 1.3 + 0.3);
        const size = 0.7 + near * 2.4;
        if (streak > 0.02) {
          const z2 = s.z + streak * (0.4 + near);
          const x2 = cx + (s.x / z2) * f;
          const y2 = cy + (s.y / z2) * f;
          g.strokeStyle = s.c;
          g.globalAlpha = a;
          g.lineWidth = size;
          g.beginPath(); g.moveTo(x2, y2); g.lineTo(x, y); g.stroke();
        } else {
          g.fillStyle = s.c;
          g.globalAlpha = a * (0.75 + 0.25 * Math.sin(this.t * 3 + s.x * 40));
          g.beginPath(); g.arc(x, y, size * 0.6, 0, Math.PI * 2); g.fill();
        }
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    newRock(z) {
      return {
        x: (Math.random() * 2 - 1) * 0.75, y: (Math.random() * 2 - 1) * 0.5, z,
        rot: Math.random() * 6, spin: (Math.random() - 0.5) * 3, size: 0.05 + Math.random() * 0.09,
        shape: rockShape(Math.random), tint: 30 + Math.random() * 20,
      };
    }

    drawRocks(g, dt) {
      const { w, h } = this;
      this.rockTimer -= dt;
      while (this.rockTimer <= 0 && this.rocks.length < 24) {
        this.rockTimer += 0.07 + Math.random() * 0.14;
        this.rocks.push(this.newRock(1.25));
      }
      const cx = w / 2;
      const cy = h * 0.46;
      const f = Math.max(w, h) * 0.55;
      this.rocks.sort((a, b) => b.z - a.z);
      for (const r of this.rocks) {
        r.z -= dt * 0.42;
        r.rot += r.spin * dt;
        if (r.z <= 0.06) { r.dead = true; continue; }
        const x = cx + (r.x / r.z) * f;
        const y = cy + (r.y / r.z) * f;
        const s = (r.size / r.z) * f;
        g.save();
        g.translate(x, y);
        g.rotate(r.rot);
        const fade = Math.max(0, Math.min(1, (1.25 - r.z) * 4));
        g.globalAlpha = fade;
        const grad = g.createRadialGradient(-s * 0.4, -s * 0.4, s * 0.1, 0, 0, s * 1.1);
        grad.addColorStop(0, `hsl(${r.tint} 30% 74%)`);
        grad.addColorStop(0.55, `hsl(${r.tint} 22% 42%)`);
        grad.addColorStop(1, `hsl(${r.tint + 220} 30% 10%)`);
        g.fillStyle = grad;
        g.beginPath();
        r.shape.forEach(([px, py], i) => (i ? g.lineTo(px * s, py * s) : g.moveTo(px * s, py * s)));
        g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(255,200,150,0.35)';
        g.lineWidth = Math.max(1, s * 0.05);
        g.stroke();
        // Craters.
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.beginPath(); g.arc(s * 0.2, s * 0.15, s * 0.18, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(-s * 0.3, s * 0.3, s * 0.1, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      this.rocks = this.rocks.filter((r) => !r.dead);
    }

    drawWormhole(g) {
      const { w, h, t } = this;
      const cx = w / 2;
      const cy = h * 0.46;
      const R = Math.max(w, h) * 0.7;
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 22; i++) {
        const k = ((i / 22 + t * 0.12) % 1);
        const r = R * k * k;
        g.strokeStyle = `hsla(${265 + Math.sin(i + t) * 40}, 95%, ${55 + k * 20}%, ${0.5 * (1 - k)})`;
        g.lineWidth = 2 + k * 10;
        g.beginPath();
        g.ellipse(cx, cy, r, r * 0.62, t * 0.6 + i * 0.3, 0, Math.PI * 1.6);
        g.stroke();
      }
      g.globalCompositeOperation = 'source-over';
      const core = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.18);
      core.addColorStop(0, 'rgba(0,0,0,0.95)');
      core.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = core;
      g.fillRect(0, 0, w, h);
    }

    drawIonStorm(g, dt) {
      const { w, h } = this;
      this.boltTimer -= dt;
      const haze = g.createLinearGradient(0, 0, 0, h);
      const flick = 0.1 + Math.random() * 0.08;
      haze.addColorStop(0, `rgba(34,211,238,${flick})`);
      haze.addColorStop(0.6, 'rgba(34,211,238,0)');
      g.fillStyle = haze;
      g.fillRect(0, 0, w, h);
      if (this.boltTimer <= 0) {
        this.boltTimer = 0.12 + Math.random() * 0.35;
        const pts = [];
        let x = Math.random() * w;
        let y = 0;
        while (y < h) {
          pts.push([x, y]);
          x += (Math.random() - 0.5) * w * 0.12;
          y += h * (0.08 + Math.random() * 0.12);
        }
        pts.push([x, h]);
        this.bolts.push({ pts, life: 0.35 });
        this.flash = Math.max(this.flash, 0.18);
        this.flashColor = '120,220,255';
      }
      g.globalCompositeOperation = 'lighter';
      for (const b of this.bolts) {
        b.life -= dt;
        const a = Math.max(0, b.life / 0.35);
        for (const [lw, alpha] of [[9, 0.12], [3.5, 0.45], [1.4, 1]]) {
          g.strokeStyle = `rgba(150,235,255,${alpha * a})`;
          g.lineWidth = lw;
          g.beginPath();
          b.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
          g.stroke();
        }
      }
      g.globalCompositeOperation = 'source-over';
      this.bolts = this.bolts.filter((b) => b.life > 0);
    }

    frame(now) {
      this.raf = requestAnimationFrame(this.frame);
      if (!this.canvas.isConnected) return;
      if (this.calm && now - this.last < 90) return;
      const dt = Math.min(this.calm ? 0.1 : 0.05, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;
      const target = this.calm ? Math.min(this.targetSpeed, 0.3) : this.targetSpeed;
      this.speed += (target - this.speed) * Math.min(1, dt * (target > this.speed ? 1.6 : 2.4));
      if (this.calm) this.shake = 0;
      const g = this.ctx;
      const { w, h, dpr } = this;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.shake *= Math.exp(-dt * 7);
      const sx = (Math.random() - 0.5) * this.shake;
      const sy = (Math.random() - 0.5) * this.shake;
      g.translate(sx, sy);
      g.drawImage(this.bg, -8, -8, w + 16, h + 16);
      this.drawPlanet(g, dt);
      if (this.event === 'wormhole') this.drawWormhole(g);
      this.drawStars(g, dt);
      if (this.event === 'asteroid') this.drawRocks(g, dt);
      if (this.event === 'ionstorm') this.drawIonStorm(g, dt);
      if (this.speed > 0.6) {
        // Warp tunnel glow.
        const k = Math.min(1, (this.speed - 0.6) / 2);
        const rg = g.createRadialGradient(w / 2, h * 0.46, 0, w / 2, h * 0.46, Math.max(w, h) * 0.6);
        rg.addColorStop(0, `rgba(190,220,255,${0.35 * k})`);
        rg.addColorStop(0.4, `rgba(124,92,255,${0.18 * k})`);
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = rg;
        g.fillRect(0, 0, w, h);
      }
      if (this.event === 'blackout' || this.dead) {
        g.fillStyle = this.dead ? 'rgba(30,0,8,0.55)' : 'rgba(0,0,0,0.72)';
        g.fillRect(-10, -10, w + 20, h + 20);
        if (this.event === 'blackout') {
          // Emergency beacon sweeping round.
          const a = this.t * 3.2;
          const bx = w / 2 + Math.cos(a) * w * 0.6;
          const by = h * 0.5 + Math.sin(a) * h * 0.6;
          const rg = g.createRadialGradient(bx, by, 0, bx, by, Math.max(w, h) * 0.55);
          rg.addColorStop(0, 'rgba(255,40,60,0.35)');
          rg.addColorStop(1, 'rgba(255,40,60,0)');
          g.fillStyle = rg;
          g.fillRect(0, 0, w, h);
        }
      }
      if (this.flash > 0.01) {
        g.fillStyle = `rgba(${this.flashColor},${this.flash})`;
        g.fillRect(-10, -10, w + 20, h + 20);
        this.flash *= Math.exp(-dt * 5);
      }
    }

    destroy() {
      cancelAnimationFrame(this.raf);
      this.ro.disconnect();
      this.motionQuery.removeEventListener?.('change', this.onMotion);
    }
  }

  window.CrSky = CrSky;
})();
