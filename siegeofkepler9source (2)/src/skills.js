/**
 * Unit abilities. Each entry has:
 *   apply(ctx, unit)     - fire it
 *   should(ctx, unit)    - autocast heuristic, so a 40-unit battle doesn't
 *                          need babysitting but a player can still do better
 *
 * Ability strength scales off the Skill stat, which is otherwise only a
 * gunnery modifier — this is what makes the Aegis (90 skill) and Repair Rig
 * (95 skill) worth their points.
 */
import * as THREE from 'three';
import { COMBAT } from './config.js';
import { armorMultiplier } from './combat.js';

const _v = new THREE.Vector3();

/** All living enemy craft within `radius` of a unit's centroid. */
function enemiesNear(ctx, unit, radius) {
  const out = [];
  const r2 = radius * radius;
  for (const u of ctx.units) {
    if (u.faction === unit.faction || !u.alive) continue;
    for (const c of u.craft) {
      if (c.alive && c.seenBy[unit.faction] && c.pos.distanceToSquared(unit.pos) <= r2) {
        out.push(c);
      }
    }
  }
  return out;
}

function alliesNear(ctx, unit, radius, { damagedOnly = false } = {}) {
  const out = [];
  const r2 = radius * radius;
  for (const u of ctx.units) {
    if (u.faction !== unit.faction || !u.alive) continue;
    for (const c of u.craft) {
      if (!c.alive) continue;
      if (damagedOnly && c.hp >= c.maxHealth * 0.98) continue;
      if (c.pos.distanceToSquared(unit.pos) <= r2) out.push(c);
    }
  }
  return out;
}

/** Fraction of a unit's craft currently taking fire. */
function underFire(ctx, unit) {
  let hurt = 0, n = 0;
  for (const c of unit.craft) {
    if (!c.alive) continue;
    n++;
    if (c.hp < c.maxHealth * 0.92) hurt++;
  }
  return n ? hurt / n : 0;
}

export const SKILLS = {
  // -------------------------------------------------------------------------
  blink: {
    duration: 0,
    apply(ctx, unit) {
      for (const c of unit.craft) {
        if (!c.alive) continue;
        _v.set(0, 0, -1).applyQuaternion(c.obj.quaternion).multiplyScalar(180);
        ctx.fx.explode(c.pos, 0.5, 0x8fd4ff);
        c.pos.add(_v);
        c.speed = unit.stats.maxSpeed;
        // Breaking the lock is the point: everything shooting at it loses it.
        ctx.breakLocksOn(c);
        ctx.fx.explode(c.pos, 0.5, 0x8fd4ff);
      }
      unit.abilityActive = 0.4;
    },
    should(ctx, unit) {
      // Dash out when hurt, or dash in when the target is out of reach.
      if (underFire(ctx, unit) > 0.4) return true;
      const t = unit.craft.find((c) => c.alive && c.target);
      if (!t) return false;
      const d = t.pos.distanceTo(t.target.pos);
      return d > unit.stats.range * 2.4 && d < 520;
    },
  },

  // -------------------------------------------------------------------------
  volley: {
    duration: 0,
    apply(ctx, unit) {
      const dmgPer = unit.stats.dps * 2.6; // ~2.6s of burst, front-loaded
      for (const c of unit.craft) {
        if (!c.alive || !c.target || !c.target.alive) continue;
        // Warheads are shaped charges: better penetration than the Falcon's
        // guns, but still checked against the target's armour.
        const dmg = dmgPer * armorMultiplier(unit.type, c.target, 0.8);
        for (let i = 0; i < 2; i++) {
          ctx.projectiles.fireMissile(c, c.target, dmg / 2);
        }
      }
      unit.abilityActive = 0.5;
    },
    should(ctx, unit) {
      const armed = unit.craft.filter((c) => c.alive && c.target && c.target.alive);
      if (armed.length < Math.max(1, unit.count * 0.5)) return false;
      // Worth spending on something that will still be alive when it lands.
      return armed.some((c) => c.target.hp > unit.stats.dps * 1.5
        && c.pos.distanceTo(c.target.pos) < 320);
    },
  },

  // -------------------------------------------------------------------------
  bubble: {
    duration: 8,
    apply(ctx, unit) {
      const shield = unit.type.skill * 9; // 55 skill -> ~495 absorbed
      const targets = alliesNear(ctx, unit, 190);
      for (const c of targets) {
        c.shield = Math.max(c.shield, shield);
        c.shieldUntil = ctx.now + 8;
      }
      unit.abilityActive = 8;
      ctx.fx.bubble(unit.pos.clone(), 190, unit.faction);
    },
    should(ctx, unit) {
      const near = enemiesNear(ctx, unit, 260);
      if (near.length < 2) return false;
      return underFire(ctx, unit) > 0.25 || alliesNear(ctx, unit, 190, { damagedOnly: true }).length >= 3;
    },
  },

  // -------------------------------------------------------------------------
  overcharge: {
    duration: 6,
    apply(ctx, unit) {
      for (const c of unit.craft) {
        if (!c.alive) continue;
        c.damageReduction = 0.5;
        c.drUntil = ctx.now + 6;
      }
      // Taunt: nearby enemies are forced onto this hull for the duration.
      const anchor = unit.craft.find((c) => c.alive);
      for (const e of enemiesNear(ctx, unit, 340)) {
        e.tauntedBy = anchor;
        e.tauntUntil = ctx.now + 6;
        e.target = anchor;
      }
      unit.abilityActive = 6;
      ctx.fx.bubble(unit.pos.clone(), 340, unit.faction, 0xffaa44);
    },
    should(ctx, unit) {
      return underFire(ctx, unit) > 0.3 && enemiesNear(ctx, unit, 340).length >= 3;
    },
  },

  // -------------------------------------------------------------------------
  repair: {
    duration: 6,
    apply(ctx, unit) {
      unit.repairUntil = ctx.now + 6;
      unit.repairRate = unit.type.skill * 0.55; // hp/sec per ally
      unit.abilityActive = 6;
      ctx.fx.bubble(unit.pos.clone(), 300, unit.faction, 0x7effc0);
    },
    should(ctx, unit) {
      return alliesNear(ctx, unit, 300, { damagedOnly: true }).length >= 2;
    },
  },

  // -------------------------------------------------------------------------
  jam: {
    duration: 5,
    apply(ctx, unit) {
      for (const e of enemiesNear(ctx, unit, 250)) {
        e.jammedUntil = ctx.now + 5;
        e.target = null;
      }
      unit.abilityActive = 5;
      ctx.fx.bubble(unit.pos.clone(), 250, unit.faction, 0xc79bff);
    },
    should(ctx, unit) {
      // Jam the biggest cluster you can reach; it is worth most when the
      // enemy is mid-engagement, not when they are cruising.
      return enemiesNear(ctx, unit, 250).filter((e) => e.target).length >= 4;
    },
  },

  // -------------------------------------------------------------------------
  overcharge_burst: {
    duration: 5,
    apply(ctx, unit) {
      unit.fireRateBonus = 2;
      unit.fireRateUntil = ctx.now + 5;
      unit.abilityActive = 5;
      ctx.fx.bubble(unit.pos.clone(), 120, unit.faction, 0xff8844);
    },
    should(ctx, unit) {
      return unit.craft.some((c) => c.alive && c.target && c.target.alive);
    },
  },

  // -------------------------------------------------------------------------
  field_repair: {
    duration: 8,
    apply(ctx, unit) {
      unit.repairUntil = ctx.now + 8;
      unit.repairRate = unit.type.skill * 0.5;
      unit.abilityActive = 8;
      ctx.fx.bubble(unit.pos.clone(), 260, unit.faction, 0x7effc0);
    },
    should(ctx, unit) {
      return alliesNear(ctx, unit, 260, { damagedOnly: true }).length >= 1;
    },
  },

  // -------------------------------------------------------------------------
  flak_screen: {
    duration: 0,
    apply(ctx, unit) {
      const dmg = unit.stats.dps * 2.2;
      for (const e of enemiesNear(ctx, unit, 260)) {
        // Only fast movers are caught by a flak screen.
        if (e.unit.type.agility < COMBAT.flakAgilityThreshold) continue;
        // No anti-fighter bonus here: restricting the ability to fast movers
        // already *is* the anti-fighter mechanic, so applying it again
        // would double-dip.
        ctx.damage(e, dmg * armorMultiplier(unit.type, e, 0.2, false), unit);
        ctx.fx.impact(e.pos, 0xffcc66);
      }
      unit.abilityActive = 0.6;
      ctx.fx.bubble(unit.pos.clone(), 260, unit.faction, 0xffcc66);
    },
    should(ctx, unit) {
      return enemiesNear(ctx, unit, 260)
        .filter((e) => e.unit.type.agility >= COMBAT.flakAgilityThreshold).length >= 3;
    },
  },
};

/** Fire a unit's ability if it is off cooldown. Returns true if it went off. */
export function castAbility(ctx, unit) {
  if (!unit.abilityReady) return false;
  const def = SKILLS[unit.type.ability.id];
  if (!def) return false;
  def.apply(ctx, unit);
  unit.abilityCooldown = unit.type.ability.cooldown;
  return true;
}

/** Per-tick autocast pass. */
export function autocast(ctx, unit) {
  if (!unit.autocast || !unit.abilityReady) return;
  const def = SKILLS[unit.type.ability.id];
  if (def && def.should(ctx, unit)) castAbility(ctx, unit);
}

/** Expire timed buffs. Cheap enough to run per craft per frame. */
export function tickBuffs(unit, now) {
  if (unit.repairUntil && now > unit.repairUntil) unit.repairUntil = 0;
  if (unit.fireRateUntil && now > unit.fireRateUntil) {
    unit.fireRateUntil = 0;
    unit.fireRateBonus = 1;
  }
  for (const c of unit.craft) {
    if (!c.alive) continue;
    if (c.drUntil && now > c.drUntil) { c.damageReduction = 0; c.drUntil = 0; }
    if (c.shieldUntil && now > c.shieldUntil) { c.shield = 0; c.shieldUntil = 0; }
    if (c.tauntUntil && now > c.tauntUntil) { c.tauntedBy = null; c.tauntUntil = 0; }
  }
}
