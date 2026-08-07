/**
 * The battle itself: spawning, the fixed-step simulation, gunnery resolution,
 * and the win check.
 *
 * The sim runs on a fixed timestep and the speed control multiplies how many
 * steps are taken per frame, not the step size. Scaling dt directly would make
 * 8x speed behave differently from 1x (fighters overshooting, projectiles
 * tunnelling); stepping more often keeps the battle identical at every speed.
 */
import * as THREE from 'three';
import { SHIPS, GROUND, WORLD, FACTION, unitCost } from './config.js';
import { Unit, updateCraftMovement, updateUnit, seatOnPlanet } from './entities.js';
import {
  Projectiles, acquireTarget, accuracy, shotDamage, resolveVisibility, angleToTarget,
} from './combat.js';
import { autocast, tickBuffs, castAbility } from './skills.js';
import { makeRng } from './util.js';

const STEP = 1 / 30;          // fixed simulation step
const MAX_STEPS_PER_FRAME = 40;
const RETARGET_INTERVAL = 0.5;

const _v = new THREE.Vector3();

export class Game {
  constructor(fleetRenderer, opts = {}) {
    this.fx = fleetRenderer;
    this.units = [];
    this.projectiles = new Projectiles();
    this.now = 0;
    this.accumulator = 0;
    this.speed = 1;
    this.paused = false;
    this.state = 'playing';       // playing | victory | defeat
    this.playerFaction = FACTION.ATTACK;
    this.rng = makeRng(opts.seed || 12345);
    this.fogEnabled = opts.fog !== false;
    this.retargetTimer = 0;
    this.visTimer = 0;
    this.kills = { attack: 0, defense: 0 };
    this.onEnd = null;
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------
  /**
   * `roster` is [{ typeId, qty }]. Ships spawn in a loose block around the
   * faction anchor; ground units are seated on the planet's contested face.
   */
  spawn(roster, faction) {
    const anchor = new THREE.Vector3(
      ...(faction === FACTION.ATTACK ? WORLD.attackAnchor : WORLD.defenseAnchor),
    );
    const ships = [];
    const ground = [];
    for (const entry of roster) {
      const type = SHIPS[entry.typeId] || GROUND[entry.typeId];
      if (!type) continue;
      for (let i = 0; i < entry.qty; i++) (type.ground ? ground : ships).push(type);
    }

    // Lay the fleet out in a wide, shallow block facing the enemy.
    const cols = Math.max(1, Math.ceil(Math.sqrt(ships.length * 1.8)));
    ships.forEach((type, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const spacing = 210;
      const pos = anchor.clone().add(new THREE.Vector3(
        (col - (cols - 1) / 2) * spacing,
        (this.rng() - 0.5) * 240 + (type.id === 'bastion' ? -50 : 0),
        row * spacing * 0.9 * (faction === FACTION.ATTACK ? -1 : 1),
      ));
      const u = new Unit(type, faction, pos, Math.floor(this.rng() * 1e9));
      this.units.push(u);
    });

    // Ground units ring the hemisphere that faces the attackers' approach.
    ground.forEach((type, i) => {
      const u = new Unit(type, faction, new THREE.Vector3(), Math.floor(this.rng() * 1e9));
      const spread = ground.length > 1 ? i / (ground.length - 1) : 0.5;
      const az = (spread - 0.5) * 2.1;
      const el = (this.rng() - 0.5) * 1.0;
      const dir = new THREE.Vector3(
        Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el),
      );
      seatOnPlanet(u, dir);
      this.units.push(u);
    });
  }

  start(playerRoster, enemyRoster, playerFaction) {
    this.playerFaction = playerFaction;
    const enemyFaction = playerFaction === FACTION.ATTACK ? FACTION.DEFENSE : FACTION.ATTACK;
    this.spawn(playerRoster, playerFaction);
    this.spawn(enemyRoster, enemyFaction);
    this.fx.build(this.units);
    resolveVisibility(this.units, this.playerFaction, 0, this.fogEnabled);
    // Give every craft an initial transform so frame one isn't a pile at 0,0,0.
    for (const u of this.units) {
      for (const c of u.craft) c.obj.updateMatrix();
    }
  }

  reset() {
    this.units.length = 0;
    this.projectiles.clear();
    this.fx.disposeBatches();
    this.now = 0;
    this.accumulator = 0;
    this.state = 'playing';
    this.kills = { attack: 0, defense: 0 };
  }

  get playerUnits() { return this.units.filter((u) => u.faction === this.playerFaction && u.alive); }
  get enemyUnits() { return this.units.filter((u) => u.faction !== this.playerFaction && u.alive); }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------
  update(realDt) {
    if (this.paused || this.state !== 'playing') {
      // Effects keep animating while paused so the scene doesn't look frozen
      // solid, but nothing in the simulation advances.
      this.fx.update(realDt, null);
      return;
    }
    this.accumulator += realDt * this.speed;
    let steps = 0;
    while (this.accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
      this.step(STEP);
      this.accumulator -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0; // don't spiral
    this.fx.emitTrails(this.units, realDt);
    this.fx.update(realDt, null);
  }

  step(dt) {
    this.now += dt;

    // --- visibility (a few Hz) ------------------------------------------
    this.visTimer -= dt;
    if (this.visTimer <= 0) {
      this.visTimer = 0.2;
      resolveVisibility(this.units, this.playerFaction, this.now, this.fogEnabled);
    }

    // --- targeting (a few Hz) -------------------------------------------
    this.retargetTimer -= dt;
    const retarget = this.retargetTimer <= 0;
    if (retarget) this.retargetTimer = RETARGET_INTERVAL;

    const enemyCraftOf = {
      attack: this.craftOf(FACTION.DEFENSE),
      defense: this.craftOf(FACTION.ATTACK),
    };

    const ctx = this.abilityContext();

    for (const u of this.units) {
      if (!u.alive) continue;
      tickBuffs(u, this.now);
      updateUnit(u, dt);

      const enemies = enemyCraftOf[u.faction];
      for (const c of u.craft) {
        if (!c.alive) continue;
        if (c.hitFlash > 0) c.hitFlash -= dt;
        if (retarget || !c.target || !c.target.alive || !c.target.seenBy[u.faction]) {
          c.target = acquireTarget(c, enemies, this.now);
        }
        updateCraftMovement(c, dt, this.now);
        this.tryFire(c, dt);
      }

      if (u.repairUntil > this.now) this.applyRepair(u, dt);
      autocast(ctx, u);
    }

    // --- projectiles ------------------------------------------------------
    this.projectiles.update(dt, this.now,
      (p) => this.onProjectileHit(p),
      null,
    );

    this.checkVictory();
  }

  craftOf(faction) {
    const out = [];
    for (const u of this.units) {
      if (u.faction !== faction || !u.alive) continue;
      for (const c of u.craft) if (c.alive) out.push(c);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Gunnery
  // -------------------------------------------------------------------------
  tryFire(craft, dt) {
    const unit = craft.unit;
    const w = unit.type.weapon;
    if (!w) return;
    const t = craft.target;
    if (!t || !t.alive) return;

    const dist = craft.pos.distanceTo(t.pos);
    if (dist > unit.stats.range) return;

    // Fixed guns need the nose roughly on target; turreted mounts don't.
    const turreted = unit.isGround || unit.type.scale >= 2.5;
    if (!turreted && angleToTarget(craft.obj, t.pos) > 0.42) return;

    const rof = w.rof * (unit.fireRateUntil > this.now ? unit.fireRateBonus : 1);
    craft.fireTimer -= dt;
    if (craft.fireTimer > 0) return;
    craft.fireTimer += 1 / rof;

    const hit = Math.random() < accuracy(craft, t);
    this.projectiles.fire(craft, t, hit, shotDamage(craft, t));

    // Firing lights up a cloaked hull.
    if (unit.type.cloak) craft.revealUntil = this.now + 4;
  }

  onProjectileHit(p) {
    const target = p.target;
    if (!target || !target.alive) return;
    const dealt = target.applyDamage(p.damage, this.now);
    this.fx.impact(target.pos, p.kind === 'missile' ? 0xffaa55 : 0xffddaa);
    if (!target.alive) this.onCraftDestroyed(target, p.shooter);
    return dealt;
  }

  damage(craft, amount, sourceUnit) {
    if (!craft.alive) return;
    craft.applyDamage(amount, this.now);
    if (!craft.alive) this.onCraftDestroyed(craft, null);
  }

  onCraftDestroyed(craft, killer) {
    const scale = craft.unit.type.scale * 1.6;
    this.fx.explode(craft.pos, scale, craft.unit.type.color);
    const side = craft.unit.faction === FACTION.ATTACK ? 'defense' : 'attack';
    this.kills[side]++;
    // Anything locked onto the dead hull needs a new target immediately.
    this.breakLocksOn(craft);
  }

  breakLocksOn(craft) {
    for (const u of this.units) {
      for (const c of u.craft) {
        if (c.target === craft) c.target = null;
        if (c.tauntedBy === craft) { c.tauntedBy = null; c.tauntUntil = 0; }
      }
    }
    for (const p of this.projectiles.list) {
      if (p.target === craft) p.target = null;
    }
  }

  applyRepair(unit, dt) {
    const rate = unit.repairRate * dt;
    const r2 = (unit.isGround ? 260 : 300) ** 2;
    for (const u of this.units) {
      if (u.faction !== unit.faction || !u.alive) continue;
      for (const c of u.craft) {
        if (!c.alive || c.hp >= c.maxHealth) continue;
        if (c.pos.distanceToSquared(unit.pos) <= r2) c.heal(rate);
      }
    }
  }

  abilityContext() {
    return {
      units: this.units,
      now: this.now,
      fx: this.fx,
      projectiles: this.projectiles,
      damage: (c, amt, src) => this.damage(c, amt, src),
      breakLocksOn: (c) => this.breakLocksOn(c),
    };
  }

  /** Player-triggered ability cast. */
  castFor(unit) {
    return castAbility(this.abilityContext(), unit);
  }

  // -------------------------------------------------------------------------
  checkVictory() {
    const playerAlive = this.units.some((u) => u.faction === this.playerFaction && u.alive);
    const enemyAlive = this.units.some((u) => u.faction !== this.playerFaction && u.alive);
    if (playerAlive && enemyAlive) return;
    this.state = !enemyAlive && playerAlive ? 'victory'
      : (!playerAlive && enemyAlive ? 'defeat' : 'draw');
    if (this.onEnd) this.onEnd(this.state);
  }

  // -------------------------------------------------------------------------
  /** Tracer geometry for this frame — called by the app right before render. */
  drawTracers() {
    const t = this.fx.tracers;
    t.begin();
    for (const p of this.projectiles.list) {
      // Only draw fire the player can see.
      const visible = this.fogEnabled
        ? (p.shooter && (p.shooter.seenBy[this.playerFaction]
            || p.shooter.unit.faction === this.playerFaction))
        : true;
      if (!visible) continue;
      const len = p.kind === 'missile' ? 26 : (p.kind === 'shell' ? 34 : 22);
      _v.copy(p.pos).addScaledVector(p.dir, -len);
      const color = p.faction === FACTION.ATTACK ? 0xff9a4a : 0x7fdcff;
      t.push(p.pos, _v, p.kind === 'missile' ? 0xffcc88 : color, p.kind === 'shell' ? 1.6 : 1.2);
    }
    t.end();
  }
}

export function rosterCost(roster) {
  return roster.reduce((sum, e) => {
    const type = SHIPS[e.typeId] || GROUND[e.typeId];
    return sum + (type ? unitCost(type) * e.qty : 0);
  }, 0);
}
