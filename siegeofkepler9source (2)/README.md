# Siege of Kepler-9

A 3D real-time space-battle strategy game — Total War in orbit. Pick a side,
spend a point budget on a fleet, then command squadrons through a full
six-axis volume as they fight over a planet.

Runs entirely in the browser. No build step, no CDN, no external assets —
every hull, the planet, and the starfield are generated procedurally at load.

---

## Running it

### Quickest — the standalone file

`dist/siege-of-kepler-9.html` is the entire game in one 620 KB file: markup,
styles, three.js and all game code inlined, with no external requests.

**Double-click it.** It runs straight off the filesystem, no server needed.
It's also a single file you can email, drop in a shared folder, or put on any
static host.

Rebuild it after changing the source:

```bash
node build.mjs
```

### From source

The unbundled version uses ES modules, which need to be served over HTTP —
opening `index.html` off the filesystem will fail CORS. Any static server works:

```bash
npm start                    # via npx http-server
python3 -m http.server 8080  # or just this, then open localhost:8080
```

Requires a browser with WebGL2 — anything current. A discrete GPU is not
needed, but software rendering will struggle above ~2000 points.

---

## The game

You pick **Attack** or **Defend**, and both sides get the same point budget
(configurable from 400 to 4000 on the setup screen).

- **Attackers** must destroy the defending fleet *and* every ground
  emplacement on the surface. Everything they field has to fly.
- **Defenders** hold the high orbit and are the only side that may buy
  **ground support** — turrets, walkers and repair rigs dug into the planet.

You win by destroying every opposing unit.

Light craft are bought as **squadrons** that move and fight as one commandable
unit; capitals are bought individually — so a Wasp squadron's 198 points buys
six hulls, while a Bastion's 70 buys one.

Costs are derived rather than guessed: each unit's power is measured as
sqrt(effective HP × effective DPS) *after* the accuracy model and armour are
applied, and priced so every combat unit lands on the same power-per-point.
The Aegis, Repair Rig and Specter sit below that line deliberately — their
value is utility the damage metric cannot see.

### Ships

| Ship | Spd | HP | Skill | DPS | Agi | Buy | Cost | Role |
|---|---|---|---|---|---|---|---|---|
| **Wasp** | 90 | 20 | 55 | 40 | 95 | ×6 | 198 | Hit-and-run harasser. Dies fast if caught, almost never gets caught. |
| **Falcon** | 75 | 35 | 70 | 75 | 80 | ×5 | 290 | Glass-cannon all-rounder. The fleet's can-opener. |
| **Warden** | 55 | 55 | 55 | 55 | 55 | ×1 | 56 | Balanced escort. The baseline everything else is measured against. |
| **Bastion** | 30 | 95 | 35 | 75 | 15 | ×1 | 70 | Frontline tank. Soaks damage, hits hard, cannot catch anything. |
| **Aegis** | 30 | 75 | 90 | 15 | 30 | ×1 | 85 | Support carrier. Almost no guns, enormous utility. |
| **Specter** | 65 | 10 | 85 | 10 | 70 | ×3 | 42 | Cloaked scout. Nearly impossible to find, nearly harmless in a fight. |

### Ground support (defenders only)

| Unit | Spd | HP | Skill | DPS | Agi | Cost | Role |
|---|---|---|---|---|---|---|---|
| **Sentry Turret** | 0 | 60 | 40 | 80 | 0 | 63 | Static area denial. Brutal at a chokepoint, useless once the fight moves. |
| **Repair Rig** | 20 | 40 | 95 | 0 | 20 | 40 | Mobile repair. Zero offense — it needs protecting. |
| **Flak Walker** | 40 | 75 | 40 | 60 | 20 | 76 | Anti-fighter. Shreds fast movers, bounces off heavy armour. |

### Abilities

Every unit has one, and they **autocast** by default so a large battle doesn't
need babysitting. Select a unit and press **Q** to fire it manually, or **T**
to turn autocast off for that unit.

| Unit | Ability |
|---|---|
| Wasp | **Blink Dash** — instant 180u displacement that breaks every lock on it |
| Falcon | **Missile Volley** — homing salvo, heavy burst at extended range |
| Warden | **Shield Bubble** — damage-absorbing shield over itself and nearby allies |
| Bastion | **Armor Overcharge** — 50% damage reduction, and taunts nearby enemies onto itself |
| Aegis | **Repair Drones** — sustained area repair |
| Specter | **Sensor Jam** — enemies in radius cannot acquire new targets |
| Sentry Turret | **Overcharge Burst** — doubles rate of fire |
| Repair Rig | **Field Repair** — repairs ground units and ships in low orbit |
| Flak Walker | **Flak Screen** — proximity burst that only catches fast movers |

---

## Controls

| Input | Action |
|---|---|
| **Left drag** | Box-select your squadrons |
| **Right click** | Move order — on an enemy, attack order |
| **Right drag ↕** | **Set the destination's altitude.** X/Z lock on press; dragging up/down raises and lowers the target point along a visible stalk |
| **Middle drag** | Orbit camera (Shift+middle to pan) |
| **W A S D** | Pan · **R / V** raise & lower · **wheel** zoom |
| **Q** | Fire the selected unit's ability |
| **H** / **T** | Hold position / toggle autocast |
| **E** / **F** | Select all / focus camera on selection |
| **Ctrl+1–9** / **1–9** | Assign / recall control group |
| **Space** / **[** **]** | Pause / slow down / speed up |

Speed, pause and reset also live on the bar at the bottom of the screen.

### Commanding in three dimensions

The hard problem in a space RTS is placing an order inside a volume with a
2D mouse. The solution here is a two-stage right-click:

1. **Press** right mouse — a ray onto the horizontal plane through your
   current selection fixes **X and Z**.
2. **Drag up or down** — X/Z are now frozen, and vertical mouse motion sets
   the **altitude**, drawn as a stalk from the plane to the marker.
3. **Release** to commit.

A right-click with no drag is an ordinary flat move, so routine orders stay a
single click and altitude only costs you effort when you want it.

---

## How the simulation works

### Stats drive everything

The 0–100 design stats are converted into world units in `src/config.js`:
speed becomes units/second, health becomes hit points, agility becomes both
turn rate *and* evasion, and skill becomes both ability power *and* weapon
tracking.

**Accuracy is the key interaction.** A weapon's tracking comes from the firing
ship's agility and skill, checked against the target's agility:

```
accuracy = 0.5 + (tracking - targetAgility) / 140     clamped to [0.10, 0.95]
```

That single line is what makes the Wasp's 95 agility mean "almost never gets
caught" instead of just being a big number. A Bastion (tracking 25) firing at
a Wasp (agility 95) lands on the 10% floor — it genuinely cannot deal with
interceptors and needs escorts that can. A target moving slowly loses most of
this benefit, so a parked ship is an easy ship.

### Two mechanics the raw stat sheet needed

1. **Armour and penetration.** Without them, a Wasp squadron out-damages a
   Bastion's own guns and kills the tank in about six seconds. Heavy hulls now
   shrug off small-calibre fire, so light craft cannot crack armour alone.
2. **Proximity-fused flak.** The Flak Walker's tracking (30) against a Wasp's
   agility (95) also lands on the accuracy floor — which would leave the
   designated anti-fighter unit unable to hit fighters. Flak skips the tracking
   check entirely and instead leans on its damage bonus versus agile targets
   and its penalty versus armour.

The accuracy model also forces the pricing. Because capitals genuinely cannot
hit fighters, a naively-priced Falcon squadron delivered roughly **15× a
Bastion's effective damage for half the cost** — fighters dominated outright
and any fleet that skipped them lost automatically. Deriving cost from measured
power rather than from feel is what keeps all six ship classes worth buying.

The resulting matchups (time to kill one target hull, from one full purchase):

```
ATTACKER    Wasp   Falcon  Warden  Bastion  Aegis  Specter
Wasp         3.1    4.4     5.7     10.7     7.2     1.0
Falcon       2.0    2.7     3.4      5.0     3.9     0.7
Bastion     35.6   58.1    34.2     29.6    28.7    10.0
Flak         3.1    5.7    19.4    111.7    68.6     1.6
```

Flak kills a Wasp in 3 seconds and needs nearly two minutes on a Bastion.
The Bastion cannot meaningfully shoot fighters at all. Roles hold.

### Fog of war and cloak

Visibility is resolved for **both** sides independently, so cloak is
symmetrical — your Specter is exactly as invisible to the enemy commander as
theirs is to you. Cloaked hulls need a detector within 130 units (Aegis and
Specter sensors get 2.2× that), and firing reveals them for four seconds.

### Flight

Ships steer at a rate set by their agility and then accelerate along their
nose — they do not strafe. That is why a Bastion feels like it weighs
something and a turn it cannot make is a shot it eats. Agile craft fly
strafing runs and break off; capitals hold a standoff and present a broadside.

### Fixed timestep

The simulation runs at a fixed 1/30s step, and the speed control changes how
many steps are taken per frame — not the step size. Scaling `dt` directly
would make 8× behave differently from 1× (fighters overshooting, projectiles
tunnelling through targets), so battles stay identical at every speed.

Shots are travelling projectiles, but the hit is decided by the accuracy roll
at *fire* time. Deciding on impact would double-dip: slow rounds would miss
agile targets twice, once on the roll and again on travel time.

---

## Layout

```
index.html          shell, screens, import map
styles.css          interface
favicon.ico
build.mjs           bundles everything into dist/ as one standalone file
src/
  config.js         all unit stats, costs, balance constants
  util.js           math, seeded RNG, 6-DOF steering helper
  models.js         procedural hulls, merged per material slot
  scene.js          renderer, lighting, planet, starfield, post-processing
  entities.js       Craft / Unit, flight and ground movement
  combat.js         targeting, accuracy, projectiles, fog of war
  skills.js         all nine abilities + autocast heuristics
  ai.js             enemy fleet composition and battlefield behaviour
  render.js         InstancedMesh fleet drawing, tracers, particles
  game.js           spawning, fixed-step sim, gunnery, win check
  ui.js             fleet builder + HUD
  main.js           app shell and frame loop
vendor/             three.js r169 + postprocessing (vendored, offline)
```

Rendering uses one `InstancedMesh` per ship-class/faction/material, so a
400-hull battle costs a few dozen draw calls instead of a few thousand.
