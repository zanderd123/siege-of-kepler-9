import * as THREE from 'three';

/** Deterministic RNG so a given seed always reproduces the same battle setup. */
export function makeRng(seed = 1) {
  // Avalanche the seed first (splitmix-style finaliser). Raw xorshift starts
  // correlated for small, nearby seeds, which made consecutive battles field
  // suspiciously similar fleets.
  let s = seed >>> 0 || 1;
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
  s = (s ^ (s >>> 16)) >>> 0 || 1;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (rng, a, b) => a + rng() * (b - a);

/** Random point in a sphere of `r`, used for spawn scatter and explosions. */
export function randInSphere(rng, r, out = new THREE.Vector3()) {
  let x, y, z, d;
  do {
    x = rng() * 2 - 1; y = rng() * 2 - 1; z = rng() * 2 - 1;
    d = x * x + y * y + z * z;
  } while (d > 1 || d === 0);
  return out.set(x * r, y * r, z * r);
}

/**
 * Smoothly rotate `obj` so its -Z axis points down `dir`, limited to
 * `maxRad` this frame, with `bank` radians of roll into the turn.
 * Ships that snap to headings look like sprites; this is what sells 6-DOF.
 */
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
export function steerTowards(obj, dir, maxRad, bank = 0) {
  if (dir.lengthSq() < 1e-8) return;
  _fwd.copy(dir).normalize();
  // Avoid a degenerate basis when flying straight up or down.
  const upRef = Math.abs(_fwd.y) > 0.995 ? UP_ALT : _up;
  // Matrix4.lookAt(eye, target, up) puts +Z along (eye - target), so passing
  // the heading as the target leaves local -Z — the nose — along `dir`.
  _m.lookAt(ZERO, _fwd, upRef);
  _q.setFromRotationMatrix(_m);
  if (bank) _q.multiply(_qz.setFromAxisAngle(FWD_AXIS, bank));
  obj.quaternion.rotateTowards(_q, maxRad);
}
const ZERO = new THREE.Vector3();
const UP_ALT = new THREE.Vector3(0, 0, 1);
const FWD_AXIS = new THREE.Vector3(0, 0, 1);
const _qz = new THREE.Quaternion();

/** Angle in radians between a unit's nose and a world position. */
const _to = new THREE.Vector3();
const _nose = new THREE.Vector3();
export function angleToTarget(obj, pos) {
  _to.copy(pos).sub(obj.position);
  if (_to.lengthSq() < 1e-8) return 0;
  _to.normalize();
  _nose.set(0, 0, -1).applyQuaternion(obj.quaternion);
  return Math.acos(clamp(_nose.dot(_to), -1, 1));
}

/** Lead a moving target so projectiles converge instead of trailing behind. */
export function interceptPoint(shooterPos, targetPos, targetVel, projSpeed, out) {
  out.copy(targetPos);
  const d = shooterPos.distanceTo(targetPos);
  if (projSpeed <= 0) return out;
  const t = d / projSpeed;
  out.addScaledVector(targetVel, t);
  return out;
}

export function formatTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Pooled object helper — keeps the GC quiet during heavy combat. */
export class Pool {
  constructor(factory, reset) {
    this.factory = factory;
    this.reset = reset;
    this.free = [];
    this.active = [];
  }
  acquire() {
    const o = this.free.pop() || this.factory();
    this.active.push(o);
    return o;
  }
  release(o) {
    const i = this.active.indexOf(o);
    if (i >= 0) this.active.splice(i, 1);
    if (this.reset) this.reset(o);
    this.free.push(o);
  }
  releaseAt(i) {
    const o = this.active[i];
    this.active.splice(i, 1);
    if (this.reset) this.reset(o);
    this.free.push(o);
    return o;
  }
}
