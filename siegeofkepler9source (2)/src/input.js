/**
 * Camera rig, selection, and 3D order input.
 *
 * The hard problem in a space RTS is issuing an order in a volume with a
 * 2D mouse. The solution here is the two-stage move order:
 *
 *   1. press right mouse   -> ray-cast onto the horizontal plane through the
 *                             current selection; that fixes X and Z
 *   2. drag up/down        -> X and Z are now FROZEN; vertical mouse motion
 *                             raises or lowers the destination, drawn as a
 *                             stalk from the plane up to the marker
 *   3. release             -> commit
 *
 * A tap with no drag is just a flat move, so ordinary orders stay one click
 * and the altitude control only costs you anything when you want it.
 */
import * as THREE from 'three';
import { clamp } from './util.js';
import { DISPLAY_SCALE } from './config.js';

const MAX_RINGS = 640;
const _ringM = new THREE.Matrix4();
const _ringS = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _plane = new THREE.Plane();
const _hit = new THREE.Vector3();
const _v = new THREE.Vector3();
const _proj = new THREE.Vector3();

export class CameraRig {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.focus = new THREE.Vector3(0, 0, -400);
    this.theta = Math.PI;      // azimuth
    this.phi = 1.05;           // polar, from +Y
    this.radius = 1500;
    this.minRadius = 90;
    this.maxRadius = 5200;
    this.targetRadius = this.radius;
    this.targetFocus = this.focus.clone();
    this.apply();
  }

  apply() {
    this.phi = clamp(this.phi, 0.08, Math.PI - 0.08);
    const sp = Math.sin(this.phi);
    this.camera.position.set(
      this.focus.x + this.radius * sp * Math.sin(this.theta),
      this.focus.y + this.radius * Math.cos(this.phi),
      this.focus.z + this.radius * sp * Math.cos(this.theta),
    );
    this.camera.lookAt(this.focus);
  }

  orbit(dx, dy) {
    this.theta -= dx * 0.005;
    this.phi -= dy * 0.005;
  }

  /** Pan across the camera's own plane so dragging feels 1:1 with the view. */
  pan(dx, dy) {
    const scale = this.radius * 0.0016;
    this.camera.getWorldDirection(_v);
    const right = _v.clone().cross(this.camera.up).normalize();
    const up = right.clone().cross(_v).normalize();
    this.targetFocus.addScaledVector(right, -dx * scale);
    this.targetFocus.addScaledVector(up, dy * scale);
  }

  /** Push the focus along the ground plane — used by keyboard/edge scroll. */
  panAxis(forward, strafe, dt) {
    const speed = this.radius * 1.1 * dt;
    this.camera.getWorldDirection(_v);
    _v.y = 0;
    if (_v.lengthSq() < 1e-6) _v.set(0, 0, -1);
    _v.normalize();
    const right = _v.clone().cross(new THREE.Vector3(0, 1, 0)).normalize().negate();
    this.targetFocus.addScaledVector(_v, forward * speed);
    this.targetFocus.addScaledVector(right, strafe * speed);
  }

  zoom(delta) {
    this.targetRadius = clamp(this.targetRadius * (1 + delta * 0.0016),
      this.minRadius, this.maxRadius);
  }

  frameOn(pos, radius = 500) {
    this.targetFocus.copy(pos);
    this.targetRadius = clamp(radius, this.minRadius, this.maxRadius);
  }

  update(dt) {
    const k = Math.min(1, dt * 9);
    this.radius += (this.targetRadius - this.radius) * k;
    this.focus.lerp(this.targetFocus, k);
    this.apply();
  }
}

// ---------------------------------------------------------------------------

export class InputController {
  constructor(app) {
    this.app = app;
    this.rig = app.rig;
    this.dom = app.renderer.domElement;
    this.keys = new Set();

    this.dragging = null;      // 'select' | 'orbit' | 'pan' | 'order'
    this.start = { x: 0, y: 0 };
    this.cur = { x: 0, y: 0 };
    this.orderBase = new THREE.Vector3();
    this.orderPoint = new THREE.Vector3();
    this.orderAltitude = 0;
    this.orderTargetUnit = null;
    this.moved = false;
    this.lastHoverPick = 0;

    this.selectionBox = document.getElementById('selection-box');
    this.buildGizmos();
    this.bind();
  }

  // --- gizmos -------------------------------------------------------------
  buildGizmos() {
    const scene = this.app.scene.scene;
    this.gizmo = new THREE.Group();
    this.gizmo.visible = false;
    scene.add(this.gizmo);

    const mat = new THREE.MeshBasicMaterial({
      color: 0x7fffd0, transparent: true, opacity: 0.9,
      depthTest: false, side: THREE.DoubleSide,
    });
    this.gizmoMat = mat;

    // Base disc on the reference plane.
    this.baseRing = new THREE.Mesh(new THREE.RingGeometry(26, 32, 32), mat);
    this.baseRing.rotation.x = -Math.PI / 2;
    this.gizmo.add(this.baseRing);

    // Vertical stalk from the plane to the commanded altitude.
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(0, 1, 0),
    ]);
    this.stalk = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({
      color: 0x7fffd0, transparent: true, opacity: 0.75, depthTest: false,
    }));
    this.gizmo.add(this.stalk);

    // Destination marker.
    this.marker = new THREE.Mesh(new THREE.TorusGeometry(30, 3.5, 8, 28), mat);
    this.gizmo.add(this.marker);
    this.markerInner = new THREE.Mesh(new THREE.SphereGeometry(6, 10, 8), mat);
    this.gizmo.add(this.markerInner);

    this.gizmo.renderOrder = 999;
    this.gizmo.traverse((o) => { o.renderOrder = 999; });

    // Selection rings: one per selected *craft*, not per squadron. Sizing a
    // single ring to a squadron's spread produces a ring the width of the
    // battlefield the moment fighters break formation.
    this.rings = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.92, 1, 28),
      new THREE.MeshBasicMaterial({
        color: 0x8effc9, transparent: true, opacity: 0.9,
        depthTest: false, side: THREE.DoubleSide,
      }),
      MAX_RINGS,
    );
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 998;
    this.rings.count = 0;
    scene.add(this.rings);
  }

  /** Camera-facing ring around every living craft in the selection. */
  updateSelectionRings() {
    const cam = this.app.scene.camera;
    let n = 0;
    for (const u of this.app.selection) {
      if (!u.alive) continue;
      const size = u.type.scale * DISPLAY_SCALE * 3.2 + 14;
      for (const c of u.craft) {
        if (!c.alive || !c.visible || n >= MAX_RINGS) continue;
        _ringM.compose(c.pos, cam.quaternion, _ringS.setScalar(size));
        this.rings.setMatrixAt(n++, _ringM);
      }
    }
    this.rings.count = n;
    this.rings.instanceMatrix.needsUpdate = true;
  }

  // --- helpers ------------------------------------------------------------
  ndc(x, y) {
    _ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    return _ndc;
  }

  /** Project a world position to CSS pixels. */
  toScreen(pos, out) {
    _proj.copy(pos).project(this.app.scene.camera);
    out.x = (_proj.x * 0.5 + 0.5) * innerWidth;
    out.y = (-_proj.y * 0.5 + 0.5) * innerHeight;
    out.behind = _proj.z > 1;
    return out;
  }

  /** Ray-cast onto the horizontal plane at height `y`. */
  planePoint(x, y, height) {
    _ray.setFromCamera(this.ndc(x, y), this.app.scene.camera);
    _plane.set(new THREE.Vector3(0, 1, 0), -height);
    const hit = _ray.ray.intersectPlane(_plane, _hit);
    if (hit) return _hit.clone();
    // Ray parallel to the plane: fall back to a point out in front.
    return _ray.ray.at(this.rig.radius, new THREE.Vector3());
  }

  /** Reference height for order placement: the selection's own altitude. */
  referenceHeight() {
    const sel = this.app.selection.filter((u) => u.alive);
    if (!sel.length) return 0;
    return sel.reduce((s, u) => s + u.pos.y, 0) / sel.length;
  }

  /** Nearest selectable unit under the cursor, within a pixel radius. */
  pickUnit(x, y, radius = 34) {
    let best = null, bestD = radius * radius;
    const p = { x: 0, y: 0, behind: false };
    for (const u of this.app.game.units) {
      if (!u.alive) continue;
      for (const c of u.craft) {
        if (!c.alive || !c.visible) continue;
        this.toScreen(c.pos, p);
        if (p.behind) continue;
        const dx = p.x - x, dy = p.y - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = u; }
      }
    }
    return best;
  }

  unitsInBox(x0, y0, x1, y1, faction) {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const found = new Set();
    const p = { x: 0, y: 0, behind: false };
    for (const u of this.app.game.units) {
      if (!u.alive || u.faction !== faction) continue;
      for (const c of u.craft) {
        if (!c.alive || !c.visible) continue;
        this.toScreen(c.pos, p);
        if (p.behind) continue;
        if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
          found.add(u);
          break;
        }
      }
    }
    return [...found];
  }

  // --- events -------------------------------------------------------------
  bind() {
    const dom = this.dom;
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    dom.addEventListener('pointerdown', (e) => this.onDown(e));
    addEventListener('pointermove', (e) => this.onMove(e));
    addEventListener('pointerup', (e) => this.onUp(e));
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.rig.zoom(e.deltaY);
    }, { passive: false });

    addEventListener('keydown', (e) => this.onKeyDown(e));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  onDown(e) {
    if (this.app.uiBlocking) return;
    this.start.x = e.clientX; this.start.y = e.clientY;
    this.cur.x = e.clientX; this.cur.y = e.clientY;
    this.moved = false;

    // Middle drag orbits, Shift+middle pans; Alt+left is the trackpad
    // equivalent. Space is deliberately not a modifier here — it is pause.
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      this.dragging = e.shiftKey ? 'pan' : 'orbit';
      e.preventDefault();
      return;
    }
    if (e.button === 0) {
      this.dragging = 'select';
      return;
    }
    if (e.button === 2) {
      if (!this.app.selection.length) return;
      this.dragging = 'order';
      this.orderBase.copy(this.planePoint(e.clientX, e.clientY, this.referenceHeight()));
      this.orderAltitude = 0;
      this.orderPoint.copy(this.orderBase);
      this.orderTargetUnit = this.pickUnit(e.clientX, e.clientY);
      this.showGizmo();
    }
  }

  onMove(e) {
    const dx = e.clientX - this.cur.x;
    const dy = e.clientY - this.cur.y;
    this.cur.x = e.clientX; this.cur.y = e.clientY;
    if (Math.abs(e.clientX - this.start.x) + Math.abs(e.clientY - this.start.y) > 4) {
      this.moved = true;
    }

    // Hover picking projects every visible hull to screen space. At large
    // fleet sizes that is far too expensive to run on every pointermove, so
    // it is throttled — the tooltip does not need per-pixel freshness.
    if (this.dragging) {
      this.app.hoverUnit = null;
    } else {
      const t = performance.now();
      if (t - this.lastHoverPick > 60) {
        this.lastHoverPick = t;
        this.app.hoverUnit = this.pickUnit(e.clientX, e.clientY);
      }
    }

    switch (this.dragging) {
      case 'orbit': this.rig.orbit(dx, dy); break;
      case 'pan': this.rig.pan(dx, dy); break;
      case 'select': this.updateSelectionBox(); break;
      case 'order': {
        // X/Z are locked from the initial press; only altitude tracks now.
        // Tuned so a comfortable drag spans the battle's vertical extent
        // rather than flinging the marker off the top of the screen.
        const scale = this.rig.radius * 0.0018;
        this.orderAltitude -= dy * scale;
        this.orderPoint.copy(this.orderBase);
        this.orderPoint.y += this.orderAltitude;
        this.showGizmo();
        break;
      }
    }
  }

  onUp(e) {
    const mode = this.dragging;
    this.dragging = null;
    if (this.selectionBox) this.selectionBox.style.display = 'none';

    if (mode === 'select') {
      const additive = e.shiftKey;
      if (!this.moved) {
        const u = this.pickUnit(e.clientX, e.clientY);
        if (u && u.faction === this.app.playerFaction) {
          this.app.setSelection(additive ? [...this.app.selection, u] : [u]);
        } else if (!additive) {
          this.app.setSelection([]);
        }
      } else {
        const found = this.unitsInBox(
          this.start.x, this.start.y, e.clientX, e.clientY, this.app.playerFaction,
        );
        this.app.setSelection(additive ? [...this.app.selection, ...found] : found);
      }
    } else if (mode === 'order') {
      this.commitOrder(e);
      this.gizmo.visible = false;
    }
  }

  commitOrder(e) {
    const sel = this.app.selection.filter((u) => u.alive);
    if (!sel.length) return;
    const enemy = this.orderTargetUnit
      && this.orderTargetUnit.faction !== this.app.playerFaction
      ? this.orderTargetUnit : null;

    // Spread multiple squadrons around the destination instead of stacking.
    const spacing = 130;
    const cols = Math.ceil(Math.sqrt(sel.length));
    sel.forEach((u, i) => {
      if (enemy) {
        u.order(enemy.pos, { attack: enemy });
        return;
      }
      const col = i % cols, row = Math.floor(i / cols);
      _v.copy(this.orderPoint).add(new THREE.Vector3(
        (col - (cols - 1) / 2) * spacing,
        0,
        (row - (Math.ceil(sel.length / cols) - 1) / 2) * spacing,
      ));
      u.order(_v, { attack: null });
    });
    this.app.flashOrder(this.orderPoint.clone(), !!enemy);
  }

  showGizmo() {
    this.gizmo.visible = true;
    this.baseRing.position.copy(this.orderBase);
    this.marker.position.copy(this.orderPoint);
    this.markerInner.position.copy(this.orderPoint);
    this.marker.quaternion.copy(this.app.scene.camera.quaternion);
    const h = this.orderPoint.y - this.orderBase.y;
    this.stalk.position.copy(this.orderBase);
    this.stalk.scale.set(1, h, 1);
    this.stalk.visible = Math.abs(h) > 1;
    // Warm the gizmo when it will resolve as an attack order.
    const attacking = this.orderTargetUnit
      && this.orderTargetUnit.faction !== this.app.playerFaction;
    this.gizmoMat.color.set(attacking ? 0xff6b5a : 0x7fffd0);
  }

  updateSelectionBox() {
    const el = this.selectionBox;
    if (!el) return;
    el.style.display = 'block';
    el.style.left = `${Math.min(this.start.x, this.cur.x)}px`;
    el.style.top = `${Math.min(this.start.y, this.cur.y)}px`;
    el.style.width = `${Math.abs(this.cur.x - this.start.x)}px`;
    el.style.height = `${Math.abs(this.cur.y - this.start.y)}px`;
  }

  onKeyDown(e) {
    if (this.app.uiBlocking && e.code !== 'Escape') return;
    this.keys.add(e.code);
    const app = this.app;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        app.togglePause();
        break;
      case 'KeyQ':
        app.castSelected();
        break;
      case 'KeyH':
        for (const u of app.selection) u.holdPosition = !u.holdPosition;
        break;
      case 'KeyT':
        for (const u of app.selection) u.autocast = !u.autocast;
        app.hud.refreshPanel();
        break;
      case 'KeyF': {
        const sel = app.selection.filter((u) => u.alive);
        if (sel.length) {
          _v.set(0, 0, 0);
          for (const u of sel) _v.add(u.pos);
          _v.divideScalar(sel.length);
          this.rig.frameOn(_v, 620);
        }
        break;
      }
      case 'KeyE':
        app.selectAll();
        break;
      case 'Escape':
        app.onEscape();
        break;
      case 'BracketLeft': app.stepSpeed(-1); break;
      case 'BracketRight': app.stepSpeed(1); break;
    }
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5));
      if (n >= 1 && n <= 9) {
        if (e.ctrlKey || e.metaKey) app.assignGroup(n);
        else app.selectGroup(n);
      }
    }
  }

  /** Keyboard / edge panning, run every frame. */
  update(dt) {
    let f = 0, s = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) f += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) f -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) s += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) s -= 1;
    if (f || s) this.rig.panAxis(f, s, dt);
    // Vertical camera nudge, since this is a volume and not a plane.
    const lift = this.rig.radius * dt * 0.7;
    if (this.keys.has('KeyR')) this.rig.targetFocus.y += lift;
    if (this.keys.has('KeyV')) this.rig.targetFocus.y -= lift;
    this.updateSelectionRings();
  }
}
