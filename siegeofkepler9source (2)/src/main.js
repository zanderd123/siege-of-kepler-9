/**
 * Application shell: screen flow, the frame loop, and the glue between the
 * simulation, the renderer, the camera and the DOM.
 */
import * as THREE from 'three';
import { SPEEDS, DEFAULT_SPEED_INDEX, FACTION, WORLD } from './config.js';
import { SpaceScene } from './scene.js';
import { FleetRenderer } from './render.js';
import { Game } from './game.js';
import { CameraRig, InputController } from './input.js';
import { Builder, Hud } from './ui.js';
import { generateFleet, Commander } from './ai.js';

class App {
  constructor() {
    this.scene = new SpaceScene(document.getElementById('view'));
    this.renderer = this.scene.renderer;
    this.fleet = new FleetRenderer(this.scene.scene);
    this.rig = new CameraRig(this.scene.camera, this.renderer.domElement);

    this.game = new Game(this.fleet);
    this.selection = [];
    this.groups = new Map();
    this.hoverUnit = null;
    this.uiBlocking = true;      // true while a full-screen menu is up
    this.speedIndex = DEFAULT_SPEED_INDEX;
    this.setup = null;

    this.hud = new Hud(this);
    this.input = new InputController(this);
    this.builder = new Builder((cfg) => this.startBattle(cfg));

    this.clock = new THREE.Clock();
    this.hoverPos = { x: 0, y: 0 };
    addEventListener('pointermove', (e) => {
      this.hoverPos.x = e.clientX;
      this.hoverPos.y = e.clientY;
    });

    // First frame is expensive (shader compiles, PMREM); show the builder
    // only once we've actually rendered something.
    requestAnimationFrame(() => {
      this.scene.render();
      document.getElementById('loading').classList.add('hidden');
      this.builder.show();
      this.builder.refresh();
    });

    this.loop();
  }

  // -------------------------------------------------------------------------
  get playerFaction() { return this.game.playerFaction; }

  startBattle(cfg) {
    this.setup = cfg;
    this.builder.hide();
    this.hud.hideEnd();
    this.hud.show();
    this.uiBlocking = false;

    const enemyFaction = cfg.side === FACTION.ATTACK ? FACTION.DEFENSE : FACTION.ATTACK;
    const enemyRoster = generateFleet(cfg.budget, enemyFaction, (Date.now() % 100000) | 0);

    this.game.reset();
    this.game.start(cfg.roster, enemyRoster, cfg.side);
    this.game.onEnd = (state) => this.onBattleEnd(state);
    this.commander = new Commander(this.game, enemyFaction);

    this.setSelection([]);
    this.groups.clear();
    this.speedIndex = DEFAULT_SPEED_INDEX;
    this.game.speed = SPEEDS[this.speedIndex];
    this.game.paused = false;
    this.hud.setSpeedUI(this.speedIndex, false);

    document.getElementById('you-name').textContent =
      cfg.side === FACTION.ATTACK ? 'YOUR ASSAULT FLEET' : 'YOUR DEFENCE FLEET';
    document.getElementById('enemy-name').textContent =
      cfg.side === FACTION.ATTACK ? 'PLANETARY DEFENCE' : 'ENEMY ASSAULT';

    this.frameOnOwnFleet();
  }

  /** Open on a view that shows your fleet and the planet it's fighting over. */
  frameOnOwnFleet() {
    const mine = this.game.playerUnits;
    if (!mine.length) return;
    const c = new THREE.Vector3();
    for (const u of mine) c.add(u.pos);
    c.divideScalar(mine.length);
    const planet = new THREE.Vector3(...WORLD.planetCenter);
    // Sit behind the fleet, looking along its axis of advance.
    this.rig.targetFocus.copy(c).lerp(planet, 0.25);
    this.rig.focus.copy(this.rig.targetFocus);
    this.rig.theta = this.playerFaction === FACTION.ATTACK ? Math.PI : 0;
    this.rig.phi = 1.15;
    this.rig.targetRadius = 1500;
    this.rig.radius = 1500;
    this.rig.apply();
  }

  resetBattle() {
    if (!this.setup) return;
    this.hud.hideEnd();
    this.startBattle(this.setup);
  }

  backToBuilder() {
    this.hud.hideEnd();
    this.hud.hide();
    this.game.reset();
    this.setSelection([]);
    this.uiBlocking = true;
    this.builder.show();
    this.builder.refresh();
  }

  onBattleEnd(state) {
    this.uiBlocking = true;
    this.hud.showEnd(state, this.game);
  }

  onEscape() {
    if (this.selection.length) this.setSelection([]);
  }

  // -------------------------------------------------------------------------
  setSelection(units) {
    const seen = new Set();
    this.selection = units.filter((u) => {
      if (!u || !u.alive || u.faction !== this.playerFaction || seen.has(u)) return false;
      seen.add(u);
      return true;
    });
    for (const u of this.game.units) u.selected = false;
    for (const u of this.selection) u.selected = true;
    this.hud.refreshPanel();
  }

  selectAll() {
    this.setSelection(this.game.playerUnits);
  }

  assignGroup(n) {
    if (!this.selection.length) return;
    this.groups.set(n, [...this.selection]);
  }

  selectGroup(n) {
    const g = this.groups.get(n);
    if (g) this.setSelection(g.filter((u) => u.alive));
  }

  castSelected() {
    for (const u of this.selection) {
      if (u.alive && u.abilityReady) this.game.castFor(u);
    }
    this.hud.refreshPanel();
  }

  flashOrder(pos, isAttack) {
    this.fleet.bubble(pos, 70, this.playerFaction, isAttack ? 0xff6b5a : 0x7fffd0);
  }

  // -------------------------------------------------------------------------
  togglePause() {
    if (this.game.state !== 'playing') return;
    this.game.paused = !this.game.paused;
    this.hud.setSpeedUI(this.speedIndex, this.game.paused);
  }

  setSpeedIndex(i) {
    this.speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, i));
    this.game.speed = SPEEDS[this.speedIndex];
    // Touching the speed control implies you want it running.
    if (this.game.paused) this.game.paused = false;
    this.hud.setSpeedUI(this.speedIndex, this.game.paused);
  }

  stepSpeed(delta) {
    this.setSpeedIndex(this.speedIndex + delta);
  }

  // -------------------------------------------------------------------------
  loop() {
    requestAnimationFrame(() => this.loop());
    // Clamp so an alt-tab doesn't dump a huge dt into the simulation.
    const dt = Math.min(this.clock.getDelta(), 0.1);

    this.input.update(dt);
    this.rig.update(dt);
    this.scene.update(dt);

    if (!this.uiBlocking || this.game.state !== 'playing') {
      this.game.update(dt);
      if (this.commander && !this.game.paused && this.game.state === 'playing') {
        this.commander.update(dt * this.game.speed);
      }
      this.game.drawTracers();
      this.hud.update(this.game);
      this.hud.showHover(
        this.hoverUnit, this.hoverPos.x, this.hoverPos.y, this.playerFaction,
      );
    }

    this.scene.render();
  }
}

const app = new App();
// Exposed for debugging and automated smoke tests.
window.__app = app;
