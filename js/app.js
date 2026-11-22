import { parseSessionFile, clubInfo, sessionLabel } from './parse.js';
import { buildProfiles, pickClub, DEFAULTS } from './stats.js';
import { load, save, addSessions, backupBlob, readBackup, requestPersistence } from './store.js';
import { checkAccount, signOut, SIGN_IN_URL } from './account.js';

const $ = sel => document.querySelector(sel);
const data = load();
let profiles = [];

const fmt = n => Math.round(n).toString();
const pct = n => `${Math.round(n * 100)}%`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const niceDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'No date';

function status(msg) {
  const el = $('#status');
  el.textContent = msg;
  clearTimeout(status.t);
  status.t = setTimeout(() => { el.textContent = ''; }, 6000);
}

function persist() {
  if (!save(data)) status('Couldn’t save. Free up space on this phone, then import again.');
}

function recompute() {
  const usable = data.sessions.filter(s => s.date);
  profiles = buildProfiles(usable, { window: data.settings.window, units: data.settings.units });
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

  if (!profiles.length) {
    el.innerHTML = `<div class="empty"><p>Import a few sessions to get club picks from your own shots.</p><button class="btn primary" data-go="sessions">Import sessions</button></div>`;
    bagChart($('#bag-chart-caddie'), null, null);
    return;
  }
  const { best, backup } = pickClub(profiles, target, zone);
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
function renderBag() {
  bagChart($('#bag-chart'), null, null);
  const list = $('#club-list');
  if (!profiles.length) {
    $('#bag-lede').textContent = 'No clubs yet. Import sessions to build your bag.';
    list.innerHTML = '';
    return;
  }
  const total = profiles.reduce((s, p) => s + p.goodShots, 0);
  $('#bag-lede').textContent = `${profiles.length} clubs from ${total} full swings. Carry only, in yards. Mishits and partial swings (chips, pitches) are left out.`;
  list.innerHTML = profiles.map(p => {
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
  }).join('');
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

// ---------- Account (sign-in for sync) ----------
async function renderAccount() {
  const el = $('#account');
  const a = await checkAccount();
  if (a.state === 'unavailable') { el.hidden = true; return; } // no API here, e.g. python http.server
  el.hidden = false;
  if (a.state === 'signed-in') {
    el.innerHTML = `
      <p>Signed in as <strong>${esc(a.email)}</strong>. Syncing sessions between your devices is coming next.</p>
      <button class="btn quiet" id="sign-out">Sign out</button>`;
  } else if (a.state === 'signed-out') {
    el.innerHTML = `
      <p>Testers: sign in to keep your sessions on all your devices.</p>
      <a class="btn" href="${SIGN_IN_URL}">Sign in</a>`;
  } else if (a.state === 'offline') {
    el.innerHTML = '<p class="hint">You’re offline. Your sign-in shows here when you’re back online.</p>';
  } else {
    el.innerHTML = '<p class="hint">Couldn’t check your sign-in. Try again later.</p>';
  }
}

async function importFiles(fileList) {
  const sessions = [], errors = [];
  let restored = 0;
  for (const f of fileList) {
    const text = await f.text();
    if (/\.json$/i.test(f.name) || text.trim().startsWith('{')) {
      const b = readBackup(text);
      if (!b) { errors.push(`${f.name} isn't a backup from this app.`); continue; }
      sessions.push(...b.sessions); restored++;
      if (b.settings) Object.assign(data.settings, b.settings);
      continue;
    }
    const res = parseSessionFile(text, f.name);
    res.ok ? sessions.push(res.session) : errors.push(res.error);
  }
  const { added, duplicates } = addSessions(data, sessions);
  persist();
  refresh();
  const parts = [];
  if (added) parts.push(`Imported ${added} session${added === 1 ? '' : 's'}`);
  if (duplicates) parts.push(`${duplicates} already imported`);
  if (restored && !added) parts.push('Backup had nothing new');
  if (errors.length) parts.push(errors[0]);
  status(parts.join('. ') || 'Nothing imported.');
  if (data.sessions.some(s => !s.date)) status('Add a date to each session marked “Session date” so it can be used.');
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
      persist(); refresh();
      status(s.excluded ? `Left out the ${niceDate(s.date)} session.` : `Using the ${niceDate(s.date)} session again.`);
    }
  } else if (t.dataset.del) {
    const s = data.sessions.find(x => x.id === t.dataset.del);
    if (s && t.dataset.confirm === '1') {
      data.sessions = data.sessions.filter(x => x.id !== s.id);
      persist(); refresh(); status(`Deleted the ${niceDate(s.date)} session.`);
    } else if (s) {
      t.dataset.confirm = '1'; t.textContent = 'Tap to delete';
      setTimeout(() => { if (t.isConnected) { t.dataset.confirm = ''; t.textContent = 'Delete'; } }, 4000);
    }
  } else if (t.id === 'sign-out') {
    t.disabled = true;
    signOut().then(renderAccount).then(() => status('Signed out.'));
  } else if (t.id === 'backup') {
    download(backupBlob(data), `nwc-golf-backup-${new Date().toISOString().slice(0, 10)}.json`);
    status('Backup downloaded.');
  }
});
$('#target').addEventListener('change', e => setTarget(+e.target.value));
$('#target').addEventListener('focus', e => e.target.select());
$('#file').addEventListener('change', async e => { await importFiles([...e.target.files]); e.target.value = ''; });
$('#units').addEventListener('change', e => { data.settings.units = e.target.value; persist(); refresh(); });
$('#window').addEventListener('change', e => { data.settings.window = e.target.value; persist(); refresh(); });
$('#session-list').addEventListener('change', e => {
  const id = e.target.dataset.date;
  if (!id || !e.target.value) return;
  const s = data.sessions.find(x => x.id === id);
  if (s) { s.date = e.target.value; delete s.dateGuessed; data.sessions.sort((a, b) => (b.date || '').localeCompare(a.date || '')); persist(); refresh(); }
});

// ---------- Start ----------
$('#target').value = data.settings.target;
refresh();
requestPersistence();
renderAccount();
window.addEventListener('online', renderAccount);
if (new URLSearchParams(location.search).has('signed-in')) {
  // Back from the Access sign-in page (see /api/login in worker/index.js).
  history.replaceState(null, '', location.pathname);
  show('sessions');
  status('Signed in.');
}
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
