// A reusable drawing canvas. Coordinates are normalized to [0,1] so drawings look identical on every
// screen. Operations are strokes ({id, color, size, pts}) and fills ({id, fill, x, y, color}); the
// picture is always rebuilt by replaying them in order, so undo/redraw stay exact.
(function () {
  const COLORS = ['#000000', '#4b5563', '#9ca3af', '#ffffff', '#7f1d1d', '#ef4444', '#f97316', '#facc15',
    '#a3e635', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#1e3a8a', '#8b5cf6', '#ec4899', '#fda4af', '#92400e'];
  const SIZES = [3, 7, 14, 26, 44];
  const W = 800;
  const H = 600;

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }

  class DrawBoard {
    constructor(container, opts = {}) {
      this.opts = opts;
      this.strokes = [];
      this.color = '#000000';
      this.size = 7;
      this.tool = 'pen'; // pen | eraser | fill
      this.current = null;
      this.pending = [];
      this.seq = 0;
      this.background = null; // an image drawn under everything (complement mode)
      this.blind = !!opts.blind;

      this.el = document.createElement('div');
      this.el.className = 'board';
      this.el.innerHTML = `
        <div class="board-canvas-wrap"><div class="board-paper"><canvas></canvas><canvas class="board-live"></canvas></div></div>
        <div class="board-tools"></div>`;
      container.appendChild(this.el);
      this.wrap = this.el.querySelector('.board-canvas-wrap');
      this.paper = this.el.querySelector('.board-paper');
      [this.canvas, this.live] = this.el.querySelectorAll('canvas');
      for (const c of [this.canvas, this.live]) { c.width = W; c.height = H; }
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.lctx = this.live.getContext('2d');
      for (const c of [this.ctx, this.lctx]) { c.lineCap = 'round'; c.lineJoin = 'round'; }
      this.tools = this.el.querySelector('.board-tools');
      if (this.blind) this.paper.classList.add('blind');

      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(this.wrap);
      this.redraw();
      this.setEditable(!!opts.editable);
      this.bindPointer();
      this.flushTimer = setInterval(() => this.flush(), 50);
    }

    fit() {
      const r = this.wrap.getBoundingClientRect();
      const scale = Math.max(0.1, Math.min((r.width - 8) / W, (r.height - 8) / H));
      this.paper.style.width = `${W * scale}px`;
      this.paper.style.height = `${H * scale}px`;
    }

    setEditable(editable) {
      // Rebuilding the tools mid-tap would swallow the tap (and close the colour picker).
      if (editable === this.editable) return;
      this.editable = editable;
      this.el.classList.toggle('editable', editable);
      this.tools.style.display = editable ? '' : 'none';
      if (editable) this.renderTools();
      requestAnimationFrame(() => this.fit());
    }

    renderTools() {
      const t = this.tools;
      const swatches = COLORS.map((c) => `<button class="swatch${this.tool !== 'eraser' && c === this.color ? ' active' : ''}" data-color="${c}" style="--c:${c}" title="${c}"></button>`).join('');
      const sizes = SIZES.map((s) => `<button class="size-btn${s === this.size ? ' active' : ''}" data-size="${s}" title="Brush ${s}"><i style="--d:${Math.max(4, Math.min(26, s * 0.6))}px"></i></button>`).join('');
      const tool = (id, icon, label) => `<button class="tool-btn${this.tool === id ? ' active' : ''}" data-tool="${id}" title="${label}">${icon}<span>${label}</span></button>`;
      t.innerHTML = `
        <div class="tool-group colors">${swatches}<label class="swatch custom" title="Pick any colour" style="--c:${this.color}"><input type="color" value="${this.color}"></label></div>
        <div class="tool-group sizes">${sizes}</div>
        <div class="tool-group tools">
          ${tool('pen', '✏️', 'Pen')}${tool('fill', '🪣', 'Fill')}${tool('eraser', '🧽', 'Eraser')}
          <button class="tool-btn" data-act="undo" title="Undo (Ctrl+Z)">↩️<span>Undo</span></button>
          <button class="tool-btn" data-act="clear" title="Clear">🗑️<span>Clear</span></button>
        </div>
        <div class="tool-group extra"></div>`;
      t.onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.color) { this.color = b.dataset.color; if (this.tool === 'eraser') this.tool = 'pen'; }
        if (b.dataset.size) this.size = Number(b.dataset.size);
        if (b.dataset.tool) this.tool = b.dataset.tool;
        if (b.dataset.act === 'undo') this.undo();
        if (b.dataset.act === 'clear') this.clear();
        this.renderTools();
      };
      t.querySelector('input[type=color]').oninput = (e) => { this.color = e.target.value; if (this.tool === 'eraser') this.tool = 'pen'; this.renderTools(); };
      this.extra = t.querySelector('.extra');
      this.opts.onTools?.(this.extra);
    }

    bindPointer() {
      const pos = (e) => {
        const r = this.canvas.getBoundingClientRect();
        return [
          Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
          Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
        ];
      };
      const target = this.live;
      target.addEventListener('pointerdown', (e) => {
        if (!this.editable) return;
        e.preventDefault();
        const p = pos(e);
        if (this.tool === 'fill') {
          const op = { id: `${Date.now().toString(36)}-${this.seq++}`, fill: true, x: Math.round(p[0] * 10000) / 10000, y: Math.round(p[1] * 10000) / 10000, color: this.color };
          this.addStroke(op);
          this.opts.onStroke?.(op);
          return;
        }
        target.setPointerCapture(e.pointerId);
        const erase = this.tool === 'eraser';
        this.current = {
          id: `${Date.now().toString(36)}-${this.seq++}`,
          color: erase ? '#ffffff' : this.color,
          size: erase ? Math.max(this.size, 14) : this.size,
          erase,
          last: p,
        };
        // A dot: send the same point twice so a single click still draws.
        this.pending.push(p[0], p[1], p[0] + 0.0001, p[1]);
        this.flush();
      });
      target.addEventListener('pointermove', (e) => {
        if (!this.current) return;
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events) {
          const p = pos(ev);
          if (!this.pending.length) this.pending.push(this.current.last[0], this.current.last[1]);
          this.pending.push(p[0], p[1]);
          this.current.last = p;
        }
      });
      const end = () => {
        if (!this.current) return;
        this.flush();
        this.current = null;
        if (this.blind) setTimeout(() => this.lctx.clearRect(0, 0, W, H), 350);
      };
      target.addEventListener('pointerup', end);
      target.addEventListener('pointercancel', end);
      this.keyHandler = (e) => {
        // Ctrl+Z in the chat box undoes the typing there, not the drawing.
        const t = e.target;
        if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
        if (this.editable && (e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); this.undo(); }
      };
      window.addEventListener('keydown', this.keyHandler);
    }

    flush() {
      if (!this.current || this.pending.length < 4) return;
      const stroke = {
        id: this.current.id, color: this.current.color, size: this.current.size, erase: this.current.erase,
        pts: this.pending.map((n) => Math.round(n * 10000) / 10000),
      };
      this.pending = [];
      this.addStroke(stroke);
      this.opts.onStroke?.(stroke);
    }

    drawStroke(s, ctx = this.ctx) {
      // On a picture to add to (complement mode) the eraser brings the picture back, not white.
      ctx.strokeStyle = s.erase && this.bgPattern && ctx === this.ctx ? this.bgPattern : s.color;
      ctx.lineWidth = s.size;
      ctx.beginPath();
      ctx.moveTo(s.pts[0] * W, s.pts[1] * H);
      for (let i = 2; i < s.pts.length; i += 2) ctx.lineTo(s.pts[i] * W, s.pts[i + 1] * H);
      ctx.stroke();
    }

    // Scanline flood fill on the raster, with a little colour tolerance for anti-aliased edges.
    floodFill(op) {
      const x0 = Math.min(W - 1, Math.floor(op.x * W));
      const y0 = Math.min(H - 1, Math.floor(op.y * H));
      const img = this.ctx.getImageData(0, 0, W, H);
      const d = img.data;
      const i0 = (y0 * W + x0) * 4;
      const [tr, tg, tb] = [d[i0], d[i0 + 1], d[i0 + 2]];
      const [fr, fg, fb] = hexToRgb(op.color);
      if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 6) return;
      const tol = 90;
      const match = (i) => Math.abs(d[i] - tr) + Math.abs(d[i + 1] - tg) + Math.abs(d[i + 2] - tb) <= tol;
      const seen = new Uint8Array(W * H);
      const stack = [x0, y0];
      while (stack.length) {
        const y = stack.pop();
        let x = stack.pop();
        while (x >= 0 && !seen[y * W + x] && match((y * W + x) * 4)) x--;
        x++;
        let up = false;
        let down = false;
        while (x < W && !seen[y * W + x] && match((y * W + x) * 4)) {
          const p = y * W + x;
          seen[p] = 1;
          d[p * 4] = fr; d[p * 4 + 1] = fg; d[p * 4 + 2] = fb; d[p * 4 + 3] = 255;
          if (y > 0) {
            const q = p - W;
            if (!seen[q] && match(q * 4)) { if (!up) { stack.push(x, y - 1); up = true; } } else up = false;
          }
          if (y < H - 1) {
            const q = p + W;
            if (!seen[q] && match(q * 4)) { if (!down) { stack.push(x, y + 1); down = true; } } else down = false;
          }
          x++;
        }
      }
      this.ctx.putImageData(img, 0, 0);
    }

    apply(op) {
      if (op.fill) this.floodFill(op);
      else this.drawStroke(op);
      // Blind drawing: only the line you're drawing right now shows, briefly.
      if (this.blind && !op.fill) this.drawStroke(op, this.lctx);
    }

    addStroke(op) {
      this.strokes.push(op);
      this.apply(op);
    }

    redraw() {
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, W, H);
      if (this.background) this.ctx.drawImage(this.background, 0, 0, W, H);
      for (const s of this.strokes) {
        if (s.fill) this.floodFill(s);
        else this.drawStroke(s);
      }
    }

    setStrokes(list) {
      this.strokes = [...list];
      this.redraw();
    }

    // Start from an existing picture (a data URL); undo never removes it.
    setBackground(src) {
      if (!src) return Promise.resolve();
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          this.background = img;
          const under = document.createElement('canvas');
          under.width = W;
          under.height = H;
          const u = under.getContext('2d');
          u.fillStyle = '#ffffff';
          u.fillRect(0, 0, W, H);
          u.drawImage(img, 0, 0, W, H);
          this.bgPattern = this.ctx.createPattern(under, 'no-repeat');
          this.redraw();
          resolve();
        };
        img.onerror = () => resolve();
        img.src = src;
      });
    }

    // Undo and clear happen here at once; onUndo / onClear tell everyone else.
    undo() {
      const last = this.strokes[this.strokes.length - 1];
      if (!last) return;
      this.setStrokes(this.strokes.filter((s) => s.id !== last.id));
      this.opts.onUndo?.(last.id);
    }

    clear() {
      this.setStrokes([]);
      this.opts.onClear?.();
    }

    // Back to the pen (a new turn shouldn't start with the fill bucket that floods the page).
    resetTool() {
      this.tool = 'pen';
      if (this.editable) this.renderTools();
    }

    toDataURL() {
      return this.canvas.toDataURL('image/png');
    }

    // Nothing drawn (or everything undone): the picture underneath, if any, doesn't count.
    isBlank() {
      return !this.strokes.length;
    }

    // The picture as a data URL of at most about maxBytes: a PNG when it fits, else WebP (where
    // the browser can make it), else a JPEG at falling quality. `smaller`: skip straight to JPEG.
    exportImage(maxBytes = 1_400_000, smaller = false) {
      if (!smaller) {
        const png = this.canvas.toDataURL('image/png');
        if (png.length <= maxBytes) return png;
        const webp = this.canvas.toDataURL('image/webp', 0.9);
        if (webp.startsWith('data:image/webp') && webp.length <= maxBytes) return webp;
      }
      for (const quality of [0.85, 0.7, 0.5]) {
        const jpg = this.canvas.toDataURL('image/jpeg', quality);
        if (jpg.length <= maxBytes) return jpg;
      }
      return this.canvas.toDataURL('image/jpeg', 0.35);
    }

    destroy() {
      clearInterval(this.flushTimer);
      window.removeEventListener('keydown', this.keyHandler);
      this.resizeObserver.disconnect();
      this.el.remove();
    }
  }

  window.DrawBoard = DrawBoard;
})();
