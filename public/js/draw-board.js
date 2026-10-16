// A reusable drawing canvas. Coordinates are normalized to [0,1] so drawings
// look identical on every screen size.
(function () {
  const COLORS = ['#000000', '#ffffff', '#7f7f7f', '#ef4444', '#f97316', '#facc15', '#22c55e', '#06b6d4',
    '#3b82f6', '#8b5cf6', '#ec4899', '#92400e', '#fda4af', '#14532d'];
  const SIZES = [3, 7, 14, 28];
  const W = 800;
  const H = 600;

  class DrawBoard {
    constructor(container, opts = {}) {
      this.opts = opts;
      this.editable = !!opts.editable;
      this.strokes = [];
      this.color = '#000000';
      this.size = 7;
      this.erase = false;
      this.current = null;
      this.pending = [];
      this.strokeSeq = 0;

      this.el = document.createElement('div');
      this.el.className = 'board';
      this.el.innerHTML = '<div class="board-canvas-wrap"><canvas></canvas></div><div class="board-tools"></div>';
      container.appendChild(this.el);
      this.wrap = this.el.querySelector('.board-canvas-wrap');
      this.canvas = this.el.querySelector('canvas');
      this.canvas.width = W;
      this.canvas.height = H;
      this.ctx = this.canvas.getContext('2d');
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.tools = this.el.querySelector('.board-tools');

      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(this.wrap);
      this.clearCanvas();
      this.setEditable(this.editable);
      this.bindPointer();
      this.flushTimer = setInterval(() => this.flush(), 50);
    }

    fit() {
      const r = this.wrap.getBoundingClientRect();
      const scale = Math.max(0.1, Math.min((r.width - 16) / W, (r.height - 16) / H));
      this.canvas.style.width = `${W * scale}px`;
      this.canvas.style.height = `${H * scale}px`;
    }

    setEditable(editable) {
      this.editable = editable;
      this.tools.style.display = editable ? 'flex' : 'none';
      this.canvas.style.cursor = editable ? 'crosshair' : 'default';
      if (editable) this.renderTools();
      requestAnimationFrame(() => this.fit());
    }

    renderTools() {
      const t = this.tools;
      t.innerHTML = '';
      for (const c of COLORS) {
        const b = document.createElement('button');
        b.className = `swatch${!this.erase && c === this.color ? ' active' : ''}`;
        b.style.background = c;
        b.onclick = () => { this.color = c; this.erase = false; this.renderTools(); };
        t.appendChild(b);
      }
      for (const s of SIZES) {
        const b = document.createElement('button');
        b.className = `size-btn${s === this.size ? ' active' : ''}`;
        const d = Math.max(4, Math.min(24, s));
        b.innerHTML = `<i style="width:${d}px;height:${d}px"></i>`;
        b.onclick = () => { this.size = s; this.renderTools(); };
        t.appendChild(b);
      }
      const tool = (label, fn, active) => {
        const b = document.createElement('button');
        b.className = `tool-btn${active ? ' active' : ''}`;
        b.textContent = label;
        b.onclick = fn;
        t.appendChild(b);
      };
      tool('🧽 Eraser', () => { this.erase = true; this.renderTools(); }, this.erase);
      tool('↩️ Undo', () => this.undo());
      tool('🗑️ Clear', () => this.clear());
    }

    bindPointer() {
      const pos = (e) => {
        const r = this.canvas.getBoundingClientRect();
        return [
          Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
          Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
        ];
      };
      this.canvas.addEventListener('pointerdown', (e) => {
        if (!this.editable) return;
        e.preventDefault();
        this.canvas.setPointerCapture(e.pointerId);
        const p = pos(e);
        this.current = {
          id: `${Date.now().toString(36)}-${this.strokeSeq++}`,
          color: this.erase ? '#ffffff' : this.color,
          size: this.erase ? Math.max(this.size, 14) : this.size,
          erase: this.erase,
          last: p,
        };
        // A dot: send the same point twice so a single click still draws.
        this.pending.push(p[0], p[1], p[0] + 0.0001, p[1]);
        this.flush();
      });
      this.canvas.addEventListener('pointermove', (e) => {
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
      };
      this.canvas.addEventListener('pointerup', end);
      this.canvas.addEventListener('pointercancel', end);
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

    clearCanvas() {
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, W, H);
    }

    drawStroke(s) {
      const ctx = this.ctx;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
      ctx.beginPath();
      ctx.moveTo(s.pts[0] * W, s.pts[1] * H);
      for (let i = 2; i < s.pts.length; i += 2) ctx.lineTo(s.pts[i] * W, s.pts[i + 1] * H);
      ctx.stroke();
    }

    addStroke(s) {
      this.strokes.push(s);
      this.drawStroke(s);
    }

    setStrokes(list) {
      this.strokes = [...list];
      this.clearCanvas();
      for (const s of this.strokes) this.drawStroke(s);
    }

    undo() {
      if (this.opts.onUndo) { this.opts.onUndo(); return; }
      const last = this.strokes[this.strokes.length - 1];
      if (last) this.setStrokes(this.strokes.filter((s) => s.id !== last.id));
    }

    clear() {
      if (this.opts.onClear) { this.opts.onClear(); return; }
      this.setStrokes([]);
    }

    toDataURL() {
      return this.canvas.toDataURL('image/png');
    }

    destroy() {
      clearInterval(this.flushTimer);
      this.resizeObserver.disconnect();
      this.el.remove();
    }
  }

  window.DrawBoard = DrawBoard;
})();
