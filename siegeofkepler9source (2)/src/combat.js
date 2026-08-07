/**
 * Targeting, gunnery and fog of war.
 *
 * Shots are simulated as travelling projectiles (so you can see fire crossing
 * the battlefield and lead looks right), but the hit is *decided* at fire time
 * by the accuracy roll. Deciding on impact instead would double-dip: slow
 * projectiles would miss agile targets twice, once via the roll and once via
 * travel time, and the Wasp would become literally unkillable.
 */
import * as THREE from 'three';
import { COMBAT } from './config.js';
import { clamp, interceptPoint, angleToTarget } from './util.js';

const _v = new THREE.Vector3();
const _lead = new THREE.Vector3();

/** Accuracy of `shooter` firing on `target`, 0..1. */
export function accuracy(shooter, target) {
  const w = shooter.unit.type.weapon;
  if (w.ignoresEvasion) return w.flatAccuracy ?? 0.75;
  const tracking = shooter.unit.stats.tracking;
  let acc = 0.5 + (tracking - target.unit.type.agility) / COMBAT.accuracySpread;
  // A target that is barely manoeuvring cannot use its agility.
  const motion = clamp(target.speed / Math.max(1, target.unit.stats.maxSpeed), 0, 1);
  if (motion < COMBAT.evasionMotionFloor) {
    acc += (COMBAT.evasionMotionFloor - motion) * 0.9;
  }
  return clamp(acc, COMBAT.accuracyMin, COMBAT.accuracyMax);
}

/** Damage of one shot from `shooter` against `target`, after armour. */
export function shotDamage(shooter, target) {
  const type = shooter.unit.type;
  const w = type.weapon;
  const perShot = shooter.unit.stats.dps / w.rof;
  let mult = 1 - target.unit.stats.armor * (1 - (w.penetration ?? 0.5));
  if (type.antiFighter) {
    if (target.unit.type.agility >= COMBAT.flakAgilityThreshold) mult *= COMBAT.flakAgilityBonus;
    if (target.unit.type.health >= COMBAT.flakArmorThreshold) mult *= COMBAT.flakArmorPenalty;
  }
  return perShot * mult;
}

/**
 * Armour multiplier for a guaranteed-hit source (abilities, AoE bursts).
 * Abilities skip the accuracy roll — they are supposed to land — but they
 * must NOT skip armour, or Missile Volley and Flak Screen become strictly
 * better against the tankiest targets, which inverts what they are for.
 */
export function armorMultiplier(attackerType, targetCraft, penetration, applyAntiFighter = true) {
  const pen = penetration ?? attackerType.weapon?.penetration ?? 0.5;
  let mult = 1 - targetCraft.unit.stats.armor * (1 - pen);
  if (attackerType.antiFighter && applyAntiFighter) {
    const t = targetCraft.unit.type;
    if (t.agility >= COMBAT.flakAgilityThreshold) mult *= COMBAT.flakAgilityBonus;
    if (t.health >= COMBAT.flakArmorThreshold) mult *= COMBAT.flakArmorPenalty;
  }
  return Math.max(0, mult);
}

/**
 * Threat scoring: prefer targets this ship can actually hurt, weighted by how
 * close they are. Without the damage term, Bastions chase Wasps they cannot
 * hit while Falcons ignore the carrier that is healing everything.
 */
function score(shooter, target, dist) {
  const t = target.unit.type;
  const dmg = shotDamage(shooter, target) * accuracy(shooter, target);
  let s = dmg / (1 + dist / 260);
  // Support ships are disproportionately valuable — go for the medics.
  if (t.id === 'aegis' || t.id === 'rig') s *= 1.7;
  // Finish off the badly damaged.
  s *= 1 + (1 - target.hp / target.maxHealth) * 0.6;
  return s;
}

/**
 * Pick a target for one craft. `enemies` is the flat list of enemy craft.
 * Only re-run occasionally — this is O(n) per craft.
 */
export function acquireTarget(craft, enemies, now) {
  if (craft.jammedUntil > now) return craft.target && craft.target.alive ? craft.target : null;
  const unit = craft.unit;
  if (!unit.type.weapon) return null;

  // A taunt overrides normal target selection.
  if (craft.tauntedBy && craft.tauntedBy.alive && craft.tauntUntil > now) {
    return craft.tauntedBy;
  }

  // Ordered attack targets take priority over opportunistic ones.
  const forced = unit.attackTarget;
  const searchRadius = unit.stats.sensor;
  let best = null, bestScore = -1;

  const side = unit.faction;
  for (const e of enemies) {
    // Target only what this side can actually see.
    if (!e.alive || !e.seenBy[side]) continue;
    const d = craft.pos.distanceTo(e.pos);
    if (d > searchRadius * 1.4) continue;
    // Ground units cannot engage what they cannot elevate onto.
    if (unit.isGround && d > unit.stats.range * 1.6) continue;
    if (e.unit.isGround && !unit.isGround) {
      // Ships can only hit ground targets from low orbit.
      if (d > COMBAT.groundOrbitCeiling) continue;
    }
    let s = score(craft, e, d);
    if (forced && e.unit === forced) s *= 6;
    if (s > bestScore) { bestScore = s; best = e; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------
export class Projectiles {
  constructor() {
    this.list = [];
  }

  fire(shooter, target, willHit, damage) {
    const w = shooter.unit.type.weapon;
    const from = shooter.pos.clone();
    interceptPoint(shooter.pos, target.pos, target.vel, w.speed, _lead);
    if (!willHit) {
      // Visibly miss: throw the round wide so a miss reads as a miss.
      _lead.x += (Math.random() - 0.5) * 34;
      _lead.y += (Math.random() - 0.5) * 34;
      _lead.z += (Math.random() - 0.5) * 34;
    }
    const dir = _lead.clone().sub(from).normalize();
    this.list.push({
      pos: from,
      dir,
      speed: w.speed,
      life: 3.2,
      target: willHit ? target : null,
      damage,
      faction: shooter.unit.faction,
      kind: w.type,
      shooter,
    });
  }

  /** Missiles from the Falcon volley: slower, tracking, heavy. */
  fireMissile(shooter, target, damage) {
    this.list.push({
      pos: shooter.pos.clone(),
      dir: new THREE.Vector3(0, 0, -1).applyQuaternion(shooter.obj.quaternion),
      speed: 150,
      accel: 260,
      maxSpeed: 520,
      life: 5,
      target,
      damage,
      faction: shooter.unit.faction,
      kind: 'missile',
      homing: true,
      shooter,
    });
  }

  update(dt, now, onHit, onExpire) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt;

      if (p.homing) {
        if (p.target && p.target.alive) {
          _v.copy(p.target.pos).sub(p.pos).normalize();
          p.dir.lerp(_v, Math.min(1, dt * 3.2)).normalize();
        }
        p.speed = Math.min(p.maxSpeed, p.speed + p.accel * dt);
      }

      const step = p.speed * dt;
      p.prev = p.prev || p.pos.clone();
      p.prev.copy(p.pos);
      p.pos.addScaledVector(p.dir, step);

      if (p.target && p.target.alive) {
        // Hit when we reach the target rather than on exact intersection —
        // the outcome was already decided at fire time.
        if (p.pos.distanceTo(p.target.pos) < Math.max(14, step * 0.75)) {
          onHit(p);
          this.list.splice(i, 1);
          continue;
        }
      }
      if (p.life <= 0) {
        if (onExpire) onExpire(p);
        this.list.splice(i, 1);
      }
    }
  }

  clear() { this.list.length = 0; }
}

// ---------------------------------------------------------------------------
// Fog of war
// ---------------------------------------------------------------------------
/** How far `observer` can pick out `subject` — cloak shrinks this hard. */
function detectRange(observerUnit, subjectUnit) {
  if (!subjectUnit.type.cloak) return observerUnit.stats.sensor;
  // Dedicated sensor platforms are the counter to cloak.
  const id = observerUnit.type.id;
  return COMBAT.cloakDetectRange * (id === 'aegis' || id === 'specter' ? 2.2 : 1);
}

/**
 * Resolve visibility for BOTH sides in one pass. Each craft ends up with
 * `seenBy.attack` / `seenBy.defense`, so cloak works symmetrically: a player
 * Specter is just as invisible to the enemy commander as theirs is to you.
 *
 * Run at a few Hz rather than every frame — with hundreds of craft this is
 * the most expensive thing in the simulation.
 */
export function resolveVisibility(units, playerFaction, now, fogEnabled = true) {
  const sides = { attack: [], defense: [] };
  for (const u of units) {
    if (u.alive) sides[u.faction].push(u);
  }

  for (const u of units) {
    for (const c of u.craft) {
      // You always see your own ships; enemies start unseen each pass.
      c.seenBy.attack = u.faction === 'attack';
      c.seenBy.defense = u.faction === 'defense';
      if (!c.alive) continue;
      if (!fogEnabled) { c.seenBy.attack = c.seenBy.defense = true; continue; }
      // A cloaked ship that just fired has given its position away.
      if (u.type.cloak && c.revealUntil > now) {
        c.seenBy.attack = c.seenBy.defense = true;
      }
    }
  }

  if (fogEnabled) {
    for (const a of sides.attack) {
      for (const d of sides.defense) {
        // Unit-level rejection first: skip the craft loop entirely when the
        // squadrons are far enough apart that nothing could see anything.
        const maxReach = Math.max(detectRange(a, d), detectRange(d, a)) + 260;
        if (a.pos.distanceToSquared(d.pos) > maxReach * maxReach) continue;

        const aSees = detectRange(a, d) ** 2;
        const dSees = detectRange(d, a) ** 2;
        for (const ac of a.craft) {
          if (!ac.alive) continue;
          for (const dc of d.craft) {
            if (!dc.alive) continue;
            const dist2 = ac.pos.distanceToSquared(dc.pos);
            if (dist2 <= aSees) dc.seenBy.attack = true;
            if (dist2 <= dSees) ac.seenBy.defense = true;
          }
        }
      }
    }
  }

  // `visible` is the player's view, used for rendering and selection.
  for (const u of units) {
    for (const c of u.craft) c.visible = c.alive && c.seenBy[playerFaction];
  }
}

export { angleToTarget };
