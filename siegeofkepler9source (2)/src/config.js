/**
 * Central balance + tuning data.
 *
 * The design sheet uses abstract 0-100 stats. Everything here converts those
 * into world units so the numbers on the card actually drive the simulation:
 *
 *   speed    -> world units / second        (x0.55)
 *   health   -> hit points                  (x12)
 *   dps      -> raw damage / second         (x0.9)   -- before accuracy
 *   agility  -> turn rate AND evasion       (see combat.js)
 *   skill    -> ability power/duration AND weapon tracking
 *
 * The key interaction is accuracy: a weapon's tracking is derived from the
 * firing ship's agility+skill, and it is checked against the target's agility.
 * That is what makes the Wasp "almost never gets caught" rather than merely
 * fast, and it is why the slow Bastion cannot meaningfully shoot fighters.
 *
 * Two mechanics exist on top of the raw sheet because the sheet alone breaks:
 *
 *  1. armor / penetration. Without it a Wasp squadron out-damages a Bastion's
 *     own guns and melts the tank in ~6s. Heavy hulls now shrug off
 *     small-calibre fire, so light craft genuinely cannot crack armour alone
 *     and you need Falcons or Bastions to kill capitals.
 *  2. `ignoresEvasion` on flak. The Flak Walker's tracking (30) vs a Wasp's
 *     agility (95) lands on the accuracy floor, which would make the
 *     designated anti-fighter unit unable to hit fighters. Flak is
 *     proximity-fused, so it skips the tracking check entirely and instead
 *     leans on its damage bonus vs agile targets / penalty vs armour.
 */

export const SPEED_SCALE = 0.72;
export const HEALTH_SCALE = 12;
export const DPS_SCALE = 0.9;

export const FACTION = { ATTACK: 'attack', DEFENSE: 'defense' };

// ---------------------------------------------------------------------------
// World layout
// ---------------------------------------------------------------------------
export const WORLD = {
  planetRadius: 300,
  planetCenter: [0, -60, 0],
  // Defenders hold the high orbit; attackers arrive from deep space -Z.
  defenseAnchor: [0, 40, 470],
  attackAnchor: [0, 60, -1150],
  bounds: 2600, // soft leash radius; units are steered back inside
  gridSize: 4000,
};

// ---------------------------------------------------------------------------
// Ships
// ---------------------------------------------------------------------------
// `count` is the craft-per-purchase. Light craft are bought as squadrons that
// move and fight as one commandable unit; capitals are bought individually.
//
// Costs are derived, not guessed. Each unit's power is sqrt(effectiveHP x
// effectiveDPS) measured across the whole roster — that is, after the accuracy
// model and armour are applied — and cost is set so every combat unit lands on
// the same power-per-point. This matters because the accuracy model
// deliberately stops capitals from hitting fighters: priced naively, a squadron
// of Falcons delivered ~15x a Bastion's effective damage for half the price,
// and no fleet that skipped fighters could compete. Aegis, Repair Rig and
// Specter sit below the combat line on purpose — their value is utility the
// damage metric cannot see.
export const SHIPS = {
  wasp: {
    id: 'wasp',
    name: 'Wasp',
    className: 'Light Interceptor',
    speed: 90, health: 20, skill: 55, dps: 40, agility: 95,
    role: 'Hit-and-run harasser. Dies fast if caught, but almost never gets caught.',
    count: 6,
    costEach: 33,
    range: 90,
    sensor: 350,
    scale: 1.0,
    armor: 0.00,
    color: 0x8fd4ff,
    weapon: { type: 'bolt', rof: 5.5, speed: 620, spread: 0.05, penetration: 0.15 },
    ability: {
      id: 'blink',
      name: 'Blink Dash',
      desc: 'Instantly displaces 180u along the current heading, breaking any lock.',
      cooldown: 12, key: 'Q',
    },
  },
  falcon: {
    id: 'falcon',
    name: 'Falcon',
    className: 'Strike Fighter',
    speed: 75, health: 35, skill: 70, dps: 75, agility: 80,
    role: 'Glass-cannon all-rounder. High burst damage, still fragile.',
    count: 5,
    costEach: 58,
    range: 130,
    sensor: 350,
    scale: 1.15,
    armor: 0.05,
    color: 0xffc46b,
    weapon: { type: 'bolt', rof: 4, speed: 700, spread: 0.035, penetration: 0.50 },
    ability: {
      id: 'volley',
      name: 'Missile Volley',
      desc: 'Fires a lock-on salvo dealing heavy burst damage at extended range.',
      cooldown: 15, key: 'Q',
    },
  },
  warden: {
    id: 'warden',
    name: 'Warden',
    className: 'Medium Escort',
    speed: 55, health: 55, skill: 55, dps: 55, agility: 55,
    role: 'Balanced baseline. Everything it does, something else does better.',
    count: 1,
    costEach: 56,
    range: 155,
    sensor: 420,
    scale: 2.6,
    armor: 0.20,
    color: 0xa9c2d9,
    weapon: { type: 'bolt', rof: 2.4, speed: 560, spread: 0.02, penetration: 0.60 },
    ability: {
      id: 'bubble',
      name: 'Shield Bubble',
      desc: 'Projects a damage-absorbing bubble over itself and nearby allies.',
      cooldown: 20, key: 'Q',
    },
  },
  bastion: {
    id: 'bastion',
    name: 'Bastion',
    className: 'Heavy Cruiser',
    speed: 30, health: 95, skill: 35, dps: 75, agility: 15,
    role: 'Frontline tank. Slow and clumsy, soaks damage, hits hard up close.',
    count: 1,
    costEach: 70,
    range: 210,
    sensor: 320,
    scale: 4.4,
    armor: 0.55,
    color: 0x9aa4ae,
    weapon: { type: 'shell', rof: 1.1, speed: 420, spread: 0.012, penetration: 1.00 },
    ability: {
      id: 'overcharge',
      name: 'Armor Overcharge',
      desc: 'Hardens plating for heavy damage reduction and taunts nearby enemies onto itself.',
      cooldown: 24, key: 'Q',
    },
  },
  aegis: {
    id: 'aegis',
    name: 'Aegis',
    className: 'Support Carrier',
    speed: 30, health: 75, skill: 90, dps: 15, agility: 30,
    role: 'Low personal damage, huge utility. Keeps a fleet alive far past its weight.',
    count: 1,
    costEach: 85,
    range: 120,
    sensor: 620,
    scale: 4.0,
    armor: 0.35,
    color: 0xbfe3c9,
    weapon: { type: 'bolt', rof: 1.6, speed: 480, spread: 0.05, penetration: 0.40 },
    ability: {
      id: 'repair',
      name: 'Repair Drones',
      desc: 'Launches drones that continuously repair damaged allies in a wide radius.',
      cooldown: 18, key: 'Q',
    },
  },
  specter: {
    id: 'specter',
    name: 'Specter',
    className: 'Cloak Scout',
    speed: 65, health: 10, skill: 85, dps: 10, agility: 70,
    role: 'Asymmetric specialist. Near-unkillable to find, near-harmless to fight.',
    count: 3,
    costEach: 14,
    range: 80,
    sensor: 780,
    scale: 1.2,
    armor: 0.00,
    color: 0xc79bff,
    cloak: true,
    weapon: { type: 'bolt', rof: 2, speed: 520, spread: 0.06, penetration: 0.20 },
    ability: {
      id: 'jam',
      name: 'Sensor Jam',
      desc: 'Blinds enemy targeting in a wide radius — jammed ships cannot acquire new targets.',
      cooldown: 22, key: 'Q',
    },
  },
};

// ---------------------------------------------------------------------------
// Ground support (defense only)
// ---------------------------------------------------------------------------
export const GROUND = {
  sentry: {
    id: 'sentry',
    name: 'Sentry Turret',
    className: 'Static Emplacement',
    speed: 0, health: 60, skill: 40, dps: 80, agility: 0,
    role: 'Static area denial. Brutal at a chokepoint, useless once the fight moves.',
    count: 1,
    costEach: 63,
    range: 300,
    sensor: 360,
    scale: 3.0,
    armor: 0.30,
    color: 0xd08b6a,
    ground: true,
    weapon: { type: 'shell', rof: 1.6, speed: 520, spread: 0.015, penetration: 0.95 },
    ability: {
      id: 'overcharge_burst',
      name: 'Overcharge Burst',
      desc: 'Doubles rate of fire and widens the firing arc for a short window.',
      cooldown: 20, key: 'Q',
    },
  },
  rig: {
    id: 'rig',
    name: 'Repair Rig',
    className: 'Mobile Support',
    speed: 20, health: 40, skill: 95, dps: 0, agility: 20,
    role: 'Mobile heal and resupply. Zero offense — it needs somebody to protect it.',
    count: 1,
    costEach: 40,
    range: 0,
    sensor: 280,
    scale: 2.4,
    armor: 0.10,
    color: 0x86d3b8,
    ground: true,
    weapon: null,
    ability: {
      id: 'field_repair',
      name: 'Field Repair',
      desc: 'Repairs friendly ground units and any friendly ship in low orbit above it.',
      cooldown: 14, key: 'Q',
    },
  },
  flak: {
    id: 'flak',
    name: 'Flak Walker',
    className: 'Anti-Fighter Walker',
    speed: 40, health: 75, skill: 40, dps: 60, agility: 20,
    role: 'Slow anti-fighter platform. Shreds fast movers, bounces off heavy armor.',
    count: 1,
    costEach: 76,
    range: 230,
    sensor: 320,
    scale: 2.8,
    armor: 0.40,
    color: 0xb9a06a,
    ground: true,
    antiFighter: true, // bonus vs high agility, penalty vs heavy armor
    weapon: { type: 'flak', rof: 2.2, speed: 460, spread: 0.05, penetration: 0.20, ignoresEvasion: true, flatAccuracy: 0.75 },
    ability: {
      id: 'flak_screen',
      name: 'Flak Screen',
      desc: 'Saturates the sky with proximity bursts, damaging every fast mover nearby.',
      cooldown: 18, key: 'Q',
    },
  },
};

export const ALL_TYPES = { ...SHIPS, ...GROUND };

// ---------------------------------------------------------------------------
// Combat tuning
// ---------------------------------------------------------------------------
export const COMBAT = {
  // Accuracy: 0.5 + (tracking - targetAgility) / spread, clamped.
  accuracySpread: 140,
  accuracyMin: 0.10,
  accuracyMax: 0.95,
  // A stationary or barely-moving target is much easier to hit.
  evasionMotionFloor: 0.35,

  flakAgilityBonus: 1.9,   // Flak Walker dmg multiplier vs agility >= 60
  flakArmorPenalty: 0.45,  // ...and vs health >= 75
  flakAgilityThreshold: 60,
  flakArmorThreshold: 75,

  // Emplacements are stable firing platforms with heavy targeting computers;
  // without this the Sentry Turret's tracking (20) leaves it unable to hit
  // anything that moves, which defeats the point of buying one.
  groundTrackingBias: 40,

  cloakDetectRange: 130,   // how close you must be to see a cloaked Specter
  cloakRevealTime: 4.0,    // seconds a Specter stays visible after firing

  groundOrbitCeiling: 620, // ground units can only shoot this high off the deck
};

export const BUDGET = { min: 400, max: 4000, step: 50, default: 1000 };

/**
 * Hulls are drawn larger than their "true" size. At honest scale a cruiser is
 * a few pixels from useful command altitude, which makes the fleet
 * unreadable. Formation and spawn spacing are widened to match so ships
 * still don't intersect.
 */
export const DISPLAY_SCALE = 2.2;

/** Speed-meter stops. Index into this directly; pause is separate. */
export const SPEEDS = [0.5, 1, 2, 4, 8];
export const DEFAULT_SPEED_INDEX = 1; // 1x

export function unitCost(type) {
  return type.costEach * type.count;
}

/** Derived per-craft combat values used by the simulation. */
export function derive(type) {
  return {
    maxSpeed: type.speed * SPEED_SCALE,
    maxHealth: type.health * HEALTH_SCALE,
    dps: type.dps * DPS_SCALE,
    // Agility drives turn rate: 15 agility ~ 0.5 rad/s, 95 agility ~ 2.4 rad/s
    turnRate: 0.35 + (type.agility / 100) * 2.2,
    accel: 0.4 + (type.agility / 100) * 2.6,
    tracking: type.agility * 0.5 + type.skill * 0.5 +
      (type.ground ? COMBAT.groundTrackingBias : 0),
    armor: type.armor || 0,
    range: type.range,
    sensor: type.sensor,
  };
}

/** Effective sustained DPS of `a` firing on `b`, after accuracy and armour. */
export function effectiveDps(a, b) {
  const da = derive(a), db = derive(b);
  const w = a.weapon;
  if (!w) return 0;
  let acc = w.ignoresEvasion
    ? (w.flatAccuracy ?? 0.75)
    : Math.min(COMBAT.accuracyMax, Math.max(COMBAT.accuracyMin,
        0.5 + (da.tracking - b.agility) / COMBAT.accuracySpread));
  let mult = 1 - db.armor * (1 - (w.penetration ?? 0.5));
  if (a.antiFighter) {
    if (b.agility >= COMBAT.flakAgilityThreshold) mult *= COMBAT.flakAgilityBonus;
    if (b.health >= COMBAT.flakArmorThreshold) mult *= COMBAT.flakArmorPenalty;
  }
  return da.dps * acc * mult;
}
