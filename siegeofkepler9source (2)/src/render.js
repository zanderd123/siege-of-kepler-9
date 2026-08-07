/**
 * Fleet rendering. Every craft of a given type+faction is drawn from one
 * InstancedMesh per material slot, so a 400-hull battle costs a few dozen
 * draw calls rather than a few thousand.
 *
 * Per-craft state that has to survive instancing:
 *   - fog of war / cloak  -> zero-scale the instance matrix (fully hidden)
 *   - damage flash        -> per-instance colour
 */
import * as THREE from 'three';
import { getGeometry, makeMaterials, MATERIAL_SLOTS } from './models.js';
import { DISPLAY_SCALE } from './config.js';

const MAX_PER_BATCH = 512;
const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _white = new THREE.Color(0xffffff);
const _flash = new THREE.Color(0xff8060);

class Batch {
  constructor(scene, typeId, faction, color, capacity) {
    this.craft = [];
    this.meshes = [];
    const geos = getGeometry(typeId);
    const mats = makeMaterials(typeId, color, faction);
    for (const slot of MATERIAL_SLOTS) {
      if (!geos[slot]) continue;
      const mesh = new THREE.InstancedMesh(geos[slot], mats[slot], capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Damage flash tints the painted hull only; engines stay lit.
      if (slot === 'hull' || slot === 'dark') {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(capacity * 3).fill(1), 3,
        );
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  add(craft) { this.craft.push(craft); }

  update() {
    let n = 0;
    for (const c of this.craft) {
      if (!c.alive || !c.visible) continue;
      // Display scale is baked into obj.scale by FleetRenderer.build().
      c.obj.updateMatrix();
      _m.copy(c.obj.matrix);
      if (c.hitFlash > 0) _c.copy(_flash); else _c.copy(_white);
      for (const mesh of this.meshes) {
        mesh.setMatrixAt(n, _m);
        if (mesh.instanceColor) mesh.setColorAt(n, _c);
      }
      c.instanceIndex = n;
      n++;
      if (n >= MAX_PER_BATCH) break;
    }
    for (const mesh of this.meshes) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(scene) {
    for (const mesh of this.meshes) {
      scene.remove(mesh);
      mesh.dispose();
      mesh.material.dispose();
    }
    this.meshes.length = 0;
    this.craft.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Weapon tracers: one LineSegments for everything, rewritten each frame.
// ---------------------------------------------------------------------------
class Tracers {
  constructor(scene, max = 4000) {
    this.max = max;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 6);
    this.col = new Float32Array(max * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    this.mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.n = 0;
  }
  begin() { this.n = 0; }
  push(a, b, color, intensity = 1) {
    if (this.n >= this.max) return;
    const i = this.n * 6;
    this.pos[i] = a.x; this.pos[i + 1] = a.y; this.pos[i + 2] = a.z;
    this.pos[i + 3] = b.x; this.pos[i + 4] = b.y; this.pos[i + 5] = b.z;
    _c.set(color);
    for (const o of [0, 3]) {
      this.col[i + o] = _c.r * intensity;
      this.col[i + o + 1] = _c.g * intensity;
      this.col[i + o + 2] = _c.b * intensity;
    }
    this.n++;
  }
  end() {
    this.geo.setDrawRange(0, this.n * 2);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Explosions + engine trails as additive point sprites.
// ---------------------------------------------------------------------------
class Particles {
  constructor(scene, max = 6000) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.count = 0;
    this.cursor = 0;   // round-robin recycle position when saturated

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;

    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: innerHeight * 0.5 } },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color; vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(-mv.z, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float f = smoothstep(0.5, 0.0, length(d));
          gl_FragColor = vec4(vColor * f, f * vAlpha);
        }`,
      transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, vertexColors: true,
    });
    this.mat = mat;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(pos, vel, color, size, life, drag = 1.2) {
    let i = this.count;
    if (i >= this.max) {
      // Saturated: recycle round-robin. Scanning for the oldest slot is an
      // O(n) sweep per spawn, and a capital ship dying spawns ~46 at once —
      // that turns into a visible hitch exactly when the battle is busiest.
      i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
    } else {
      this.count++;
    }
    this.pos[i * 3] = pos.x; this.pos[i * 3 + 1] = pos.y; this.pos[i * 3 + 2] = pos.z;
    this.vel[i * 3] = vel.x; this.vel[i * 3 + 1] = vel.y; this.vel[i * 3 + 2] = vel.z;
    _c.set(color);
    this.col[i * 3] = _c.r; this.col[i * 3 + 1] = _c.g; this.col[i * 3 + 2] = _c.b;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.alpha[i] = 1;
    this.drag[i] = drag;
  }

  update(dt) {
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // Swap-remove with the last live particle.
        const j = this.count - 1;
        if (i !== j) this.copy(j, i);
        this.count--;
        i--;
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] *= d; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = this.life[i] / this.maxLife[i];
    }
    this.geo.setDrawRange(0, this.count);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  copy(from, to) {
    for (let k = 0; k < 3; k++) {
      this.pos[to * 3 + k] = this.pos[from * 3 + k];
      this.col[to * 3 + k] = this.col[from * 3 + k];
      this.vel[to * 3 + k] = this.vel[from * 3 + k];
    }
    this.size[to] = this.size[from];
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.alpha[to] = this.alpha[from];
    this.drag[to] = this.drag[from];
  }

  clear() { this.count = 0; this.cursor = 0; this.geo.setDrawRange(0, 0); }
}

// ---------------------------------------------------------------------------
export class FleetRenderer {
  constructor(scene) {
    this.scene = scene;
    this.batches = new Map();
    this.tracers = new Tracers(scene);
    this.particles = new Particles(scene);
    this.bubbles = [];
    this.trailTimer = 0;
  }

  build(units) {
    this.disposeBatches();
    const groups = new Map();
    for (const u of units) {
      const key = `${u.type.id}:${u.faction}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(u);
    }
    for (const [key, list] of groups) {
      const [typeId, faction] = key.split(':');
      const total = list.reduce((n, u) => n + u.craft.length, 0);
      const batch = new Batch(
        this.scene, typeId, faction, list[0].type.color,
        Math.min(MAX_PER_BATCH, total),
      );
      // Bake the type's display scale into the geometry-space matrix by
      // pre-scaling each craft's transform object.
      for (const u of list) {
        for (const c of u.craft) {
          c.obj.scale.setScalar(u.type.scale * DISPLAY_SCALE * (u.type.ground ? 0.9 : 1.0));
          batch.add(c);
        }
      }
      this.batches.set(key, batch);
    }
  }

  update(dt, camera) {
    for (const b of this.batches.values()) b.update();
    this.particles.update(dt);
    this.updateBubbles(dt);
    this.particles.mat.uniforms.uScale.value = innerHeight * 0.5;
  }

  /** Engine exhaust — throttled so it stays cheap in big fights. */
  emitTrails(units, dt) {
    this.trailTimer -= dt;
    if (this.trailTimer > 0) return;
    this.trailTimer = 0.045;
    for (const u of units) {
      if (u.isGround) continue;
      const col = u.faction === 'attack' ? 0xff8a4a : 0x6fe0ff;
      for (const c of u.craft) {
        if (!c.alive || !c.visible || c.speed < 1) continue;
        _v.set(0, 0, 1).applyQuaternion(c.obj.quaternion)
          .multiplyScalar(u.type.scale * DISPLAY_SCALE * 2.2).add(c.pos);
        _v2.copy(c.vel).multiplyScalar(-0.12);
        this.particles.spawn(
          _v, _v2, col, u.type.scale * DISPLAY_SCALE * 1.4 + 1.4,
          0.32 + Math.random() * 0.2, 1.6,
        );
      }
    }
  }

  explode(pos, scale, color) {
    const n = Math.min(46, 12 + Math.floor(scale * 7));
    for (let i = 0; i < n; i++) {
      _v2.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize().multiplyScalar(12 + Math.random() * 45 * scale);
      this.particles.spawn(
        pos, _v2,
        i % 3 === 0 ? 0xffffff : (i % 3 === 1 ? 0xffb14a : color),
        scale * (2.2 + Math.random() * 3.4), 0.5 + Math.random() * 0.85, 1.1,
      );
    }
    // Core flash.
    _v2.set(0, 0, 0);
    this.particles.spawn(pos, _v2, 0xfff3d0, scale * 12, 0.16, 0.1);
  }

  /** Expanding shell used by shields, taunts, repair fields and jams. */
  bubble(pos, radius, faction, color) {
    const mat = new THREE.MeshBasicMaterial({
      color: color ?? (faction === 'attack' ? 0xff8a4a : 0x6fe0ff),
      transparent: true, opacity: 0.34, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, wireframe: false,
    });
    const mesh = new THREE.Mesh(_bubbleGeo, mat);
    mesh.position.copy(pos);
    mesh.scale.setScalar(radius * 0.25);
    this.scene.add(mesh);
    this.bubbles.push({ mesh, mat, t: 0, life: 0.85, radius });
  }

  updateBubbles(dt) {
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.t += dt;
      const k = b.t / b.life;
      if (k >= 1) {
        this.scene.remove(b.mesh);
        b.mat.dispose();
        this.bubbles.splice(i, 1);
        continue;
      }
      b.mesh.scale.setScalar(b.radius * (0.25 + k * 0.75));
      b.mat.opacity = 0.34 * (1 - k);
    }
  }

  impact(pos, color) {
    for (let i = 0; i < 4; i++) {
      _v2.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize().multiplyScalar(8 + Math.random() * 16);
      this.particles.spawn(pos, _v2, color, 1.6, 0.2, 2.0);
    }
  }

  disposeBatches() {
    for (const b of this.batches.values()) b.dispose(this.scene);
    this.batches.clear();
    this.particles.clear();
    // Tracers are rewritten from the live projectile list each frame, which
    // stops happening once the battle ends — without this, the last frame's
    // weapon fire stays painted over the fleet-builder background.
    this.tracers.begin();
    this.tracers.end();
    for (const b of this.bubbles) {
      this.scene.remove(b.mesh);
      b.mat.dispose();
    }
    this.bubbles.length = 0;
  }
}
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _bubbleGeo = new THREE.SphereGeometry(1, 20, 14);
