/**
 * Procedural ship + structure geometry. No external assets — every hull is
 * built from primitives here, merged down to one geometry per material slot
 * so the renderer can draw a whole ship class with a handful of InstancedMesh
 * draw calls instead of thousands of individual meshes.
 *
 * Each builder returns parts keyed by material slot:
 *   hull   - painted metal, takes the faction/type colour
 *   dark   - engine housings, greebles, recesses
 *   glow   - emissive engine bells and running lights (additive-ish)
 *   canopy - tinted glass
 *
 * Ships are modelled nose-down -Z, which is what steerTowards() expects.
 */
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/BufferGeometryUtils.js';

const SLOTS = ['hull', 'dark', 'glow', 'canopy'];

class Builder {
  constructor() {
    this.parts = { hull: [], dark: [], glow: [], canopy: [] };
  }
  add(slot, geo, { pos, rot, scale, quat } = {}) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    if (quat) q.copy(quat);
    else if (rot) q.setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
    m.compose(
      new THREE.Vector3(...(pos || [0, 0, 0])),
      q,
      new THREE.Vector3(...(scale || [1, 1, 1])),
    );
    geo.applyMatrix4(m);
    this.parts[slot].push(geo);
    return this;
  }
  /** Add a part and its mirror across X — most ships are symmetrical. */
  addPair(slot, geoFactory, opts) {
    this.add(slot, geoFactory(), opts);
    const mirrored = { ...opts };
    mirrored.pos = [-opts.pos[0], opts.pos[1], opts.pos[2]];
    if (opts.rot) mirrored.rot = [opts.rot[0], -opts.rot[1], -opts.rot[2]];
    this.add(slot, geoFactory(), mirrored);
    return this;
  }
  build() {
    const out = {};
    for (const s of SLOTS) {
      if (!this.parts[s].length) continue;
      const merged = mergeGeometries(this.parts[s], false);
      if (merged) {
        merged.computeVertexNormals();
        out[s] = merged;
      }
    }
    return out;
  }
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, seg);
const cone = (r, h, seg = 10) => new THREE.ConeGeometry(r, h, seg);
const sph = (r, w = 10, h = 8, ps, pl, ts, tl) =>
  new THREE.SphereGeometry(r, w, h, ps, pl, ts, tl);

const HALF_PI = Math.PI / 2;
/** Cylinder aligned down -Z instead of +Y. */
const tube = (rt, rb, len, seg = 10) => {
  const g = cyl(rt, rb, len, seg);
  g.rotateX(HALF_PI);
  return g;
};

// ---------------------------------------------------------------------------
// Wasp — Light Interceptor. Tiny dart, all engine and wing, no mass.
// ---------------------------------------------------------------------------
function buildWasp() {
  const b = new Builder();
  b.add('hull', tube(0.55, 0.75, 3.4, 8), { pos: [0, 0, 0.2] });
  b.add('hull', cone(0.55, 1.6, 8), { pos: [0, 0, -2.3], rot: [-HALF_PI, 0, 0] });
  b.add('canopy', sph(0.42, 8, 6), { pos: [0, 0.34, -0.7], scale: [1, 0.62, 1.5] });
  // Swept delta wings.
  b.addPair('hull', () => box(2.5, 0.14, 1.5), {
    pos: [1.5, -0.05, 0.55], rot: [0, 0.42, 0.16],
  });
  b.addPair('hull', () => box(0.5, 0.5, 1.1), { pos: [2.45, 0.12, 0.95] });
  // Tail fin.
  b.add('hull', box(0.12, 1.1, 1.0), { pos: [0, 0.6, 1.5], rot: [0.3, 0, 0] });
  b.add('dark', tube(0.62, 0.62, 0.7, 8), { pos: [0, 0, 1.85] });
  b.add('glow', tube(0.5, 0.34, 0.32, 8), { pos: [0, 0, 2.2] });
  b.addPair('glow', () => sph(0.09, 6, 4), { pos: [2.55, 0.14, 0.6] });
  return b.build();
}

// ---------------------------------------------------------------------------
// Falcon — Strike Fighter. Bigger, twin-engined, visibly gunned.
// ---------------------------------------------------------------------------
function buildFalcon() {
  const b = new Builder();
  b.add('hull', box(1.15, 0.85, 4.2), { pos: [0, 0, 0] });
  b.add('hull', cone(0.7, 2.0, 6), { pos: [0, 0, -2.9], rot: [-HALF_PI, 0, 0] });
  b.add('hull', box(1.4, 0.3, 2.2), { pos: [0, 0.5, -0.4] });
  b.add('canopy', sph(0.5, 8, 6), { pos: [0, 0.55, -0.9], scale: [1, 0.7, 1.7] });
  // Forward-swept wings with engine nacelles on the tips.
  b.addPair('hull', () => box(2.9, 0.18, 1.7), {
    pos: [1.9, -0.1, 0.5], rot: [0, -0.3, 0.1],
  });
  b.addPair('dark', () => tube(0.42, 0.42, 2.6, 8), { pos: [2.5, 0.05, 0.7] });
  b.addPair('glow', () => tube(0.33, 0.2, 0.4, 8), { pos: [2.5, 0.05, 2.05] });
  // Nose cannons.
  b.addPair('dark', () => tube(0.11, 0.11, 2.2, 6), { pos: [0.55, -0.2, -2.2] });
  // Twin tails.
  b.addPair('hull', () => box(0.12, 1.2, 1.1), { pos: [0.55, 0.7, 1.7], rot: [0.25, 0, 0.22] });
  b.add('dark', tube(0.75, 0.75, 0.8, 8), { pos: [0, 0, 2.2] });
  b.add('glow', tube(0.6, 0.4, 0.35, 8), { pos: [0, 0, 2.6] });
  return b.build();
}

// ---------------------------------------------------------------------------
// Warden — Medium Escort. Utilitarian block with shield emitters.
// ---------------------------------------------------------------------------
function buildWarden() {
  const b = new Builder();
  b.add('hull', box(2.4, 1.5, 7.0), { pos: [0, 0, 0] });
  b.add('hull', box(1.8, 1.1, 2.2), { pos: [0, 0.9, -1.2] }); // bridge
  b.add('canopy', box(1.5, 0.45, 0.9), { pos: [0, 1.15, -2.1] });
  b.add('hull', cone(1.05, 2.6, 8), { pos: [0, -0.1, -4.4], rot: [-HALF_PI, 0, 0] });
  // Side sponsons.
  b.addPair('hull', () => box(0.9, 0.9, 4.0), { pos: [1.5, -0.2, 0.4] });
  b.addPair('dark', () => tube(0.16, 0.16, 2.0, 6), { pos: [1.5, 0.35, -2.2] });
  // Shield emitter rings — the visual tell for the bubble ability.
  b.addPair('glow', () => new THREE.TorusGeometry(0.42, 0.09, 6, 12), {
    pos: [1.5, 0.75, 0.6], rot: [HALF_PI, 0, 0],
  });
  // Dorsal turret.
  b.add('dark', cyl(0.5, 0.6, 0.45, 10), { pos: [0, 0.95, 1.4] });
  b.add('dark', tube(0.13, 0.13, 1.6, 6), { pos: [0, 1.05, 0.7] });
  // Engines.
  b.add('dark', box(2.6, 1.3, 1.2), { pos: [0, 0, 3.6] });
  b.addPair('glow', () => tube(0.42, 0.3, 0.4, 8), { pos: [0.8, 0, 4.25] });
  b.addPair('glow', () => sph(0.12, 6, 4), { pos: [1.25, 0.1, -3.0] });
  return b.build();
}

// ---------------------------------------------------------------------------
// Bastion — Heavy Cruiser. A slab of armour with a ram prow and turret decks.
// ---------------------------------------------------------------------------
function buildBastion() {
  const b = new Builder();
  b.add('hull', box(4.0, 2.2, 12.0), { pos: [0, 0, 0] });
  // Layered armour belt.
  b.add('hull', box(4.6, 1.1, 8.5), { pos: [0, -0.4, 0.5] });
  b.add('dark', box(4.9, 0.35, 7.0), { pos: [0, -0.2, 0.8] });
  // Armoured prow.
  b.add('hull', box(3.0, 1.7, 3.0), { pos: [0, 0.1, -6.6] });
  b.add('hull', cone(1.6, 3.4, 4), { pos: [0, 0.1, -8.9], rot: [-HALF_PI, Math.PI / 4, 0] });
  // Superstructure.
  b.add('hull', box(2.4, 1.6, 3.6), { pos: [0, 1.6, 1.6] });
  b.add('hull', box(1.6, 1.0, 1.6), { pos: [0, 2.7, 1.2] });
  b.add('canopy', box(1.7, 0.4, 1.0), { pos: [0, 2.75, 0.4] });
  // Main turrets: barbette + twin barrels, fore and aft.
  for (const z of [-3.6, 3.2]) {
    b.add('dark', cyl(1.0, 1.15, 0.6, 12), { pos: [0, 1.3, z] });
    b.add('hull', box(1.7, 0.8, 2.0), { pos: [0, 1.7, z - 0.3] });
    b.addPair('dark', () => tube(0.17, 0.17, 3.0, 6), { pos: [0.42, 1.75, z - 1.9] });
  }
  // Broadside blisters.
  b.addPair('dark', () => box(0.7, 0.7, 1.0), { pos: [2.2, 0.3, -2.0] });
  b.addPair('dark', () => box(0.7, 0.7, 1.0), { pos: [2.2, 0.3, 0.4] });
  b.addPair('dark', () => box(0.7, 0.7, 1.0), { pos: [2.2, 0.3, 2.8] });
  // Four engine bells.
  b.add('dark', box(4.2, 2.0, 1.6), { pos: [0, 0, 6.4] });
  for (const x of [-1.3, 1.3]) {
    for (const y of [-0.55, 0.55]) {
      b.add('glow', tube(0.62, 0.42, 0.5, 10), { pos: [x, y, 7.35] });
    }
  }
  b.addPair('glow', () => sph(0.16, 6, 4), { pos: [2.35, 1.0, -4.5] });
  return b.build();
}

// ---------------------------------------------------------------------------
// Aegis — Support Carrier. Wide flat spine, open hangar, sensor arrays.
// ---------------------------------------------------------------------------
function buildAegis() {
  const b = new Builder();
  b.add('hull', box(5.2, 1.2, 10.0), { pos: [0, 0, 0] });
  b.add('hull', box(3.4, 1.8, 6.0), { pos: [0, 1.0, 0.5] });
  // Hangar mouth, forward — recessed dark opening with lit rails.
  b.add('dark', box(2.6, 1.0, 2.6), { pos: [0, -0.2, -4.2] });
  b.add('glow', box(2.4, 0.06, 2.4), { pos: [0, -0.68, -4.2] });
  b.addPair('hull', () => box(0.7, 1.4, 3.4), { pos: [2.0, -0.1, -3.6] });
  // Command tower.
  b.add('hull', box(1.4, 1.4, 1.8), { pos: [0, 2.3, 1.4] });
  b.add('canopy', box(1.5, 0.5, 0.9), { pos: [0, 2.5, 0.6] });
  // Sensor / drone-control dishes.
  b.addPair('dark', () => cyl(0.1, 0.1, 1.2, 6), { pos: [1.6, 1.9, 2.6] });
  b.addPair('glow', () => sph(0.62, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), {
    pos: [1.6, 2.5, 2.6], rot: [0.5, 0, 0], scale: [1, 0.45, 1],
  });
  // Drone racks along the flanks.
  b.addPair('dark', () => box(0.5, 0.4, 5.0), { pos: [2.7, 0.5, 0.5] });
  for (let i = 0; i < 4; i++) {
    b.addPair('glow', () => sph(0.11, 6, 4), { pos: [2.7, 0.78, -1.6 + i * 1.4] });
  }
  // Engines.
  b.add('dark', box(4.4, 1.4, 1.4), { pos: [0, 0.1, 5.4] });
  for (const x of [-1.5, 0, 1.5]) {
    b.add('glow', tube(0.5, 0.34, 0.42, 10), { pos: [x, 0.1, 6.2] });
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// Specter — Cloak Scout. Faceted, near-flat, almost no emissive signature.
// ---------------------------------------------------------------------------
function buildSpecter() {
  const b = new Builder();
  // Angular arrowhead: a 4-sided cone reads as faceted stealth plating.
  b.add('hull', cone(1.5, 5.2, 4), {
    pos: [0, 0, -0.4], rot: [-HALF_PI, 0, 0], scale: [1, 1, 0.32],
  });
  b.add('hull', box(1.0, 0.3, 2.2), { pos: [0, 0, 1.4] });
  b.addPair('hull', () => box(1.5, 0.12, 1.0), {
    pos: [1.1, 0, 1.5], rot: [0, 0.5, 0.35],
  });
  b.add('dark', box(0.7, 0.28, 0.9), { pos: [0, 0.02, 2.3] });
  // Deliberately dim — a Specter you can see is a Specter that already failed.
  b.add('glow', tube(0.26, 0.18, 0.2, 6), { pos: [0, 0.02, 2.75] });
  b.add('glow', sph(0.07, 6, 4), { pos: [0, 0.16, -1.4] });
  return b.build();
}

// ---------------------------------------------------------------------------
// Ground: Sentry Turret, Repair Rig, Flak Walker.
// Ground units are modelled +Y up, sitting on the deck.
// ---------------------------------------------------------------------------
function buildSentry() {
  const b = new Builder();
  b.add('dark', cyl(1.5, 1.9, 0.5, 12), { pos: [0, 0.25, 0] });     // foundation
  b.add('hull', cyl(1.1, 1.3, 0.7, 10), { pos: [0, 0.8, 0] });      // barbette
  b.add('hull', box(1.7, 1.0, 2.2), { pos: [0, 1.5, -0.2] });       // gunhouse
  b.add('hull', box(2.1, 0.5, 1.2), { pos: [0, 1.5, 0.3] });
  b.addPair('dark', () => tube(0.16, 0.18, 2.6, 6), { pos: [0.42, 1.6, -1.6] });
  b.add('glow', sph(0.13, 6, 4), { pos: [0, 2.1, 0.6] });
  b.addPair('dark', () => box(0.35, 0.9, 0.35), { pos: [1.3, 0.6, 1.3] });
  return b.build();
}

function buildRig() {
  const b = new Builder();
  b.add('dark', box(2.4, 0.6, 3.6), { pos: [0, 0.4, 0] });          // chassis
  b.addPair('dark', () => box(0.5, 0.7, 3.4), { pos: [1.35, 0.45, 0] }); // tracks
  b.add('hull', box(2.0, 1.0, 2.2), { pos: [0, 1.2, 0.3] });        // body
  b.add('canopy', box(1.2, 0.5, 0.5), { pos: [0, 1.5, -0.9] });
  // Repair crane arm.
  b.add('hull', box(0.3, 0.3, 2.6), { pos: [0, 2.0, -0.8], rot: [-0.5, 0, 0] });
  b.add('glow', sph(0.3, 8, 6), { pos: [0, 2.55, -1.9] });
  // Emitter ring.
  b.add('glow', new THREE.TorusGeometry(0.6, 0.08, 6, 14), {
    pos: [0, 1.85, 1.0], rot: [HALF_PI, 0, 0],
  });
  return b.build();
}

function buildFlak() {
  const b = new Builder();
  b.add('hull', box(2.6, 1.3, 3.0), { pos: [0, 2.0, 0] });          // body
  b.add('dark', box(1.8, 0.6, 1.8), { pos: [0, 2.85, 0.1] });
  // Quad flak barrels on a raised mount.
  for (const x of [-0.45, 0.45]) {
    for (const y of [3.0, 3.35]) {
      b.add('dark', tube(0.11, 0.11, 2.0, 6), { pos: [x, y, -1.4] });
    }
  }
  b.add('glow', sph(0.12, 6, 4), { pos: [0, 3.3, 1.2] });
  // Four splayed legs.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.add('dark', box(0.3, 2.0, 0.3), {
        pos: [sx * 1.35, 1.1, sz * 1.2], rot: [sz * 0.25, 0, -sx * 0.3],
      });
      b.add('dark', box(0.5, 0.25, 0.9), { pos: [sx * 1.75, 0.15, sz * 1.5] });
    }
  }
  return b.build();
}

const BUILDERS = {
  wasp: buildWasp, falcon: buildFalcon, warden: buildWarden,
  bastion: buildBastion, aegis: buildAegis, specter: buildSpecter,
  sentry: buildSentry, rig: buildRig, flak: buildFlak,
};

const cache = new Map();
/** Merged geometry-per-slot for a unit type id. Built once, reused forever. */
export function getGeometry(typeId) {
  if (!cache.has(typeId)) {
    const fn = BUILDERS[typeId];
    if (!fn) throw new Error(`No model builder for "${typeId}"`);
    cache.set(typeId, fn());
  }
  return cache.get(typeId);
}

export function disposeModels() {
  for (const parts of cache.values()) {
    for (const g of Object.values(parts)) g.dispose();
  }
  cache.clear();
}

/**
 * Materials per slot. Hull tint carries the ship-class colour, warmed or
 * cooled slightly by faction so attacker and defender read apart at a glance.
 */
export function makeMaterials(typeId, color, faction) {
  // Faction must dominate hue — at command range a hull is a few dozen
  // pixels and "whose is it" has to be answerable instantly. Lerping the
  // class colour straight at the faction colour muddies into pinks, so the
  // class colour is first flattened toward its own luminance and only then
  // tinted. Ship classes stay distinguishable by lightness, not hue.
  const base = new THREE.Color(color);
  const hsl = base.getHSL({ h: 0, s: 0, l: 0 });
  base.setHSL(hsl.h, hsl.s * 0.22, hsl.l);
  const hullTint = base.lerp(
    new THREE.Color(faction === 'attack' ? 0xc8623a : 0x4a90c8), 0.55,
  );
  return {
    hull: new THREE.MeshStandardMaterial({
      color: hullTint, metalness: 0.85, roughness: 0.42,
      envMapIntensity: 1.1,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: 0x2a2f36, metalness: 0.9, roughness: 0.55,
      envMapIntensity: 0.8,
    }),
    glow: new THREE.MeshStandardMaterial({
      color: 0x000000, metalness: 0, roughness: 1,
      emissive: new THREE.Color(faction === 'attack' ? 0xff7a3c : 0x63e8ff),
      // Bloom multiplies this. Much above ~2 and adjacent engine bells smear
      // into a single white slab instead of reading as separate nozzles.
      emissiveIntensity: 1.9,
    }),
    canopy: new THREE.MeshPhysicalMaterial({
      color: 0x0a1622, metalness: 0.2, roughness: 0.08,
      transmission: 0.4, thickness: 0.4, transparent: true, opacity: 0.85,
      envMapIntensity: 1.6,
    }),
  };
}

export const MATERIAL_SLOTS = SLOTS;
