/**
 * The enemy commander: fleet composition plus battlefield behaviour.
 *
 * Composition uses weighted templates rather than pure randomness so the AI
 * fields something coherent — a defender that buys nothing but Specters is
 * not a challenge, it's a bug that looks like one.
 *
 * Behaviour is deliberately squadron-level. The AI issues move/attack orders
 * on the same interface the player uses; it has no special access to the
 * simulation and it obeys the same fog of war.
 */
import * as THREE from 'three';
import { SHIPS, GROUND, WORLD, FACTION, unitCost } from './config.js';
import { makeRng } from './util.js';

// Share of budget per role. Attackers skew to strike power, defenders to
// staying power plus the ground component they alone can buy.
// `max` caps the utility units. Without it the leftover-budget pass buys
// whatever is cheapest, and the cheapest units are the Specter and Repair Rig
// — producing fleets of eight scouts or seven medics that cannot fight.
const TEMPLATES = {
  attack: [
    { id: 'falcon', weight: 0.30, min: 1 },
    { id: 'bastion', weight: 0.24, min: 1 },
    { id: 'wasp', weight: 0.18, min: 1 },
    { id: 'warden', weight: 0.14, min: 0 },
    { id: 'aegis', weight: 0.09, min: 0, max: 2 },
    { id: 'specter', weight: 0.05, min: 1, max: 2 },
  ],
  defense: [
    { id: 'bastion', weight: 0.22, min: 1 },
    { id: 'warden', weight: 0.18, min: 1 },
    { id: 'falcon', weight: 0.16, min: 1 },
    { id: 'aegis', weight: 0.12, min: 1, max: 2 },
    { id: 'wasp', weight: 0.10, min: 0 },
    { id: 'sentry', weight: 0.10, min: 1, max: 5 },
    { id: 'flak', weight: 0.08, min: 1, max: 4 },
    { id: 'rig', weight: 0.04, min: 0, max: 2 },
  ],
};

/** Units bought for utility rather than firepower; always capped. */
const UTILITY = new Set(['aegis', 'rig', 'specter']);

/** Build a roster for `faction` that spends as much of `budget` as it can. */
export function generateFleet(budget, faction, seed = 99) {
  const rng = makeRng(seed);
  const plan = TEMPLATES[faction];
  const roster = new Map();
  let spent = 0;

  const cost = (id) => unitCost(SHIPS[id] || GROUND[id]);
  const capOf = (e) => (e.max ?? (UTILITY.has(e.id) ? 2 : Infinity));
  const room = (e, n = 1) => (roster.get(e.id) || 0) + n <= capOf(e)
    && spent + cost(e.id) * n <= budget;
  const buy = (id, n = 1) => {
    roster.set(id, (roster.get(id) || 0) + n);
    spent += cost(id) * n;
  };

  // Guarantee the template minimums first so the fleet is always coherent.
  for (const e of plan) {
    if (e.min && room(e, e.min)) buy(e.id, e.min);
  }

  // Spend the rest proportionally, jittered so no two battles are identical.
  const weights = plan.map((e) => ({ ...e, w: e.weight * (0.75 + rng() * 0.5) }));
  const total = weights.reduce((s, e) => s + e.w, 0);
  const remaining = budget - spent;
  for (const e of weights) {
    const share = remaining * (e.w / total);
    let n = Math.floor(share / cost(e.id));
    n = Math.min(n, capOf(e) - (roster.get(e.id) || 0));
    if (n > 0 && room(e, n)) buy(e.id, n);
  }

  // Mop up leftovers with combat units only, picked by template weight rather
  // than cheapest-first. Cheapest-first spends the entire remainder on
  // whichever hull happens to be cheapest — seven Wardens and nothing else —
  // and is deterministic, so every battle fields an identical enemy fleet.
  const combat = plan.filter((e) => !UTILITY.has(e.id));
  let guard = 0;
  while (guard++ < 400) {
    const opts = combat.filter((e) => room(e));
    if (!opts.length) break;
    let r = rng() * opts.reduce((s, e) => s + e.weight, 0);
    let pick = opts[opts.length - 1];
    for (const e of opts) { r -= e.weight; if (r <= 0) { pick = e; break; } }
    buy(pick.id, 1);
  }

  return [...roster.entries()].map(([typeId, qty]) => ({ typeId, qty }));
}

// ---------------------------------------------------------------------------
// Battlefield behaviour
// ---------------------------------------------------------------------------
const _v = new THREE.Vector3();
const _goal = new THREE.Vector3();
const PLANET = new THREE.Vector3(...WORLD.planetCenter);

export class Commander {
  constructor(game, faction, difficulty = 1) {
    this.game = game;
    this.faction = faction;
    this.difficulty = difficulty;
    this.timer = 0;
    this.interval = 1.4;
    this.rng = makeRng(777);
    this.searchIndex = 0;
    this.searchTimer = 0;
    this.searchPath = this.buildSearchPath();
  }

  /**
   * Sweep route used when nothing is visible. Without this the fleet flies to
   * a single fixed point and parks there forever, and a battle can never end
   * if the last enemy happens to sit outside sensor range of that one spot —
   * e.g. a lone survivor on the far side of the planet.
   *
   * Starts at the enemy's likely staging area, then circles the planet so
   * every approach is eventually swept.
   */
  buildSearchPath() {
    const enemyAnchor = this.faction === FACTION.ATTACK
      ? WORLD.defenseAnchor : WORLD.attackAnchor;
    const pts = [new THREE.Vector3(...enemyAnchor)];
    const R = WORLD.planetRadius + 520;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      pts.push(new THREE.Vector3(
        PLANET.x + Math.cos(a) * R,
        PLANET.y + (i % 2 ? 260 : -260),
        PLANET.z + Math.sin(a) * R,
      ));
    }
    // Finish by sweeping our own back field, in case anything slipped past.
    pts.push(new THREE.Vector3(...(this.faction === FACTION.ATTACK
      ? WORLD.attackAnchor : WORLD.defenseAnchor)));
    return pts;
  }

  /** Centroid of our mobile units, for deciding when a sweep leg is done. */
  fleetCentroid() {
    const mine = this.myUnits.filter((u) => !u.isGround);
    if (!mine.length) return null;
    const c = new THREE.Vector3();
    for (const u of mine) c.add(u.pos);
    return c.divideScalar(mine.length);
  }

  /** Current sweep target, advancing the leg once reached or timed out. */
  searchWaypoint() {
    const wp = this.searchPath[this.searchIndex % this.searchPath.length];
    const c = this.fleetCentroid();
    if (!c || c.distanceTo(wp) < 380 || this.searchTimer > 26) {
      this.searchIndex++;
      this.searchTimer = 0;
    }
    return this.searchPath[this.searchIndex % this.searchPath.length];
  }

  get myUnits() {
    return this.game.units.filter((u) => u.faction === this.faction && u.alive);
  }

  /** Enemy units this side can actually see. */
  visibleEnemies() {
    const out = [];
    for (const u of this.game.units) {
      if (u.faction === this.faction || !u.alive) continue;
      if (u.craft.some((c) => c.alive && c.seenBy[this.faction])) out.push(u);
    }
    return out;
  }

  update(dt) {
    this.searchTimer += dt;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.interval;

    const mine = this.myUnits.filter((u) => !u.isGround);
    const seen = this.visibleEnemies();

    if (!seen.length) {
      this.advance(mine);
      return;
    }
    // Contact: drop the sweep and restart it from the top if we lose them.
    this.searchTimer = 0;

    // Split the fleet: escorts screen the capitals, strike craft hunt value.
    for (const u of mine) {
      const target = this.pickTarget(u, seen);
      if (!target) { this.advance([u]); continue; }
      const aim = target.pos.clone();
      // Approach from slightly off-axis so squadrons don't stack into a line.
      aim.x += (this.rng() - 0.5) * 120;
      aim.y += (this.rng() - 0.5) * 90;
      u.order(aim, { attack: target });
    }

    // Repair Rigs reposition toward the most damaged friendly ground cluster.
    for (const u of this.myUnits.filter((x) => x.isGround && x.stats.maxSpeed > 0)) {
      const hurt = this.myUnits
        .filter((x) => x.isGround && x !== u && x.healthFraction < 0.9)
        .sort((a, b) => a.healthFraction - b.healthFraction)[0];
      if (hurt) u.order(hurt.pos);
    }
  }

  /** Score enemy units for one of our squadrons and take the best. */
  pickTarget(unit, enemies) {
    let best = null, bestScore = -Infinity;
    for (const e of enemies) {
      const d = unit.pos.distanceTo(e.pos);
      let s = 1200 / (200 + d);

      // Prefer targets we are actually equipped to kill.
      const agile = e.type.agility >= 60;
      if (unit.type.antiFighter) s *= agile ? 3.0 : 0.4;
      else if (unit.type.agility >= 60 && e.type.health >= 75) s *= 0.55;
      else if (unit.type.id === 'bastion' && agile) s *= 0.35;
      else if (unit.type.id === 'falcon' && e.type.health >= 75) s *= 1.7;

      // Kill the support.
      if (e.type.id === 'aegis' || e.type.id === 'rig') s *= 2.0;
      // Focus the wounded.
      s *= 1 + (1 - e.healthFraction) * 0.8;
      // Ground targets are only worth going for once the sky is clearing.
      if (e.isGround) s *= this.skyClear(enemies) ? 1.4 : 0.25;

      if (s > bestScore) { bestScore = s; best = e; }
    }
    return best;
  }

  skyClear(enemies) {
    const ships = enemies.filter((e) => !e.isGround).length;
    return ships <= Math.max(1, enemies.length * 0.25);
  }

  /**
   * Nothing in sensor range.
   *
   * Attackers press the objective immediately — that is the whole point of
   * attacking — but once they have been there a while with nothing to shoot,
   * both sides fall back to sweeping the search route so a hidden or distant
   * survivor is always eventually found and the battle can end.
   *
   * Defenders hold their picket first; they are not obliged to come out, but
   * they will go looking rather than let a match hang forever.
   */
  advance(units) {
    const holdTime = this.faction === FACTION.ATTACK ? 8 : 20;
    let goal;
    if (this.searchTimer < holdTime && this.searchIndex === 0) {
      goal = _goal.copy(PLANET);
      if (this.faction === FACTION.ATTACK) {
        goal.z -= WORLD.planetRadius + 260;
      } else {
        goal.set(...WORLD.defenseAnchor);
      }
    } else {
      goal = _goal.copy(this.searchWaypoint());
    }

    for (const u of units) {
      _v.copy(goal);
      _v.x += (this.rng() - 0.5) * 620;
      _v.y += (this.rng() - 0.5) * 360;
      _v.z += (this.rng() - 0.5) * 620;
      u.order(_v, { attack: null });
    }
  }
}
