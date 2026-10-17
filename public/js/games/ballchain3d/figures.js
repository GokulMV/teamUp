// Stick figures for Ball & Chain: chunky rounded limbs in the player's colour, a team-colour band,
// and a round head wearing the player's avatar face. Every body part of every figure is drawn by a
// handful of instanced meshes, and posed procedurally each frame (run, brace, heave, flail, dance).
import * as THREE from 'three';

const CELL_COLS = 6;
const CELL_ROWS = 4;
const CELL = 128;

// Avatar faces (without their round background) packed into one texture.
let atlas = null;
export function faceAtlas() {
  if (atlas) return atlas;
  const canvas = document.createElement('canvas');
  canvas.width = CELL * CELL_COLS;
  canvas.height = CELL * CELL_ROWS;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const A = window.Avatars;
  const count = A ? A.COUNT : 24;
  const ready = [];
  for (let id = 0; id < count; id++) {
    const cx = (id % CELL_COLS) * CELL;
    const cy = Math.floor(id / CELL_COLS) * CELL;
    const body = A ? A.color(id) : '#f9a8d4';
    ctx.fillStyle = body;
    ctx.fillRect(cx, cy, CELL, CELL);
    if (!A) continue;
    const svg = A.svg(id)
      .replace(/<circle cx="50" cy="50" r="50"[^>]*\/>/, '')
      .replace(/<ellipse cx="50" cy="94"[^>]*\/>/, '')
      .replace('viewBox="0 0 100 100"', `viewBox="14 14 72 72" width="${CELL}" height="${CELL}"`);
    const img = new Image();
    ready.push(new Promise((resolve) => {
      img.onload = () => {
        ctx.save();
        ctx.beginPath(); ctx.rect(cx, cy, CELL, CELL); ctx.clip();
        ctx.drawImage(img, cx, cy, CELL, CELL);
        ctx.restore();
        texture.needsUpdate = true;
        resolve();
      };
      img.onerror = resolve;
    }));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  atlas = { canvas, texture, ready: Promise.all(ready) };
  return atlas;
}
export const cellOf = (id) => {
  const i = ((id % 24) + 24) % 24;
  return [(i % CELL_COLS) / CELL_COLS, 1 - (Math.floor(i / CELL_COLS) + 1) / CELL_ROWS];
};

const FIG_SCALE = 1.5; // figures are ~78 units tall next to a 108-unit ball: medium height, easy to read from the camera
const BONES = 10; // torso, pelvis bar, 2x upper arm, 2x forearm, 2x thigh, 2x shin
const JOINTS = 14;
const UP = new THREE.Vector3(0, 1, 0);
const ease = (t) => 1 - (1 - t) * (1 - t);
const lerp = (a, b, t) => a + (b - a) * t;

export class Figures {
  constructor(scene, list, { mobile = false } = {}) {
    // list: [{ idx, color, team, teamColor, avatar }]
    this.list = list;
    this.byIdx = new Map();
    const n = list.length;
    const boneGeo = new THREE.CylinderGeometry(1, 1, 1, mobile ? 8 : 10, 1, true);
    const jointGeo = new THREE.SphereGeometry(1, mobile ? 8 : 10, mobile ? 6 : 7);
    const skin = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0 });
    this.bones = new THREE.InstancedMesh(boneGeo, skin, n * BONES);
    this.joints = new THREE.InstancedMesh(jointGeo, skin, n * JOINTS);
    this.bands = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.3, 8, 20).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 0.3, emissive: 0x000000 }), n);
    // Heads: front hemisphere shows the avatar face from the atlas, the rest is the avatar's colour.
    const at = faceAtlas();
    const headGeo = new THREE.SphereGeometry(1, mobile ? 16 : 22, mobile ? 12 : 16);
    const cells = new Float32Array(n * 2);
    const bodies = new Float32Array(n * 3);
    const headMat = new THREE.MeshStandardMaterial({ map: at.texture, roughness: 0.4 });
    headMat.onBeforeCompile = (sh) => {
      sh.uniforms.uCellSize = { value: new THREE.Vector2(1 / CELL_COLS, 1 / CELL_ROWS) };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aCell;\nattribute vec3 aBody;\nvarying vec2 vCell;\nvarying vec3 vBody;\nvarying vec3 vObj;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCell = aCell; vBody = aBody; vObj = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vCell;\nvarying vec3 vBody;\nvarying vec3 vObj;\nuniform vec2 uCellSize;')
        .replace('#include <map_fragment>', `
          vec3 hn = normalize(vObj);
          float front = smoothstep(0.08, 0.32, hn.z);
          vec2 fuv = clamp(vec2(-hn.x, hn.y) * 0.5 + 0.5, 0.01, 0.99);
          vec4 face = texture2D(map, vCell + fuv * uCellSize);
          diffuseColor.rgb *= mix(vBody, face.rgb, front);`);
    };
    headGeo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    headGeo.setAttribute('aBody', new THREE.InstancedBufferAttribute(bodies, 3));
    this.heads = new THREE.InstancedMesh(headGeo, headMat, n);
    for (const m of [this.bones, this.joints, this.bands, this.heads]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
    }
    this.scene = scene;
    const c = new THREE.Color();
    const white = new THREE.Color(0xffffff);
    const shoe = new THREE.Color(0x2d2650);
    list.forEach((meta, i) => {
      const body = new THREE.Color(meta.color);
      const team = new THREE.Color(meta.teamColor);
      for (let b = 0; b < BONES; b++) this.bones.setColorAt(i * BONES + b, b === 0 ? body : body);
      for (let j = 0; j < JOINTS; j++) {
        // 4,5 hands (white gloves); 10,11 feet (shoes)
        const col = j === 4 || j === 5 ? white : j === 10 || j === 11 ? shoe : body;
        this.joints.setColorAt(i * JOINTS + j, col);
      }
      this.bands.setColorAt(i, team);
      const [u, v] = cellOf(meta.avatar || 0);
      cells[i * 2] = u; cells[i * 2 + 1] = v;
      c.set(window.Avatars ? window.Avatars.color(meta.avatar || 0) : meta.color);
      bodies[i * 3] = c.r; bodies[i * 3 + 1] = c.g; bodies[i * 3 + 2] = c.b;
      this.byIdx.set(meta.idx, {
        i, meta, yaw: 0, phase: Math.random() * 6, stride: 0, lean: 0, roll: 0, crouch: 0, spread: 0,
        heave: 0, yank: 0, fall: 0, flail: 0, dance: 0, grip: new THREE.Vector3(), hands: new THREE.Vector3(), seen: false,
        lastFlags: 0, dropY: 0, dropV: 0, spin: 0,
      });
    });
    this.tmp = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3(), d: new THREE.Vector3() };
    this.hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  }

  // Place a bone (unit cylinder along y) between two world points.
  setBone(k, a, b, r) {
    const { m, q, s, p, d } = this.tmp;
    d.subVectors(b, a);
    const len = d.length() || 0.001;
    q.setFromUnitVectors(UP, d.multiplyScalar(1 / len));
    m.compose(p.addVectors(a, b).multiplyScalar(0.5), q, s.set(r, len, r));
    this.bones.setMatrixAt(k, m);
  }

  setJoint(k, at, r, sy = 1, yaw = 0) {
    const { m, q, s } = this.tmp;
    q.setFromAxisAngle(UP, yaw);
    m.compose(at, q, s.set(r, r * sy, r * (sy === 1 ? 1 : 1.5)));
    this.joints.setMatrixAt(k, m);
  }

  hide(f) {
    for (let b = 0; b < BONES; b++) this.bones.setMatrixAt(f.i * BONES + b, this.hidden);
    for (let j = 0; j < JOINTS; j++) this.joints.setMatrixAt(f.i * JOINTS + j, this.hidden);
    this.bands.setMatrixAt(f.i, this.hidden);
    this.heads.setMatrixAt(f.i, this.hidden);
  }

  // s: { idx, X, Y (ground height), Z, vx, vz (world velocity), flags, rope: { x, z } world direction
  //      toward the rope's next anchor or null, taut (0..1), finished, gone }
  pose(s, dt, t) {
    const f = this.byIdx.get(s.idx);
    if (!f) return null;
    if (s.gone || s.hidden) { this.hide(f); f.seen = false; return null; }
    const flags = s.flags;
    const braced = !!(flags & 1);
    const heaving = !!(flags & 2);
    const falling = !!(flags & 4);
    const stunned = !!(flags & 8);
    const yanked = !!(flags & 16);
    const dancing = !!(flags & 64);
    const speed = Math.hypot(s.vx, s.vz);
    const rope = s.rope;

    // Facing.
    let targetYaw = f.yaw;
    if ((braced || heaving) && rope) targetYaw = Math.atan2(rope.x, rope.z);
    else if (speed > 25) targetYaw = Math.atan2(s.vx, s.vz);
    if (!f.seen) f.yaw = targetYaw;
    let dy = targetYaw - f.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    f.yaw += dy * Math.min(1, dt * (stunned ? 3 : 12));
    if (dancing) f.yaw += dt * 2.2;
    if (stunned) f.spin += dt * 9; else f.spin *= Math.max(0, 1 - dt * 6);
    const yaw = f.yaw + Math.sin(f.spin) * 0.8;
    f.seen = true;

    // Timers.
    if (heaving && !(f.lastFlags & 2)) f.heave = 1;
    f.heave = Math.max(0, f.heave - dt / 0.38);
    if (yanked && !(f.lastFlags & 16)) f.yank = 1;
    f.yank = Math.max(0, f.yank - dt * 2.6);
    f.flail = lerp(f.flail, falling || stunned ? 1 : 0, Math.min(1, dt * 8));
    f.dance = lerp(f.dance, dancing ? 1 : 0, Math.min(1, dt * 4));
    if (falling) { f.dropV -= 900 * dt; f.dropY += f.dropV * dt; } else { f.dropY = 0; f.dropV = 60; }
    f.lastFlags = flags;

    // Body posture.
    const run = Math.min(1, speed / 200);
    f.phase += (speed * dt) / 26 * Math.PI;
    const pulling = rope && s.taut > 0.6 && !braced;
    const ropeLocalZ = rope ? rope.x * Math.sin(yaw) + rope.z * Math.cos(yaw) : 0; // + = rope in front
    let lean = run * 0.18 + (pulling && ropeLocalZ < 0 ? 0.32 * s.taut : 0);
    let crouch = 0;
    let spread = 0;
    if (braced) { lean = -0.55; crouch = 5; spread = 0.45; }
    if (f.heave > 0) {
      const p = 1 - f.heave;
      lean = lerp(0.35, -0.75, ease(Math.min(1, p * 1.6)));
      crouch = 3;
    }
    if (f.yank > 0) lean = lerp(lean, 0.75, f.yank);
    if (f.flail > 0.01) lean += Math.sin(t * 13 + f.i) * 0.5 * f.flail;
    f.lean = lerp(f.lean, lean, Math.min(1, dt * 14));
    f.crouch = lerp(f.crouch, crouch, Math.min(1, dt * 10));
    f.spread = lerp(f.spread, spread, Math.min(1, dt * 10));
    const roll = f.flail * Math.sin(t * 9 + f.i * 2) * 0.5;

    // Local skeleton (feet at y = 0, facing +z), then into the world.
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const S = FIG_SCALE;
    const W = (x, y, z, out) => out.set(s.X + (x * cy + z * sy) * S, y, s.Z + (-x * sy + z * cy) * S);
    const legA = (phase, side) => {
      const amp = 0.75 * run * (1 - f.dance);
      const a = Math.sin(phase) * amp + (braced ? side * 0.35 : 0) + f.flail * Math.sin(t * 16 + side) * 0.9;
      const knee = 0.12 + Math.max(0, Math.sin(phase + Math.PI / 2)) * amp * 1.3 + f.crouch * 0.08 + f.flail * 0.6;
      return [a, knee];
    };
    const hipY = 20 - f.crouch;
    const pelvis = [0, hipY, 0];
    const tl = f.lean;
    const torsoDir = [Math.sin(roll), Math.cos(tl) * Math.cos(roll), Math.sin(tl)];
    const chest = [pelvis[0] + torsoDir[0] * 14, pelvis[1] + torsoDir[1] * 14, pelvis[2] + torsoDir[2] * 14];
    const head = [pelvis[0] + torsoDir[0] * 24.5, pelvis[1] + torsoDir[1] * 24.5, pelvis[2] + torsoDir[2] * 24.5];
    const legs = [-1, 1].map((side) => {
      const [a, k] = legA(f.phase + (side > 0 ? Math.PI : 0), side);
      const spreadX = side * (4.5 + f.spread * 7);
      const hip = [spreadX * 0.6, hipY, 0];
      const knee = [spreadX * 0.8, hip[1] - Math.cos(a) * 10.5, hip[2] + Math.sin(a) * 10.5];
      const foot = [spreadX, knee[1] - Math.cos(a - k) * 10.5, knee[2] + Math.sin(a - k) * 10.5];
      return { hip, knee, foot };
    });
    // Keep the lower foot on the ground.
    const minFoot = Math.min(legs[0].foot[1], legs[1].foot[1]);
    let lift = -minFoot + 1.5;
    if (f.dance > 0.01) lift += Math.abs(Math.sin(t * 7 + f.i)) * 9 * f.dance;
    const baseY = lift;
    const groundY = s.Y + f.dropY;

    // Hands: on the rope, pulled in on a heave, waving when dancing, flailing when falling.
    const shoulders = [-1, 1].map((side) => [chest[0] + side * 7 * Math.cos(roll), chest[1] - 1.5 - side * 7 * Math.sin(roll), chest[2]]);
    let gripL = [0, 0, 0];
    if (rope) {
      const lx = rope.x * cy - rope.z * sy;
      const lz = rope.x * sy + rope.z * cy;
      if (lz < -0.25 && !braced && f.heave <= 0) {
        // Rope behind: hands behind the back at the hip, dragging.
        gripL = [lx * 6, hipY + 3, -7];
      } else {
        const reach = braced ? 15 : f.heave > 0 ? lerp(5, 17, f.heave) : 13;
        gripL = [chest[0] + lx * reach, chest[1] - 5, chest[2] + lz * reach];
      }
    } else {
      gripL = [0, hipY + 2, 8];
    }
    const hands = [-1, 1].map((side) => {
      let h = [gripL[0] + side * 1.8, gripL[1] - side * 0.6, gripL[2] - side * 1.5];
      if (!rope) h = [side * 9, hipY + 2 + Math.sin(f.phase + (side > 0 ? 0 : Math.PI)) * 2, Math.sin(f.phase + (side > 0 ? Math.PI : 0)) * 6 * run];
      if (f.dance > 0.01) h = h.map((v, k) => lerp(v, [side * 11, chest[1] + 15 + Math.sin(t * 10 + side) * 4, 3][k], f.dance));
      if (f.flail > 0.01) {
        const w = [side * (12 + Math.sin(t * 17 + side) * 6), chest[1] + 6 + Math.sin(t * 14 + side * 2) * 9, Math.cos(t * 15 + side) * 9];
        h = h.map((v, k) => lerp(v, w[k], f.flail));
      }
      if (f.yank > 0 && rope) h = h.map((v, k) => lerp(v, [side * 6, chest[1] - 2, 16][k], f.yank * 0.6));
      return h;
    });
    const arms = [0, 1].map((k) => {
      const sh = shoulders[k];
      const hd = hands[k];
      const dx = hd[0] - sh[0];
      const dyy = hd[1] - sh[1];
      const dz = hd[2] - sh[2];
      let d = Math.hypot(dx, dyy, dz);
      const L = 9.5;
      let hand = hd;
      if (d > L * 2 - 0.2) {
        const kk = (L * 2 - 0.2) / d;
        hand = [sh[0] + dx * kk, sh[1] + dyy * kk, sh[2] + dz * kk];
        d = L * 2 - 0.2;
      }
      // Elbow bends out and down from the shoulder-hand line.
      const mid = [(sh[0] + hand[0]) / 2, (sh[1] + hand[1]) / 2, (sh[2] + hand[2]) / 2];
      const h = Math.sqrt(Math.max(0, L * L - (d / 2) * (d / 2)));
      const side = k === 0 ? -1 : 1;
      let px = side * 0.8;
      let py = -0.6;
      let pz = -0.2;
      const ux = (hand[0] - sh[0]) / (d || 1);
      const uy = (hand[1] - sh[1]) / (d || 1);
      const uz = (hand[2] - sh[2]) / (d || 1);
      const dot = px * ux + py * uy + pz * uz;
      px -= dot * ux; py -= dot * uy; pz -= dot * uz;
      const pl = Math.hypot(px, py, pz) || 1;
      const elbow = [mid[0] + (px / pl) * h, mid[1] + (py / pl) * h, mid[2] + (pz / pl) * h];
      return { sh, elbow, hand };
    });

    const P = (a, out) => W(a[0], groundY + (a[1] + baseY) * S, a[2], out);
    const v = (a) => P(a, new THREE.Vector3());
    const bi = f.i * BONES;
    const ji = f.i * JOINTS;
    const pelvisW = v(pelvis);
    const chestW = v(chest);
    this.setBone(bi, pelvisW, chestW, 5.2 * S);
    const hipL = v(legs[0].hip);
    const hipR = v(legs[1].hip);
    this.setBone(bi + 1, hipL, hipR, 3.6 * S);
    const armW = arms.map((a) => ({ sh: v(a.sh), el: v(a.elbow), ha: v(a.hand) }));
    armW.forEach((a, k) => {
      this.setBone(bi + 2 + k * 2, a.sh, a.el, 2.9 * S);
      this.setBone(bi + 3 + k * 2, a.el, a.ha, 2.7 * S);
    });
    const legW = legs.map((l) => ({ hip: v(l.hip), knee: v(l.knee), foot: v(l.foot) }));
    legW.forEach((l, k) => {
      this.setBone(bi + 6 + k * 2, l.hip, l.knee, 3.4 * S);
      this.setBone(bi + 7 + k * 2, l.knee, l.foot, 3.1 * S);
    });
    // Joints: shoulders, elbows, hands, hips, knees, feet, chest, pelvis.
    this.setJoint(ji, armW[0].sh, 3.4 * S); this.setJoint(ji + 1, armW[1].sh, 3.4 * S);
    this.setJoint(ji + 2, armW[0].el, 3 * S); this.setJoint(ji + 3, armW[1].el, 3 * S);
    this.setJoint(ji + 4, armW[0].ha, 3.6 * S); this.setJoint(ji + 5, armW[1].ha, 3.6 * S);
    this.setJoint(ji + 6, legW[0].hip, 3.6 * S); this.setJoint(ji + 7, legW[1].hip, 3.6 * S);
    this.setJoint(ji + 8, legW[0].knee, 3.3 * S); this.setJoint(ji + 9, legW[1].knee, 3.3 * S);
    this.setJoint(ji + 10, legW[0].foot.setY(legW[0].foot.y + 0.6 * S), 3.8 * S, 0.62, yaw);
    this.setJoint(ji + 11, legW[1].foot.setY(legW[1].foot.y + 0.6 * S), 3.8 * S, 0.62, yaw);
    this.setJoint(ji + 12, chestW, 5.6 * S);
    this.setJoint(ji + 13, pelvisW, 5.4 * S);
    // Team band round the chest.
    const { m, q, s: sc, d } = this.tmp;
    d.subVectors(chestW, pelvisW).normalize();
    q.setFromUnitVectors(UP, d);
    m.compose(new THREE.Vector3().lerpVectors(pelvisW, chestW, 0.62), q, sc.set(5.6 * S, 5.6 * S, 5.6 * S));
    this.bands.setMatrixAt(f.i, m);
    // Head, facing forward (tilted with the torso).
    const headW = v(head);
    const hq = new THREE.Quaternion().setFromEuler(new THREE.Euler(-tl * 0.6 + (f.heave > 0 ? -0.2 : 0), yaw, roll, 'YXZ'));
    m.compose(headW, hq, sc.set(9 * S, 9 * S, 9 * S));
    this.heads.setMatrixAt(f.i, m);

    f.hands.lerpVectors(armW[0].ha, armW[1].ha, 0.5);
    return { hands: f.hands, head: headW, base: groundY, falling, yaw };
  }

  commit() {
    for (const m of [this.bones, this.joints, this.bands, this.heads]) m.instanceMatrix.needsUpdate = true;
    if (this.bones.instanceColor) this.bones.instanceColor.needsUpdate = true;
  }

  dispose() {
    for (const m of [this.bones, this.joints, this.bands, this.heads]) {
      this.scene.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
  }
}

// Name tag: avatar face + name on a pill in the team colour.
// A red "!" bubble over a teammate who isn't pulling while the ball is stuck. One texture for all.
let alertTex = null;
export function alertBadge() {
  if (!alertTex) {
    const c = document.createElement('canvas');
    c.width = 96; c.height = 96;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff3d71';
    ctx.beginPath(); ctx.arc(48, 44, 38, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(38, 76); ctx.lineTo(58, 76); ctx.lineTo(48, 92); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 6; ctx.strokeStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(48, 44, 35, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 54px "Bricolage Grotesque", "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('!', 48, 47);
    alertTex = new THREE.CanvasTexture(c);
    alertTex.colorSpace = THREE.SRGBColorSpace;
  }
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: alertTex, transparent: true, depthWrite: false, depthTest: false }));
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 21;
  sprite.visible = false;
  return sprite;
}

export function nameTag(name, teamColor, avatar, isMe) {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 84;
  const ctx = c.getContext('2d');
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const draw = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = '800 34px "Bricolage Grotesque", "Trebuchet MS", sans-serif';
    const label = isMe ? 'YOU' : name;
    const w = Math.min(312, ctx.measureText(label).width + 84);
    const x = (320 - w) / 2;
    ctx.fillStyle = 'rgba(30,18,60,0.62)';
    ctx.beginPath(); ctx.roundRect(x, 8, w, 60, 30); ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = teamColor;
    ctx.beginPath(); ctx.roundRect(x + 2.5, 10.5, w - 5, 55, 27.5); ctx.stroke();
    const at = faceAtlas();
    const i = ((avatar % 24) + 24) % 24;
    ctx.save();
    ctx.beginPath(); ctx.arc(x + 34, 38, 22, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(at.canvas, (i % CELL_COLS) * CELL, Math.floor(i / CELL_COLS) * CELL, CELL, CELL, x + 12, 16, 44, 44);
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 64, 39, w - 76);
    ctx.beginPath(); ctx.moveTo(150, 68); ctx.lineTo(170, 68); ctx.lineTo(160, 80); ctx.closePath();
    ctx.fillStyle = 'rgba(30,18,60,0.62)'; ctx.fill();
    texture.needsUpdate = true;
  };
  draw();
  faceAtlas().ready.then(draw);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false }));
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 20;
  return sprite;
}
