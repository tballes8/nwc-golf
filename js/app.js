import { parseSessionFile, clubInfo, sessionLabel } from './parse.js';
import { buildProfiles, pickClub, DEFAULTS } from './stats.js';
import { load, save, addSessions, backupBlob, readBackup, requestPersistence, touch, touchSettings, deleteSession, sortSessions } from './store.js';
import { checkAccount, signOut, SIGN_IN_URL, storedAccount, rememberAccount, forgetAccount } from './account.js';
import { syncNow, clearDevice } from './sync.js';
import { byOrder, shotCounts, currentBag, setClub, newClubs, keepBagShots } from './bag.js';

const $ = sel => document.querySelector(sel);
const data = load();
let allProfiles = []; // every club with full swings on record
let profiles = [];    // the clubs in the bag: what Caddie picks from and the chart shows

const fmt = n => Math.round(n).toString();
const pct = n => `${Math.round(n * 100)}%`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const niceDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'No date';

// ---------- Messages in the top bar ----------
// A plain message disappears after a few seconds. A message with action buttons stays until a
// button is used or it's closed (×), then calls onClose. holdsSync: a sync must not start while
// it's up (see runSync), because its action still changes what was just imported.
let notice = null; // { onClose, timer, holdsSync }

function status(msg, { actions = [], onClose = null, holdsSync = false } = {}) {
  endNotice();
  const el = $('#status');
  el.textContent = '';
  if (!msg) return;
  const text = document.createElement('span');
  text.textContent = msg;
  el.append(text);
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'note-btn';
    b.textContent = a.label;
    b.addEventListener('click', () => {
      const mine = notice;
      a.run(); // may show its own message, which ends this one
      if (notice === mine) endNotice();
    });
    el.append(b);
  }
  if (actions.length) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'note-close';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Close message');
    x.addEventListener('click', () => endNotice());
    el.append(x);
  }
  notice = { onClose, holdsSync, timer: setTimeout(endNotice, actions.length ? 60000 : 6000) };
}

function endNotice() {
  if (!notice) return;
  const { onClose, timer } = notice;
  notice = null;
  clearTimeout(timer);
  $('#status').textContent = '';
  onClose?.();
}

function persist() {
  if (!save(data)) status('Couldn’t save. Free up space on this phone, then import again.');
}

function recompute() {
  const usable = data.sessions.filter(s => s.date);
  allProfiles = buildProfiles(usable, { window: data.settings.window, units: data.settings.units, bag: data.settings.bag });
  profiles = allProfiles.filter(p => p.inBag);
}

// ---------- Bag chart ----------
// Column widths shared with .row/.axis in app.css: club name | track | median.
const NAME_W = 76, MEDIAN_W = 40;

/** scale: optional { min, max } in yards; used to hold the chart still while the flag is dragged. */
function bagChart(el, target, pickCode, scale = null) {
  if (!profiles.length) { el.innerHTML = ''; return; }
  let min, max;
  if (scale) ({ min, max } = scale);
  else {
    const lo = Math.min(...profiles.map(p => p.p10), target ?? Infinity);
    const hi = Math.max(...profiles.map(p => p.p90), target ?? -Infinity);
    min = Math.floor((lo - 5) / 10) * 10; max = Math.ceil((hi + 5) / 10) * 10;
  }
  el.dataset.min = min; el.dataset.max = max;
  const x = v => `${((v - min) / (max - min)) * 100}%`;
  const ticks = [];
  const stepT = max - min > 120 ? 25 : 20;
  for (let t = Math.ceil(min / stepT) * stepT; t <= max; t += stepT) ticks.push(t);

  el.innerHTML = `
    <div class="chart">
      ${profiles.map(p => `
        <div class="row${p.code === pickCode ? ' pick' : ''}">
          <span class="nm">${esc(shortName(p))}</span>
          <div class="track" aria-label="${esc(p.name)}: middle half ${fmt(p.p25)} to ${fmt(p.p75)}, median ${fmt(p.median)}">
            <span class="w" style="left:${x(p.p10)};width:calc(${x(p.p90)} - ${x(p.p10)})"></span>
            <span class="q" style="left:${x(p.p25)};width:calc(${x(p.p75)} - ${x(p.p25)})"></span>
            <span class="m" style="left:${x(p.median)}"></span>
          </div>
          <span class="md">${fmt(p.median)}</span>
        </div>`).join('')}
      <div class="axis"><span></span><div class="scale">${ticks.map(t => `<span style="left:${x(t)}">${t}</span>`).join('')}</div><span></span></div>
      ${target != null ? `<div class="flagline" style="left:calc(${NAME_W}px + (100% - ${NAME_W + MEDIAN_W}px) * ${(target - min) / (max - min)})" aria-hidden="true"></div>` : ''}
    </div>`;
}
function shortName(p) {
  return p.name.replace(' iron', 'i').replace(' wood', 'w').replace(' hybrid', 'h').replace('Pitching wedge', 'PW').replace('Gap wedge', 'GW').replace('Sand wedge', 'SW').replace('Lob wedge', 'LW').replace('Approach wedge', 'AW');
}

// ---------- Caddie ----------
function renderCaddie() {
  const target = clampTarget(+$('#target').value);
  const zone = data.settings.zone;
  $('#zone-out').textContent = `± ${zone} yd`;
  const el = $('#answer');

  const { best, backup } = profiles.length ? pickClub(profiles, target, zone) : {};
  if (!best) {
    el.innerHTML = !allProfiles.length
      ? `<div class="empty"><p>Import a few sessions to get club picks from your own shots.</p><button class="btn primary" data-go="sessions">Import sessions</button></div>`
      : `<div class="empty"><p>None of the clubs in your bag has 5 full swings on record yet, so there’s nothing to pick from. Hit a few more, or check your bag.</p><button class="btn primary" data-go="bag">Your bag</button></div>`;
    bagChart($('#bag-chart-caddie'), null, null);
    return;
  }
  const p = best.profile;
  const thin = p.confidence !== 'solid'
    ? `<p class="warn">Only ${p.goodShots} good ${p.name.toLowerCase()} shots on record. Hit more with it before trusting this pick.</p>` : '';
  const offTarget = best.gap > 20
    ? `<p class="warn">None of your clubs carries close to ${target} yards. ${esc(p.name)} is the closest at ${fmt(p.median)}.</p>` : '';

  el.innerHTML = `
    <p class="club">${esc(p.name)}</p>
    <p class="why"><strong>${pct(best.inside)}</strong> of your ${esc(p.name.toLowerCase())} shots land within ${zone} yards of ${target}. It usually carries ${fmt(p.p25)}–${fmt(p.p75)}.</p>
    <div class="split" aria-hidden="true">
      <span class="s" style="width:${best.short * 100}%"></span><span class="i" style="width:${best.inside * 100}%"></span><span class="l" style="width:${best.long * 100}%"></span>
    </div>
    <div class="split-key"><span>${pct(best.short)} short</span><span>${pct(best.long)} long</span></div>
    ${backup ? `<p class="backup-club">Second choice: <strong>${esc(backup.profile.name)}</strong>, ${pct(backup.inside)} in the zone, ${pct(backup.short)} short, ${pct(backup.long)} long.</p>` : ''}
    ${offTarget}${thin}`;
  bagChart($('#bag-chart-caddie'), target, p.code, flagDrag);
}
function clampTarget(v) {
  if (!Number.isFinite(v)) v = data.settings.target;
  return Math.max(20, Math.min(350, Math.round(v)));
}
function setTarget(v) {
  const t = clampTarget(v);
  $('#target').value = t;
  data.settings.target = t;
  persist();
  renderCaddie();
}

// ---------- Dragging the flag on the Caddie chart ----------
// Mouse: press anywhere along the tracks to move the target there, then drag.
// Touch: grab near the flag, so scrolling past the chart doesn't move the target.
const caddieChart = $('#bag-chart-caddie');
let flagDrag = null; // chart scale { min, max }, held fixed while dragging

function trackBox() {
  const box = caddieChart.querySelector('.chart').getBoundingClientRect();
  return { left: box.left + NAME_W, right: box.right - MEDIAN_W };
}
function moveFlag(clientX) {
  const { left, right } = trackBox(), { min, max } = flagDrag;
  const yards = min + ((clientX - left) / (right - left)) * (max - min);
  const t = clampTarget(Math.max(min, Math.min(max, yards)));
  if (t === +$('#target').value) return;
  $('#target').value = t;
  data.settings.target = t;
  renderCaddie();
}
function endFlagDrag() {
  if (!flagDrag) return;
  flagDrag = null;
  caddieChart.classList.remove('dragging');
  persist();
  renderCaddie(); // back to the chart's normal scale
}
caddieChart.addEventListener('pointerdown', e => {
  if (!profiles.length || e.button !== 0) return;
  const { left, right } = trackBox();
  if (e.pointerType === 'mouse') {
    if (e.clientX < left || e.clientX > right) return; // on a club name or median, not a track
  } else {
    const flag = caddieChart.querySelector('.flagline');
    if (!flag || Math.abs(e.clientX - flag.getBoundingClientRect().left) > 24) return;
  }
  e.preventDefault(); // no text selection while dragging
  flagDrag = { min: +caddieChart.dataset.min, max: +caddieChart.dataset.max };
  caddieChart.setPointerCapture(e.pointerId);
  caddieChart.classList.add('dragging');
  moveFlag(e.clientX);
});
caddieChart.addEventListener('pointermove', e => { if (flagDrag) moveFlag(e.clientX); });
caddieChart.addEventListener('pointerup', endFlagDrag);
caddieChart.addEventListener('pointercancel', endFlagDrag);
caddieChart.addEventListener('lostpointercapture', endFlagDrag);

// ---------- Bag ----------
// The clubs the golfer carries; the rules are in js/bag.js. Clubs taken out keep the shots
// already on record but are left out of club picks, the chart and the gapping warnings, and
// their shots in new files aren't imported.

// Clubs offered in the bag editor, besides any club that has shots.
const STANDARD_CLUBS = ['d', '3w', '4w', '5w', '7w', '9w', '2h', '3h', '4h', '5h', '6h', '7h',
  '2i', '3i', '4i', '5i', '6i', '7i', '8i', '9i', 'pw', 'gw', 'aw', 'sw', 'lw'];
const MAX_CLUBS = 14; // Rules of Golf 4.1b
const CLUB_GROUPS = [['Driver and woods', o => o < 30], ['Hybrids', o => o < 50], ['Irons', o => o < 70], ['Wedges', o => o < 150], ['Other', () => true]];

function toggleClub(code) {
  const adding = !currentBag(data).includes(code);
  setClub(data, code, adding);
  touchSettings(data);
  persist(); refresh(); scheduleSync();
  status(`${clubInfo(code).name} ${adding ? 'added to' : 'taken out of'} your bag.`);
  // Keep keyboard focus on the club just toggled (the editor was redrawn).
  document.querySelector(`#bag-editor [data-club="${CSS.escape(code)}"]`)?.focus();
}

function renderBagEditor() {
  const el = $('#bag-editor');
  if (el.hidden) return;
  const counts = shotCounts(data), bag = currentBag(data);
  const codes = [...new Set([...STANDARD_CLUBS, ...counts.keys(), ...bag])].filter(c => clubInfo(c).order < 200).sort(byOrder);
  const groups = CLUB_GROUPS.map(([title, test]) => [title, codes.filter(c => CLUB_GROUPS.find(([, t]) => t(clubInfo(c).order))[1] === test)]);
  el.innerHTML = `
    <p>Tap a club to add it to your bag or take it out. <strong>${bag.length}</strong> club${bag.length === 1 ? '' : 's'} in your bag; small numbers are shots on record.
    Shots with clubs you take out aren’t imported from new files.</p>
    ${bag.length > MAX_CLUBS ? `<p class="warn">That’s ${bag.length} clubs. The Rules of Golf allow ${MAX_CLUBS} in a round.</p>` : ''}
    ${groups.filter(([, list]) => list.length).map(([title, list]) => `
      <h2>${title}</h2>
      <div class="chips">
        ${list.map(c => `<button class="chip" data-club="${esc(c)}" aria-pressed="${bag.includes(c)}">${esc(shortName({ name: clubInfo(c).name }))}${counts.get(c) ? `<small>${counts.get(c)}</small>` : ''}</button>`).join('')}
      </div>`).join('')}`;
}

function clubCard(p) {
  const conf = p.confidence === 'solid' ? '' : p.confidence === 'thin' ? 'conf-thin' : 'conf-very';
  return `
      <article class="club">
        <div class="club-head"><h2>${esc(p.name)}</h2><span class="big">${fmt(p.median)}<small>yd</small></span></div>
        <dl>
          <dt>Usual carry</dt><dd>${fmt(p.p25)}–${fmt(p.p75)} yd (middle half of shots)</dd>
          ${p.sideSd != null ? `<dt>Left/right</dt><dd>about ±${fmt(p.sideSd)} yd${Math.abs(p.sideMean) >= 3 ? `, leaning ${p.sideMean < 0 ? 'left' : 'right'} ${fmt(Math.abs(p.sideMean))} yd` : ''}</dd>` : ''}
          <dt>Shots</dt><dd class="${conf}">${p.goodShots} full swings${conf ? ` (${p.confidence} data)` : ''}</dd>
          ${p.mishits || p.partials ? `<dt>Left out</dt><dd>${[p.mishits ? `${p.mishits} mishit${p.mishits === 1 ? '' : 's'}` : '', p.partials ? `${p.partials} partial swing${p.partials === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}</dd>` : ''}
          ${Number.isFinite(p.clubSpeed) ? `<dt>Club speed</dt><dd>${fmt(p.clubSpeed)} mph</dd>` : ''}
          <dt>From</dt><dd>${p.sessions.map(s => niceDate(s.date)).join(', ')}</dd>
        </dl>
        ${p.gapWarning ? `<p class="warn">${esc(p.gapWarning)}</p>` : ''}
      </article>`;
}

function renderBag() {
  renderBagEditor();
  bagChart($('#bag-chart'), null, null);
  const bag = currentBag(data);
  const noSwings = bag.filter(c => !profiles.some(p => p.code === c)); // in the bag, nothing on record yet
  const total = profiles.reduce((s, p) => s + p.goodShots, 0);
  $('#bag-lede').textContent = !profiles.length && !noSwings.length
    ? 'No clubs yet. Import sessions to build your bag.'
    : `${bag.length} club${bag.length === 1 ? '' : 's'} in your bag, from ${total} full swings. Carry only, in yards. Mishits and partial swings (chips, pitches) are left out.`;
  $('#club-list').innerHTML = [
    ...profiles.map(p => [p.order, clubCard(p)]),
    ...noSwings.map(c => [clubInfo(c).order, `
      <article class="club no-swings">
        <div class="club-head"><h2>${esc(clubInfo(c).name)}</h2><span class="big">–</span></div>
        <p class="hint">No full swings on record yet.</p>
      </article>`]),
  ].sort((a, b) => a[0] - b[0]).map(x => x[1]).join('');

  const out = allProfiles.filter(p => !p.inBag);
  $('#not-in-bag').innerHTML = !out.length ? '' : `
    <h2>Not in your bag</h2>
    <p class="hint">Their shots on record are kept but left out of club picks, the chart and the gapping warnings. Shots with these clubs in new files aren’t imported.</p>
    <ul>
      ${out.map(p => `
        <li>
          <span><strong>${esc(p.name)}</strong> <span class="hint">${fmt(p.median)} yd, ${p.goodShots} full swing${p.goodShots === 1 ? '' : 's'}</span></span>
          <button class="btn quiet" data-club="${esc(p.code)}">Add back</button>
        </li>`).join('')}
    </ul>`;
}

// ---------- Sessions ----------
function renderSessions() {
  $('#units').value = data.settings.units;
  $('#window').value = data.settings.window;
  $('#window-hint').textContent = data.settings.window === 'recent'
    ? `Uses each club's sessions from the last ${DEFAULTS.recentDays} days, reaching further back until a club has ${DEFAULTS.minShots} good shots.`
    : 'Uses every session you’ve imported.';
  const ul = $('#session-list');
  if (!data.sessions.length) { ul.innerHTML = ''; return; }
  ul.innerHTML = data.sessions.map(s => {
    const clubs = [...new Set(s.shots.map(x => x.clubCode))].sort((a, b) => clubInfo(a).order - clubInfo(b).order).map(c => shortName({ name: clubInfo(c).name })).join(', ');
    return `
      <li class="${s.excluded ? 'off' : ''}">
        <div>
          ${s.date && !s.dateGuessed
            ? `<div class="d">${niceDate(s.date)}</div>`
            : `<label class="field"><span>${s.date ? 'Date played' : 'Session date'}</span><input type="date" data-date="${s.id}" value="${esc(s.date || '')}"></label>`}
          ${s.dateGuessed ? '<div class="meta">This is the day the file was exported. Change it if you played on a different day.</div>' : ''}
          <div class="meta">${s.shots.length} shots${s.label ? `, ${esc(s.label)}` : s.type ? `, ${esc(sessionLabel(s.type))}` : ''}. ${esc(clubs)}</div>
          ${s.excluded ? '<div class="meta">Left out of your club distances</div>' : ''}
        </div>
        <div class="s-actions">
          <button class="btn quiet" data-toggle="${s.id}">${s.excluded ? 'Use again' : 'Leave out'}</button>
          <button class="btn danger" data-del="${s.id}">Delete</button>
        </div>
      </li>`;
  }).join('');
}

// ---------- Sign-in ----------
// A device must sign in once before the app opens (the gate). After that it opens straight
// away, offline too. An expired sign-in only shows a notice on Sessions, so nobody gets locked
// out mid-round. The gate is a front door, not a lock: the app's files are public, and the
// data on the server is what Cloudflare Access and the Worker protect.

function setGated(on) {
  document.body.classList.toggle('gated', on);
  $('#gate').hidden = !on;
}

function renderGate(state) {
  const el = $('#gate-body');
  if (state === 'checking') {
    el.innerHTML = '<p class="hint">Checking your sign-in…</p>';
  } else if (state === 'offline') {
    el.innerHTML = `
      <p>You’re offline. Connect to the internet to sign in the first time. After that, the app works offline.</p>
      <button class="btn" data-recheck>Try again</button>`;
  } else if (state === 'error') {
    el.innerHTML = `
      <p>Couldn’t reach the server. Try again in a minute.</p>
      <button class="btn" data-recheck>Try again</button>`;
  } else {
    el.innerHTML = `
      <p>Sign in with the email address you were invited with. You’ll get a code by email.</p>
      <a class="btn primary" href="${SIGN_IN_URL}">Sign in</a>`;
  }
}

let account = { state: 'checking' }; // the last checkAccount() result
let syncState = { state: 'idle' };  // idle | syncing | ok | error (with message) | other-account

const ago = iso => {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return niceDate(iso.slice(0, 10));
};

function renderAccountBox() {
  const el = $('#account');
  el.hidden = false;
  if (account.state === 'signed-in' && syncState.state === 'other-account') {
    const unsynced = data.sessions.filter(s => s.uploadedAt !== s.modifiedAt).length + data.deleted.length;
    el.innerHTML = `
      <p>Signed in as <strong>${esc(account.email)}</strong>. The sessions on this device belong to another account, so they aren’t synced.
      To sync yours here, remove them from this device${unsynced ? `. <strong>${unsynced} change${unsynced === 1 ? '' : 's'} on this device never reached that account and will be lost.</strong>` : '; they’re safe on the other account'}.</p>
      <div class="acct-actions">
        <button class="btn danger" id="clear-device">Remove from this device</button>
        <button class="btn quiet" id="sign-out">Sign out</button>
      </div>`;
  } else if (account.state === 'signed-in') {
    const line = syncState.state === 'syncing' ? 'Syncing…'
      : syncState.state === 'error' ? esc(syncState.message)
      : data.sync.lastSyncAt ? `Synced ${ago(data.sync.lastSyncAt)}.` : 'Not synced yet.';
    el.innerHTML = `
      <p>Signed in as <strong>${esc(account.email)}</strong>.<br><span class="hint">${line}</span></p>
      <div class="acct-actions">
        <button class="btn quiet" id="sync-now"${syncState.state === 'syncing' ? ' disabled' : ''}>Sync now</button>
        <button class="btn quiet" id="sign-out">Sign out</button>
      </div>`;
  } else if (account.state === 'signed-out') {
    el.innerHTML = `
      <p>Your sign-in has expired. Sign in again to keep your devices in sync.</p>
      <a class="btn" href="${SIGN_IN_URL}">Sign in</a>`;
  } else if (account.state === 'offline') {
    el.innerHTML = `<p class="hint">Signed in as ${esc(storedAccount()?.email || '')}. You’re offline; changes sync when you’re back online.</p>`;
  } else {
    el.innerHTML = '<p class="hint">Couldn’t check your sign-in. Try again later.</p>';
  }
}

async function checkSignIn() {
  const a = await checkAccount();
  account = a;
  if (a.state === 'signed-in') rememberAccount(a);
  if (a.state === 'unavailable') { // no API here, e.g. python http.server: no gate, no account box
    setGated(false);
    $('#account').hidden = true;
    return;
  }
  const known = storedAccount();
  setGated(!known);
  if (known) renderAccountBox();
  else renderGate(a.state);
  if (a.state === 'signed-in') runSync();
}

// ---------- Sync ----------
// One sync at a time; a change during a sync queues another one. See js/sync.js.
let syncRunning = false, syncAgain = false, syncTimer = null;

/** Sync shortly after a change, so several quick changes go up together. */
function scheduleSync(delay = 2000) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}

async function runSync() {
  if (account.state !== 'signed-in') return;
  // An import message still offering "Add … to bag" is withdrawn first: once a session is
  // uploaded, its shots can't change. (Closing it schedules another sync; that's harmless.)
  if (notice?.holdsSync) endNotice();
  if (syncRunning) { syncAgain = true; return; }
  syncRunning = true;
  syncState = { state: 'syncing' };
  renderAccountBox();
  try {
    const r = await syncNow(data, account.userId);
    syncState = { state: r.state };
    if (r.pulled) refresh();
  } catch (err) {
    if (err.state === 'signed-out') {
      account = { state: 'signed-out' };
      syncState = { state: 'idle' };
    } else {
      syncState = {
        state: 'error',
        message: err.state === 'offline' ? 'You’re offline; changes sync when you’re back online.' : `Sync didn’t finish: ${err.message}`,
      };
    }
  } finally {
    persist(); // keep whatever finished, even after an error
    syncRunning = false;
  }
  renderAccountBox();
  if (syncAgain) { syncAgain = false; runSync(); }
}

/** "New club found" question. Resolves true for Yes. It can't be dismissed without an answer. */
function askNewClub({ code, shots, files }) {
  const dlg = $('#new-club');
  $('#new-club-text').textContent =
    `Found ${clubInfo(code).name}: ${shots} shot${shots === 1 ? '' : 's'} in ${files.length === 1 ? files[0] : `${files.length} files`}.`;
  return new Promise(resolve => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
  });
}

async function importFiles(fileList) {
  const restoredSessions = [], fromFiles = [], errors = [];
  let restored = 0, settingsChanged = false;
  for (const f of fileList) {
    const text = await f.text();
    if (/\.json$/i.test(f.name) || text.trim().startsWith('{')) {
      const b = readBackup(text);
      if (!b) { errors.push(`${f.name} isn't a backup from this app.`); continue; }
      restoredSessions.push(...b.sessions); restored++; // a backup is restored as it is
      if (b.settings) { Object.assign(data.settings, b.settings); settingsChanged = true; }
      continue;
    }
    const res = parseSessionFile(text, f.name);
    res.ok ? fromFiles.push(res.session) : errors.push(res.error);
  }

  // Clubs: ask about clubs that are new to the bag, then leave out shots with clubs not in it.
  const stored = new Set(data.sessions.map(s => s.id));
  const fresh = fromFiles.filter(s => !stored.has(s.id));
  const { bagStarted, clubs } = newClubs(data, fresh);
  if (bagStarted) settingsChanged = true;
  for (const club of clubs) {
    setClub(data, club.code, await askNewClub(club));
    settingsChanged = true;
  }
  const fullShots = new Map(fresh.map(s => [s, s.shots])); // kept for "Add … to bag" below
  const skipped = keepBagShots(data, fresh);
  const allSkipped = fresh.filter(s => !s.shots.length).length; // every shot was a club not in the bag
  if (settingsChanged) touchSettings(data);

  const { added, duplicates } = addSessions(data, [...restoredSessions, ...fromFiles.filter(s => s.shots.length)]);
  persist();
  refresh();
  const parts = [];
  if (added) parts.push(`Imported ${added} session${added === 1 ? '' : 's'}`);
  if (duplicates) parts.push(`${duplicates} already imported`);
  if (skipped.size) {
    const n = [...skipped.values()].reduce((a, b) => a + b, 0);
    parts.push(`Left out ${n} shot${n === 1 ? '' : 's'} with clubs not in your bag (${[...skipped.keys()].map(c => clubInfo(c).name).join(', ')})`);
  }
  if (allSkipped) parts.push(`${allSkipped} file${allSkipped === 1 ? ' had' : 's had'} only clubs not in your bag`);
  if (restored && !added) parts.push('Backup had nothing new');
  if (errors.length) parts.push(errors[0]);
  if (data.sessions.some(s => !s.date)) parts.push('Add a date to each session marked “Session date” so it can be used');
  const msg = `${parts.join('. ') || 'Nothing imported'}.`;

  if (!skipped.size) {
    status(msg);
    if (added || settingsChanged) scheduleSync(500);
    return;
  }
  // Offer to take the left-out clubs after all. Sync waits until the message is closed, so the
  // shots can still be added to the sessions before they're uploaded.
  status(msg, {
    actions: [...skipped.keys()].map(code => ({ label: `Add ${clubInfo(code).name} to bag`, run: () => addSkippedClub(code, fullShots) })),
    onClose: () => scheduleSync(500),
    holdsSync: true,
  });
}

/** "Add … to bag" after an import: put the club in the bag and bring in the shots just left out. */
function addSkippedClub(code, fullShots) {
  setClub(data, code, true);
  touchSettings(data);
  let shotsIn = 0;
  for (const [s, full] of fullShots) {
    const stored = data.sessions.find(x => x.id === s.id);
    if (stored && stored !== s) continue; // the file was a duplicate of a stored session
    const before = s.shots.length;
    s.shots = full.filter(x => x.clubCode === code || s.shots.includes(x)); // file order kept
    shotsIn += s.shots.length - before;
    if (!stored && s.shots.length) addSessions(data, [s]); // every shot had been left out
  }
  persist(); refresh();
  status(`Added ${clubInfo(code).name} to your bag and imported its ${shotsIn} shot${shotsIn === 1 ? '' : 's'}.`);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- Navigation ----------
function show(view) {
  for (const v of ['caddie', 'bag', 'sessions']) {
    $(`#view-${v}`).hidden = v !== view;
    const tab = document.querySelector(`.tabs [data-view="${v}"]`);
    if (v === view) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
}

function refresh() {
  recompute();
  renderCaddie();
  renderBag();
  renderSessions();
}

// ---------- Events ----------
document.addEventListener('click', e => {
  const t = e.target.closest('button, [data-go]');
  if (!t) return;
  if (t.dataset.view) show(t.dataset.view);
  else if (t.dataset.go) show(t.dataset.go);
  else if (t.dataset.step) setTarget(+$('#target').value + +t.dataset.step);
  else if (t.dataset.zone) {
    data.settings.zone = Math.max(2, Math.min(20, data.settings.zone + +t.dataset.zone));
    persist(); renderCaddie();
  } else if (t.dataset.toggle) {
    const s = data.sessions.find(x => x.id === t.dataset.toggle);
    if (s) {
      s.excluded = !s.excluded;
      touch(s);
      persist(); refresh(); scheduleSync();
      status(s.excluded ? `Left out the ${niceDate(s.date)} session.` : `Using the ${niceDate(s.date)} session again.`);
    }
  } else if (t.dataset.del) {
    const s = data.sessions.find(x => x.id === t.dataset.del);
    if (s && t.dataset.confirm === '1') {
      deleteSession(data, s.id);
      persist(); refresh(); scheduleSync();
      status(`Deleted the ${niceDate(s.date)} session.`);
    } else if (s) {
      t.dataset.confirm = '1'; t.textContent = 'Tap to delete';
      setTimeout(() => { if (t.isConnected) { t.dataset.confirm = ''; t.textContent = 'Delete'; } }, 4000);
    }
  } else if (t.dataset.club) {
    toggleClub(t.dataset.club);
  } else if (t.id === 'bag-edit') {
    const ed = $('#bag-editor');
    ed.hidden = !ed.hidden;
    t.textContent = ed.hidden ? 'Edit bag' : 'Done';
    t.setAttribute('aria-expanded', String(!ed.hidden));
    renderBagEditor();
  } else if ('recheck' in t.dataset) {
    renderGate('checking');
    checkSignIn();
  } else if (t.id === 'sync-now') {
    runSync();
  } else if (t.id === 'clear-device') {
    if (t.dataset.confirm === '1') {
      clearDevice(data);
      persist(); refresh(); runSync();
      status('Removed the other account’s sessions from this device.');
    } else {
      t.dataset.confirm = '1'; t.textContent = 'Tap to remove';
      setTimeout(() => { if (t.isConnected) { t.dataset.confirm = ''; t.textContent = 'Remove from this device'; } }, 4000);
    }
  } else if (t.id === 'sign-out') {
    t.disabled = true;
    syncState = { state: 'idle' };
    signOut().then(() => { forgetAccount(); return checkSignIn(); }).then(() => status('Signed out.'));
  } else if (t.id === 'backup') {
    download(backupBlob(data), `nwc-golf-backup-${new Date().toISOString().slice(0, 10)}.json`);
    status('Backup downloaded.');
  }
});
$('#new-club').addEventListener('cancel', e => e.preventDefault()); // Esc: an answer is needed
$('#target').addEventListener('change', e => setTarget(+e.target.value));
$('#target').addEventListener('focus', e => e.target.select());
$('#file').addEventListener('change', async e => { await importFiles([...e.target.files]); e.target.value = ''; });
$('#units').addEventListener('change', e => { data.settings.units = e.target.value; touchSettings(data); persist(); refresh(); scheduleSync(); });
$('#window').addEventListener('change', e => { data.settings.window = e.target.value; touchSettings(data); persist(); refresh(); scheduleSync(); });
$('#session-list').addEventListener('change', e => {
  const id = e.target.dataset.date;
  if (!id || !e.target.value) return;
  const s = data.sessions.find(x => x.id === id);
  if (s) {
    s.date = e.target.value;
    delete s.dateGuessed;
    touch(s);
    sortSessions(data);
    persist(); refresh(); scheduleSync();
  }
});

// ---------- Start ----------
$('#target').value = data.settings.target;
refresh();
requestPersistence();
// Decide from what's stored right away, so a signed-in device never flashes the gate.
if (!storedAccount()) { setGated(true); renderGate('checking'); }
checkSignIn();
window.addEventListener('online', checkSignIn);
// Phones keep the app open in the background for days: sync when it comes back to the front.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || account.state !== 'signed-in') return;
  const last = data.sync.lastSyncAt ? Date.now() - new Date(data.sync.lastSyncAt) : Infinity;
  if (last > 5 * 60 * 1000) runSync();
});
if (new URLSearchParams(location.search).has('signed-in')) {
  // Back from the Access sign-in page (see /api/login in worker/index.js).
  history.replaceState(null, '', location.pathname);
  show('sessions');
  status('Signed in.');
}
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
