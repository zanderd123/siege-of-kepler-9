/**
 * Craft (one physical hull) and Unit (one commandable purchase — a squadron
 * of light craft, or a single capital).
 *
 * Flight is velocity-along-the-nose rather than free strafing: ships turn at a
 * rate set by their agility and then accelerate forward. That is what makes a
 * Bastion feel like it weighs something and a Wasp feel like it doesn't, and
 * it is why agility protects you — a turn you cannot make is a shot you eat.
 */
import * as THREE from 'three';
import { derive, WORLD, DISPLAY_SCALE } from './config.js';
import { steerTowards, clamp, randInSphere, makeRng } from './util.js';

let _uid = 1;

const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _nose = new THREE.Vector3();
const _right = new THREE.Vector3();
const _offset = new THREE.Vector3();

export class Craft {
  constructor(unit, index, rng) {
    this.unit = unit;
    this.index = index;
    this.id = _uid++;
    this.obj = new THREE.Object3D();     // transform only; never added to scene
    this.pos = this.obj.position;
    this.vel = new THREE.Vector3();
    this.speed = 0;
    this.hp = unit.stats.maxHealth;
    this.alive = true;
    this.target = null;                  // Craft
    this.fireTimer = rng() * 0.7;
    this.mode = 'move';
    this.modeTimer = 0;
    this.bank = 0;
    this.shield = 0;                     // absorbs damage before hp
    this.damageReduction = 0;
    this.jammedUntil = 0;
    this.revealUntil = 0;                // cloaked craft that just fired
    this.seenBy = { attack: false, defense: false }; // resolved by fog of war
    this.visible = true;                 // seenBy[playerFaction], for rendering
    this.hitFlash = 0;
    // Only meaningful for ground units; seatOnPlanet() sets the real values.
    this.groundOffset = 0;
    this.groundFacing = new THREE.Vector3(0, 0, -1);
    // Formation slot inside the squadron: a loose 3D wedge.
    const cols = 3;
    const row = Math.floor(index / cols);
    const col = index % cols;
    const spread = unit.type.scale * DISPLAY_SCALE * 7 + 10;
    this.slot = new THREE.Vector3(
      (col - (cols - 1) / 2) * spread,
      ((index % 2) - 0.5) * spread * 0.5,
      row * spread * 1.1,
    );
  }

  get maxHealth() { return this.unit.stats.maxHealth; }

  applyDamage(amount, now) {
    if (!this.alive) return 0;
    let dmg = amount * (1 - this.damageReduction);
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, dmg);
      this.shield -= absorbed;
      dmg -= absorbed;
    }
    if (dmg <= 0) return 0;
    this.hp -= dmg;
    this.hitFlash = 0.12;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
    }
    return dmg;
  }

  heal(amount) {
    if (!this.alive) return;
    this.hp = Math.min(this.maxHealth, this.hp + amount);
  }
}

export class Unit {
  constructor(type, faction, spawnPos, seed = 1) {
    this.id = _uid++;
    this.type = type;
    this.faction = faction;
    this.stats = derive(type);
    this.isGround = !!type.ground;
    this.rng = makeRng(seed);

    this.pos = spawnPos.clone();          // squadron centroid / anchor
    this.movePos = spawnPos.clone();      // commanded destination
    this.heading = new THREE.Vector3(0, 0, faction === 'attack' ? 1 : -1);
    this.craft = [];
    for (let i = 0; i < type.count; i++) {
      const c = new Craft(this, i, this.rng);
      c.pos.copy(spawnPos).add(randInSphere(this.rng, type.scale * DISPLAY_SCALE * 5 + 8, _tmp));
      c.obj.lookAt(_tmp.copy(c.pos).add(this.heading));
      this.craft.push(c);
    }

    this.selected = false;
    this.attackTarget = null;             // Unit
    this.holdPosition = false;
    this.autocast = true;
    this.abilityCooldown = 0;
    this.abilityActive = 0;
    this.destroyed = false;
    this.orderMarker = null;
  }

  get alive() { return this.craft.some((c) => c.alive); }
  get aliveCraft() { return this.craft.filter((c) => c.alive); }
  get count() { return this.craft.reduce((n, c) => n + (c.alive ? 1 : 0), 0); }
  get healthFraction() {
    const max = this.stats.maxHealth * this.type.count;
    return this.craft.reduce((s, c) => s + (c.alive ? c.hp : 0), 0) / max;
  }
  get abilityReady() { return this.abilityCooldown <= 0 && this.alive; }

  /** Centroid of living craft, refreshed each tick. */
  updateCentroid() {
    const alive = this.aliveCraft;
    if (!alive.length) return;
    _tmp.set(0, 0, 0);
    for (const c of alive) _tmp.add(c.pos);
    this.pos.copy(_tmp.divideScalar(alive.length));
  }

  order(pos, { attack = null, hold = false } = {}) {
    this.movePos.copy(pos);
    // A destination inside the planet is not reachable, and ships ordered
    // there grind against the avoidance steering (or clip through it). This
    // happens constantly when attacking ground units, whose own position is
    // on the surface, and whenever a player right-clicks the planet itself.
    if (!this.isGround) {
      _tmp.copy(this.movePos).sub(PLANET);
      const d = _tmp.length();
      if (d < ORBIT_FLOOR) {
        if (d < 1e-4) _tmp.set(0, 0, -1); else _tmp.divideScalar(d);
        this.movePos.copy(PLANET).addScaledVector(_tmp, ORBIT_FLOOR);
      }
    }
    this.attackTarget = attack;
    this.holdPosition = hold;
  }

  /** Nearest living craft of this unit to a point — used for range checks. */
  nearestCraft(pos) {
    let best = null, bd = Infinity;
    for (const c of this.craft) {
      if (!c.alive) continue;
      const d = c.pos.distanceToSquared(pos);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------
const PLANET = new THREE.Vector3(...WORLD.planetCenter);
/** Lowest a ship may fly. Still well inside every weapon's reach of the
 *  surface, so ground units remain attackable from the orbit floor. */
const ORBIT_FLOOR = WORLD.planetRadius + 45;

/**
 * Steer one craft for a frame. `dt` is already scaled by game speed.
 */
export function updateCraftMovement(craft, dt, now) {
  const unit = craft.unit;
  const st = unit.stats;

  if (unit.isGround) {
    updateGroundCraft(craft, dt);
    return;
  }

  const target = craft.target;
  let desired = _dir;
  let throttle = 1;

  if (target && target.alive && !unit.holdPosition) {
    const dist = craft.pos.distanceTo(target.pos);
    const range = st.range;
    const nimble = unit.type.agility >= 60;

    if (nimble) {
      // Fighters make strafing runs: bore in, then break off and re-attack
      // instead of parking on top of the target.
      if (craft.mode === 'breakaway') {
        craft.modeTimer -= dt;
        desired.copy(craft.pos).sub(target.pos).normalize();
        // Curve the break so it reads as a loop rather than a retreat.
        _right.set(0, 1, 0).cross(desired).normalize();
        desired.addScaledVector(_right, 0.6).normalize();
        if (craft.modeTimer <= 0 || dist > range * 3.2) craft.mode = 'engage';
      } else {
        desired.copy(target.pos).sub(craft.pos).normalize();
        if (dist < range * 0.45) {
          craft.mode = 'breakaway';
          craft.modeTimer = 1.6 + unit.rng() * 1.2;
        }
      }
    } else {
      // Capitals hold a standoff and present their broadside.
      const standoff = range * 0.8;
      desired.copy(target.pos).sub(craft.pos);
      const d = desired.length();
      desired.normalize();
      if (d < standoff * 0.75) {
        desired.negate();
        throttle = 0.5;
      } else if (d < standoff) {
        // Drift laterally to keep guns bearing without closing further.
        _right.copy(desired).cross(_up).normalize();
        desired.copy(_right);
        throttle = 0.35;
      }
    }
  } else {
    // Move to the formation slot around the commanded destination.
    _offset.copy(craft.slot);
    _offset.applyQuaternion(unit.formationQuat || IDENT);
    _tmp.copy(unit.movePos).add(_offset);
    desired.copy(_tmp).sub(craft.pos);
    const d = desired.length();
    if (d < 6) {
      // Arrived: bleed off speed but keep station rather than freezing.
      throttle = 0;
      desired.set(0, 0, -1).applyQuaternion(craft.obj.quaternion);
    } else {
      desired.normalize();
      throttle = clamp(d / 60, 0.25, 1);
    }
  }

  // Keep the fight inside the arena and out of the planet.
  const fromPlanet = _tmp.copy(craft.pos).sub(PLANET);
  const rp = fromPlanet.length();
  if (rp < ORBIT_FLOOR) {
    desired.addScaledVector(fromPlanet.normalize(), (ORBIT_FLOOR - rp) / 45 * 2.5);
    desired.normalize();
  }
  const fromCenter = craft.pos.length();
  if (fromCenter > WORLD.bounds) {
    _tmp.copy(craft.pos).negate().normalize();
    desired.lerp(_tmp, clamp((fromCenter - WORLD.bounds) / 300, 0, 1)).normalize();
  }

  // Bank into the turn: how far off the nose the desired heading sits.
  _nose.set(0, 0, -1).applyQuaternion(craft.obj.quaternion);
  _right.set(1, 0, 0).applyQuaternion(craft.obj.quaternion);
  const lateral = clamp(_right.dot(desired), -1, 1);
  const wantBank = -lateral * (0.5 + unit.type.agility / 100 * 0.9);
  craft.bank += (wantBank - craft.bank) * Math.min(1, dt * 3.5);

  steerTowards(craft.obj, desired, st.turnRate * dt, craft.bank);

  const targetSpeed = st.maxSpeed * throttle;
  craft.speed += clamp(targetSpeed - craft.speed, -st.accel * 30 * dt, st.accel * 22 * dt);
  craft.speed = clamp(craft.speed, 0, st.maxSpeed);

  _nose.set(0, 0, -1).applyQuaternion(craft.obj.quaternion);
  craft.vel.copy(_nose).multiplyScalar(craft.speed);
  craft.pos.addScaledVector(craft.vel, dt);

  // Hard backstop. Steering is gradual, so a fast craft on a steep approach
  // can punch through the soft avoidance above and end the frame inside the
  // crust. Snap it back to the orbit floor and kill the inward velocity.
  _tmp.copy(craft.pos).sub(PLANET);
  const r = _tmp.length();
  if (r < ORBIT_FLOOR) {
    if (r < 1e-4) _tmp.set(0, 1, 0); else _tmp.divideScalar(r);
    craft.pos.copy(PLANET).addScaledVector(_tmp, ORBIT_FLOOR);
    const inward = craft.vel.dot(_tmp);
    if (inward < 0) craft.vel.addScaledVector(_tmp, -inward);
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const IDENT = new THREE.Quaternion();

/** Ground units are pinned to the surface; they only walk and traverse. */
function updateGroundCraft(craft, dt) {
  const unit = craft.unit;
  const st = unit.stats;
  const up = _up2.copy(craft.pos).sub(PLANET).normalize();

  if (st.maxSpeed > 0 && !unit.holdPosition) {
    _dir.copy(unit.movePos).sub(craft.pos);
    _dir.addScaledVector(up, -_dir.dot(up)); // project onto the tangent plane
    if (_dir.length() > 8) {
      _dir.normalize();
      craft.pos.addScaledVector(_dir, st.maxSpeed * dt);
      // Re-seat on the surface after sliding along the tangent. The new
      // normal must be captured before craft.pos is overwritten.
      _tmp.copy(craft.pos).sub(PLANET).normalize();
      craft.pos.copy(PLANET).addScaledVector(
        _tmp, WORLD.planetRadius + craft.groundOffset,
      );
      up.copy(_tmp);
    }
  }

  // Traverse toward the target if there is one, otherwise hold the last
  // facing — always with "up" pointing away from the planet core.
  if (craft.target && craft.target.alive) {
    _dir.copy(craft.target.pos).sub(craft.pos);
    _dir.addScaledVector(up, -_dir.dot(up));
    if (_dir.lengthSq() > 1e-6) craft.groundFacing.copy(_dir.normalize());
  }
  _mat.lookAt(ZERO, _nose.copy(craft.groundFacing), up);
  craft.obj.quaternion.setFromRotationMatrix(_mat);
  craft.vel.set(0, 0, 0);
}
const _up2 = new THREE.Vector3();

const _mat = new THREE.Matrix4();
const ZERO = new THREE.Vector3();

/** Place a ground unit's craft on the planet surface at a lat/long-ish point. */
export function seatOnPlanet(unit, dirFromCore) {
  const n = dirFromCore.clone().normalize();
  for (const c of unit.craft) {
    c.groundOffset = 0;
    c.groundFacing = new THREE.Vector3(0, 0, -1);
    // Scatter members of the same emplacement slightly around the anchor.
    const jitter = new THREE.Vector3(
      (unit.rng() - 0.5) * 0.06, (unit.rng() - 0.5) * 0.06, (unit.rng() - 0.5) * 0.06,
    );
    const dir = n.clone().add(jitter).normalize();
    c.pos.copy(PLANET).addScaledVector(dir, WORLD.planetRadius);
    // Face outward along the surface by default.
    const tangent = new THREE.Vector3(0, 1, 0).cross(dir);
    if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0);
    c.groundFacing.copy(tangent.normalize());
  }
  unit.updateCentroid();
  unit.movePos.copy(unit.pos);
}

/** Squadron-level bookkeeping: centroid, formation orientation, ability timers. */
export function updateUnit(unit, dt) {
  unit.updateCentroid();
  if (unit.abilityCooldown > 0) unit.abilityCooldown -= dt;
  if (unit.abilityActive > 0) unit.abilityActive -= dt;

  if (!unit.isGround) {
    _dir.copy(unit.movePos).sub(unit.pos);
    if (_dir.lengthSq() > 1) {
      unit.heading.lerp(_dir.normalize(), Math.min(1, dt * 2));
      if (!unit.formationQuat) unit.formationQuat = new THREE.Quaternion();
      _mat.lookAt(ZERO, _tmp.copy(unit.heading).normalize(), _up);
      unit.formationQuat.setFromRotationMatrix(_mat);
    }
  }
}
