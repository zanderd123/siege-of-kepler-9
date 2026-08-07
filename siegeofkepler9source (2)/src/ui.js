/**
 * DOM layer: the fleet builder and the in-battle HUD.
 * Nothing here touches the simulation directly — it reads game state and
 * calls back into the app.
 */
import { SHIPS, GROUND, BUDGET, SPEEDS, unitCost, derive } from './config.js';
import { formatTime } from './util.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const STAT_KEYS = [
  ['SPD', 'speed'], ['HP', 'health'], ['DPS', 'dps'],
  ['AGI', 'agility'], ['SKL', 'skill'],
];

/** Bought for utility, not firepower — Auto-Build never spams these. */
const UTILITY_IDS = new Set(['aegis', 'rig', 'specter']);

// ===========================================================================
// Fleet builder
// ===========================================================================
export class Builder {
  constructor(onLaunch) {
    this.onLaunch = onLaunch;
    this.side = null;
    this.budget = BUDGET.default;
    this.roster = new Map();

    this.root = $('setup');
    this.budgetInput = $('budget');
    this.budgetOut = $('budget-value');

    this.budgetInput.addEventListener('input', () => {
      this.budget = Number(this.budgetInput.value);
      this.budgetOut.textContent = this.budget;
      $('budget-total').textContent = this.budget;
      $('budget-hint').textContent = this.budgetHint();
      this.refresh();
    });

    for (const card of document.querySelectorAll('.side-card')) {
      card.addEventListener('click', () => this.pickSide(card.dataset.side));
    }

    $('auto-fill').addEventListener('click', () => this.autoFill());
    $('clear-fleet').addEventListener('click', () => { this.roster.clear(); this.refresh(); });
    $('launch').addEventListener('click', () => {
      if (this.spent > this.budget || !this.roster.size) return;
      this.onLaunch({
        side: this.side,
        budget: this.budget,
        roster: [...this.roster.entries()].map(([typeId, qty]) => ({ typeId, qty })),
      });
    });

    this.buildCards();
  }

  budgetHint() {
    const b = this.budget;
    if (b <= 800) return 'Patrol action — small, fast, decisive';
    if (b <= 1400) return 'Skirmish — fast, readable battles';
    if (b <= 2400) return 'Battle — a proper fleet engagement';
    if (b <= 3200) return 'Fleet action — large, heavy on the GPU';
    return 'Armada — hundreds of hulls. Expect frame cost.';
  }

  get spent() {
    let t = 0;
    for (const [id, qty] of this.roster) {
      t += unitCost(SHIPS[id] || GROUND[id]) * qty;
    }
    return t;
  }

  pickSide(side) {
    this.side = side;
    for (const c of document.querySelectorAll('.side-card')) {
      c.classList.toggle('active', c.dataset.side === side);
    }
    $('builder').classList.remove('hidden');
    // Ground support is a defender-only capability.
    const isDef = side === 'defense';
    $('ground-label').classList.toggle('hidden', !isDef);
    $('ground-cards').classList.toggle('hidden', !isDef);
    if (!isDef) {
      for (const id of Object.keys(GROUND)) this.roster.delete(id);
    }
    this.refresh();
    $('builder').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  card(type) {
    const c = el('div', 'unit-card');
    c.dataset.type = type.id;
    const cost = unitCost(type);

    c.appendChild(el('div', 'uc-top',
      `<span class="uc-name">${type.name}</span><span class="uc-cost">${cost}</span>`));
    c.appendChild(el('div', 'uc-class', type.className.toUpperCase()));
    c.appendChild(el('div', 'uc-role', type.role));

    const stats = el('div', 'stat-rows');
    for (const [label, key] of STAT_KEYS) {
      stats.appendChild(el('div', 'stat-row',
        `<span>${label}</span><div class="stat-bar"><i style="width:${type[key]}%"></i></div><b>${type[key]}</b>`));
    }
    c.appendChild(stats);

    c.appendChild(el('div', 'uc-ability',
      `<b>${type.ability.name}</b> — ${type.ability.desc}`));

    if (type.count > 1) {
      c.appendChild(el('div', 'uc-squad',
        `SQUADRON OF ${type.count} · ${type.costEach} pts each`));
    }

    const buy = el('div', 'uc-buy');
    const minus = el('button', null, '−');
    const qty = el('div', 'uc-qty', '0');
    const plus = el('button', null, '+');
    minus.addEventListener('click', () => this.adjust(type.id, -1));
    plus.addEventListener('click', () => this.adjust(type.id, +1));
    buy.append(minus, qty, plus);
    c.appendChild(buy);

    c._qty = qty;
    c._plus = plus;
    c._minus = minus;
    c._cost = cost;
    return c;
  }

  buildCards() {
    this.cards = new Map();
    const shipGrid = $('ship-cards');
    const groundGrid = $('ground-cards');
    for (const type of Object.values(SHIPS)) {
      const c = this.card(type);
      shipGrid.appendChild(c);
      this.cards.set(type.id, c);
    }
    for (const type of Object.values(GROUND)) {
      const c = this.card(type);
      groundGrid.appendChild(c);
      this.cards.set(type.id, c);
    }
  }

  adjust(id, delta) {
    const cur = this.roster.get(id) || 0;
    const type = SHIPS[id] || GROUND[id];
    const next = cur + delta;
    if (next < 0) return;
    if (delta > 0 && this.spent + unitCost(type) > this.budget) return;
    if (next === 0) this.roster.delete(id);
    else this.roster.set(id, next);
    this.refresh();
  }

  /**
   * Spend the budget on a reasonable balanced fleet in one click.
   * Utility units are capped: topping up with the cheapest affordable unit
   * would otherwise hand you a fleet of Repair Rigs and Specters, which are
   * now the cheapest things on the board and cannot win a fight.
   */
  autoFill() {
    this.roster.clear();
    const plan = this.side === 'defense'
      ? [['bastion', 0.20], ['warden', 0.18], ['falcon', 0.16], ['aegis', 0.12],
         ['sentry', 0.12], ['flak', 0.10], ['wasp', 0.08], ['rig', 0.04]]
      : [['falcon', 0.30], ['bastion', 0.24], ['wasp', 0.18], ['warden', 0.14],
         ['aegis', 0.09], ['specter', 0.05]];
    const CAPS = { aegis: 2, rig: 2, specter: 2, sentry: 5, flak: 4 };
    const cap = (id) => CAPS[id] ?? Infinity;

    for (const [id, share] of plan) {
      const type = SHIPS[id] || GROUND[id];
      const n = Math.min(cap(id), Math.floor((this.budget * share) / unitCost(type)));
      if (n > 0) this.roster.set(id, n);
    }
    // Top up by template weight, not cheapest-first — otherwise the whole
    // remainder goes on whichever hull happens to be cheapest.
    let guard = 0;
    while (guard++ < 400) {
      const opts = plan
        .filter(([id]) => !UTILITY_IDS.has(id))
        .map(([id, w]) => ({ type: SHIPS[id] || GROUND[id], w }))
        .filter(({ type }) => (this.roster.get(type.id) || 0) < cap(type.id)
          && this.spent + unitCost(type) <= this.budget);
      if (!opts.length) break;
      let r = Math.random() * opts.reduce((s, o) => s + o.w, 0);
      let pick = opts[opts.length - 1];
      for (const o of opts) { r -= o.w; if (r <= 0) { pick = o; break; } }
      this.roster.set(pick.type.id, (this.roster.get(pick.type.id) || 0) + 1);
    }
    this.refresh();
  }

  refresh() {
    const spent = this.spent;
    const over = spent > this.budget;
    $('spent').textContent = spent;
    $('budget-total').textContent = this.budget;
    $('spend-fill').style.width = `${Math.min(100, (spent / this.budget) * 100)}%`;
    document.querySelector('.spend').classList.toggle('over', over);

    for (const [id, card] of this.cards) {
      const qty = this.roster.get(id) || 0;
      card._qty.textContent = qty;
      card.classList.toggle('owned', qty > 0);
      card._minus.disabled = qty === 0;
      card._plus.disabled = spent + card._cost > this.budget;
    }

    // Roster summary.
    const list = $('roster-list');
    list.innerHTML = '';
    if (!this.roster.size) {
      list.appendChild(el('p', 'empty', 'No units purchased.'));
    } else {
      for (const [id, qty] of this.roster) {
        const t = SHIPS[id] || GROUND[id];
        const hulls = t.count * qty;
        list.appendChild(el('div', 'roster-item',
          `<span>${t.name} ×${qty}<br><small>${hulls} hull${hulls > 1 ? 's' : ''}</small></span>
           <b>${unitCost(t) * qty}</b>`));
      }
    }

    // Aggregate fleet stats — a quick read on what you actually built.
    let hulls = 0, hp = 0, dps = 0, units = 0;
    for (const [id, qty] of this.roster) {
      const t = SHIPS[id] || GROUND[id];
      const d = derive(t);
      units += qty;
      hulls += t.count * qty;
      hp += d.maxHealth * t.count * qty;
      dps += d.dps * t.count * qty;
    }
    $('roster-stats').innerHTML = `
      <div><span>SQUADRONS / UNITS</span><b>${units}</b></div>
      <div><span>TOTAL HULLS</span><b>${hulls}</b></div>
      <div><span>FLEET HP</span><b>${Math.round(hp).toLocaleString()}</b></div>
      <div><span>RAW DPS</span><b>${Math.round(dps).toLocaleString()}</b></div>
      <div><span>UNSPENT</span><b>${this.budget - spent}</b></div>`;

    $('launch').disabled = over || !this.roster.size || !this.side;
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }
}

// ===========================================================================
// In-battle HUD
// ===========================================================================
export class Hud {
  constructor(app) {
    this.app = app;
    this.root = $('hud');

    $('btn-pause').addEventListener('click', () => app.togglePause());
    $('btn-reset').addEventListener('click', () => app.resetBattle());
    $('btn-newfleet').addEventListener('click', () => app.backToBuilder());

    this.speed = $('speed');
    this.speed.addEventListener('input', () => {
      app.setSpeedIndex(Number(this.speed.value));
    });

    $('toggle-hold').addEventListener('click', () => {
      const on = !app.selection.every((u) => u.holdPosition);
      for (const u of app.selection) u.holdPosition = on;
      this.refreshPanel();
    });
    $('toggle-autocast').addEventListener('click', () => {
      const on = !app.selection.every((u) => u.autocast);
      for (const u of app.selection) u.autocast = on;
      this.refreshPanel();
    });

    $('end-again').addEventListener('click', () => app.resetBattle());
    $('end-new').addEventListener('click', () => app.backToBuilder());

    this.hover = $('hover-card');
    this.panel = $('sel-panel');
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }

  setSpeedUI(index, paused) {
    const scale = SPEEDS[index];
    this.speed.value = index;
    $('speed-value').textContent = `${scale}x`;
    $('speed-label').textContent = paused ? 'PAUSED' : `${scale}x`;

    const btn = $('btn-pause');
    btn.classList.toggle('paused', paused);
    $('pause-label').textContent = paused ? 'RESUME' : 'PAUSE';
    btn.querySelector('.ic-pause').classList.toggle('hidden', paused);
    btn.querySelector('.ic-play').classList.toggle('hidden', !paused);
  }

  /** Per-frame cheap updates: force bars and clock. */
  update(game) {
    const you = { n: 0, hp: 0, max: 0 };
    const them = { n: 0, hp: 0, max: 0 };
    for (const u of game.units) {
      const side = u.faction === game.playerFaction ? you : them;
      const cap = u.stats.maxHealth * u.type.count;
      side.max += cap;
      if (u.alive) {
        side.n += u.count;
        side.hp += u.craft.reduce((s, c) => s + (c.alive ? c.hp : 0), 0);
      }
    }
    $('you-count').textContent = you.n;
    $('enemy-count').textContent = them.n;
    $('you-fill').style.width = `${you.max ? (you.hp / you.max) * 100 : 0}%`;
    $('enemy-fill').style.width = `${them.max ? (them.hp / them.max) * 100 : 0}%`;
    $('clock').textContent = formatTime(game.now);

    if (this.panelUnit && this.panelUnit.alive) this.refreshLive();
    else if (this.panelUnit && !this.panelUnit.alive) this.refreshPanel();
  }

  /** Full rebuild of the selection panel — called when selection changes. */
  refreshPanel() {
    const sel = this.app.selection.filter((u) => u.alive);
    if (!sel.length) {
      this.panel.classList.add('hidden');
      this.panelUnit = null;
      return;
    }
    this.panel.classList.remove('hidden');
    const lead = sel[0];
    this.panelUnit = lead;
    const t = lead.type;
    const mixed = sel.some((u) => u.type.id !== t.id);

    $('sel-title').textContent = mixed ? `${sel.length} UNITS SELECTED` : t.name.toUpperCase();
    $('sel-sub').textContent = mixed
      ? sel.map((u) => u.type.name).filter((v, i, a) => a.indexOf(v) === i).join(' · ').toUpperCase()
      : `${t.className.toUpperCase()}${sel.length > 1 ? ` · ×${sel.length}` : ''}`;

    const hulls = sel.reduce((n, u) => n + u.count, 0);
    const maxHulls = sel.reduce((n, u) => n + u.type.count, 0);
    $('sel-stats').innerHTML = `
      <div class="hp-track"><i id="sel-hp" style="width:100%"></i></div>
      <div class="row"><span>HULLS</span><b id="sel-hulls">${hulls} / ${maxHulls}</b></div>
      <div class="row"><span>SPEED</span><b>${t.speed}</b></div>
      <div class="row"><span>DPS (each)</span><b>${t.dps}</b></div>
      <div class="row"><span>AGILITY</span><b>${t.agility}</b></div>
      <div class="row"><span>WEAPON RANGE</span><b>${t.range || '—'}</b></div>
      <div class="row"><span>SENSORS</span><b>${t.sensor}</b></div>`;

    const ab = $('sel-ability');
    ab.innerHTML = '';
    if (!mixed) {
      const btn = el('button', 'ability-btn', `
        <span class="ab-key">${t.ability.key}</span>
        <span class="ab-name">${t.ability.name}</span>
        <span class="ab-desc">${t.ability.desc}</span>
        <i class="ab-cd" style="width:0%"></i>`);
      btn.addEventListener('click', () => this.app.castSelected());
      ab.appendChild(btn);
      this.abilityBtn = btn;
      this.abilityCd = btn.querySelector('.ab-cd');
    } else {
      this.abilityBtn = null;
      this.abilityCd = null;
    }

    $('toggle-hold').classList.toggle('on', sel.every((u) => u.holdPosition));
    $('toggle-autocast').classList.toggle('on', sel.every((u) => u.autocast));
    this.refreshLive();
  }

  /** Values that change every frame while the panel stays open. */
  refreshLive() {
    const sel = this.app.selection.filter((u) => u.alive);
    if (!sel.length) return;
    const hulls = sel.reduce((n, u) => n + u.count, 0);
    const maxHulls = sel.reduce((n, u) => n + u.type.count, 0);
    const hp = sel.reduce((s, u) => s + u.healthFraction * u.type.count, 0) / maxHulls;
    const hpEl = document.getElementById('sel-hp');
    const hullEl = document.getElementById('sel-hulls');
    if (hpEl) hpEl.style.width = `${Math.max(0, hp * 100)}%`;
    if (hullEl) hullEl.textContent = `${hulls} / ${maxHulls}`;

    if (this.abilityBtn) {
      const u = sel[0];
      const cd = Math.max(0, u.abilityCooldown);
      const frac = cd / u.type.ability.cooldown;
      this.abilityCd.style.width = `${frac * 100}%`;
      this.abilityBtn.disabled = cd > 0;
      const name = this.abilityBtn.querySelector('.ab-name');
      name.textContent = cd > 0
        ? `${u.type.ability.name} — ${cd.toFixed(1)}s`
        : u.type.ability.name;
    }
  }

  showHover(unit, x, y, playerFaction) {
    if (!unit || !unit.alive) { this.hover.classList.add('hidden'); return; }
    const own = unit.faction === playerFaction;
    this.hover.classList.remove('hidden');
    this.hover.innerHTML = `
      <b style="color:${own ? 'var(--cyan)' : 'var(--amber)'}">${unit.type.name}</b>
      <span class="hc-hp"> ${unit.count}/${unit.type.count} · ${Math.round(unit.healthFraction * 100)}%</span>`;
    this.hover.style.left = `${x + 16}px`;
    this.hover.style.top = `${y + 14}px`;
  }

  showEnd(state, game) {
    const win = state === 'victory';
    $('end-title').textContent = win ? 'VICTORY' : (state === 'defeat' ? 'DEFEAT' : 'MUTUAL DESTRUCTION');
    $('end-title').className = win ? 'victory' : 'defeat';
    $('end-sub').textContent = win
      ? (game.playerFaction === 'attack'
        ? 'The orbital cordon is broken and the surface is silent.'
        : 'The assault is scattered. The world holds.')
      : (game.playerFaction === 'attack'
        ? 'Your assault has been annihilated in orbit.'
        : 'The cordon has fallen. The world is theirs.');

    const survivors = game.units
      .filter((u) => u.faction === game.playerFaction && u.alive)
      .reduce((n, u) => n + u.count, 0);
    $('end-stats').innerHTML = `
      <div><span>DURATION</span><b>${formatTime(game.now)}</b></div>
      <div><span>KILLS</span><b>${game.kills[game.playerFaction]}</b></div>
      <div><span>SURVIVORS</span><b>${survivors}</b></div>`;
    $('endscreen').classList.remove('hidden');
  }

  hideEnd() { $('endscreen').classList.add('hidden'); }
}
