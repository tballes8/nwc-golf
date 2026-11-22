// Parsing shot data exports into one internal shot format.
// Supports Rapsodo MLM2PRO session CSVs exported from R-Cloud and E6 Connect shot data exports.
// Internal units: yards, mph, feet. Rapsodo files have no unit labels, so their sessions
// follow the "Distances in Rapsodo files" setting; E6 files label units and are converted here.

/** Minimal RFC 4180 CSV parser: quotes, escaped quotes, CRLF, BOM. */
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  return rows;
}

const RAPSODO_COLUMNS = {
  'Club Type': 'clubCode',
  'Club Brand': 'brand',
  'Club Model': 'model',
  'Carry Distance': 'carry',
  'Total Distance': 'total',
  'Ball Speed': 'ballSpeed',
  'Launch Angle': 'launchAngle',
  'Launch Direction': 'launchDir',
  'Apex': 'apex',
  'Side Carry': 'side',
  'Club Speed': 'clubSpeed',
  'Smash Factor': 'smash',
  'Descent Angle': 'descent',
  'Attack Angle': 'attack',
  'Club Path': 'path',
  'Club Data Est Type': 'estType',
  'Spin Rate': 'spin',
  'Spin Axis': 'spinAxis',
  'Shot #': 'shotNo',
};
const TEXT_FIELDS = new Set(['clubCode', 'brand', 'model', 'estType']);

// E6 headers are lowercase with the unit in brackets: "carry distance (yds)".
const E6_COLUMNS = {
  'hole': 'hole',
  'shot': 'shotNo',
  'club type': 'clubName',
  'head speed': 'clubSpeed',
  'total distance': 'total',
  'carry distance': 'carry',
  'apex height': 'apex',
  'ball speed': 'ballSpeed',
  'back spin': 'backSpin',
  'side spin': 'sideSpin',
  'launch dir': 'launchDir',
  'launch angle': 'launchAngle',
};
const TO_YD = { yds: 1, yd: 1, yards: 1, m: 1.09361 };
const TO_MPH = { mph: 1, 'km/h': 0.621371, kph: 0.621371, 'm/s': 2.23694 };
const TO_FT = { ft: 1, feet: 1, m: 3.28084 };
const E6_UNITS = { carry: TO_YD, total: TO_YD, clubSpeed: TO_MPH, ballSpeed: TO_MPH, apex: TO_FT };

export function detectFormat(header) {
  const h = header.map(s => s.trim());
  if (h.includes('Club Type') && h.includes('Carry Distance') && h.includes('Club Data Est Type')) return 'rapsodo-mlm2pro';
  const lower = h.map(s => s.toLowerCase());
  if (lower.includes('club type') && lower.some(s => s.startsWith('carry distance ('))) return 'e6-connect';
  return null;
}

const pad = n => String(n).padStart(2, '0');
const localDate = t => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;

/**
 * Date and session type from a filename.
 * Rapsodo: "session-range-2026-10-12.csv" is the session date.
 * E6: "shot_data_export_2026-11-20T00_49_06.772054Z.csv" is the export time in UTC,
 * so it becomes the local date and is marked exported (the golfer may need to correct it).
 */
export function infoFromFilename(name = '') {
  const e6 = name.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})_(\d{2})_(\d{2})(?:\.\d+)?Z/);
  if (e6) {
    const [y, mo, d, h, mi, s] = e6.slice(1).map(Number);
    return { date: localDate(new Date(Date.UTC(y, mo - 1, d, h, mi, s))), type: null, exported: true };
  }
  const date = (name.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  const type = (name.match(/session-([a-z-]+?)-\d{4}-\d{2}-\d{2}/i) || [])[1] || null;
  return { date, type: type ? type.toLowerCase() : null };
}

/** Plain-language name for a Rapsodo session type. */
export function sessionLabel(type) {
  if (!type) return '';
  if (type.includes('course')) return 'sim round';
  return type.replace(/-/g, ' ');
}

/** Stable fingerprint so the same session imported twice is caught. */
export function fingerprint(shots) {
  let h = 2166136261;
  const s = shots.map(x => `${x.clubCode}|${x.carry}|${x.ballSpeed}|${x.side}`).join(';');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

/**
 * Parse one exported file into a session.
 * Returns { ok:true, session } or { ok:false, error }.
 */
export function parseSessionFile(text, fileName = '') {
  const file = fileName || 'File';
  const rows = parseCSV(text);
  if (rows.length < 2) return { ok: false, error: `${file} has no shots in it.` };
  const header = rows[0].map(s => s.trim());
  const format = detectFormat(header);
  if (!format) return { ok: false, error: `${file} isn't a shot export this app knows. Use a session CSV from Rapsodo R-Cloud or a shot data export from E6 Connect.` };

  const parsed = format === 'e6-connect' ? parseE6(rows, header, file) : parseRapsodo(rows, header);
  if (parsed.error) return { ok: false, error: parsed.error };
  const { shots, label = null, units } = parsed;
  if (!shots.length) return { ok: false, error: `${file} has no shots with a club and carry distance.` };

  const { date, type, exported } = infoFromFilename(fileName);
  const session = {
    id: fingerprint(shots),
    userId: 'local', // replaced by the account ID once logins exist
    source: format,
    fileName,
    date,            // may be null; the app asks for it
    type,
    label,           // E6: the course name
    importedAt: new Date().toISOString(),
    shots,
  };
  if (units) session.units = units;     // set when the file states its units; otherwise the setting applies
  if (exported) session.dateGuessed = true; // date is the export day; the app lets the golfer correct it
  return { ok: true, session };
}

const num = raw => { const n = parseFloat(raw); return Number.isFinite(n) ? n : null; };

function parseRapsodo(rows, header) {
  const idx = {};
  header.forEach((name, i) => { if (RAPSODO_COLUMNS[name]) idx[RAPSODO_COLUMNS[name]] = i; });

  const shots = [];
  for (const r of rows.slice(1)) {
    const shot = {};
    for (const [key, i] of Object.entries(idx)) {
      const raw = (r[i] ?? '').trim();
      shot[key] = TEXT_FIELDS.has(key) ? raw : num(raw);
    }
    if (!shot.clubCode || shot.carry == null) continue;
    shot.clubCode = shot.clubCode.toLowerCase();
    shots.push(shot);
  }
  return { shots };
}

function parseE6(rows, header, file) {
  const cols = []; // [key, index, unit factor]
  let courseIdx = -1;
  for (const [i, name] of header.entries()) {
    const m = name.toLowerCase().match(/^(.*?)\s*(?:\(([^)]*)\))?$/);
    const base = m[1].trim(), unit = (m[2] || '').trim();
    if (base === 'course') { courseIdx = i; continue; }
    const key = E6_COLUMNS[base];
    if (!key) continue;
    let factor = 1;
    if (E6_UNITS[key]) {
      factor = E6_UNITS[key][unit];
      if (!factor) return { error: `${file}: the column "${name}" uses a unit this app doesn't know.` };
    }
    cols.push([key, i, factor]);
  }

  const shots = [], courses = new Set();
  for (const r of rows.slice(1)) {
    const shot = {};
    for (const [key, i, factor] of cols) {
      const raw = (r[i] ?? '').trim();
      if (key === 'clubName') { shot.clubName = raw; continue; }
      const n = num(raw);
      shot[key] = n == null || factor === 1 ? n : Math.round(n * factor * 100) / 100;
    }
    if (!shot.clubName || shot.carry == null) continue; // e.g. a shot with no carry reading
    shot.clubCode = e6ClubCode(shot.clubName);
    // E6 gives no smash factor or side carry. Smash is computed from the speeds; E6's head
    // speed looks rounded or estimated (exact repeats), so treat it as rougher than Rapsodo's.
    shot.smash = shot.ballSpeed > 0 && shot.clubSpeed > 0 ? Math.round((shot.ballSpeed / shot.clubSpeed) * 100) / 100 : null;
    shot.side = null;
    shot.spin = shot.backSpin != null ? Math.round(Math.hypot(shot.backSpin, shot.sideSpin ?? 0)) : null;
    const course = courseIdx >= 0 ? (r[courseIdx] ?? '').trim() : '';
    if (course) courses.add(course);
    shots.push(shot);
  }
  return { shots, label: [...courses].join(' / ') || null, units: 'yd' };
}

// ---- Clubs ---------------------------------------------------------------

const WEDGES = { pw: ['Pitching wedge', 46], gw: ['Gap wedge', 50], aw: ['Approach wedge', 50], sw: ['Sand wedge', 56], lw: ['Lob wedge', 60] };

// E6 wedge names -> club codes, matched to this bag so E6 and Rapsodo shots with the same
// club combine: the wedge E6 calls Gap Wedge is the one set up as AW in Rapsodo, and
// E6's Sand Wedge is Rapsodo's LW. Lob Wedge is left unmapped on purpose (see e6ClubCode).
const E6_WEDGES = { 'pitching wedge': 'pw', 'approach wedge': 'aw', 'gap wedge': 'aw', 'sand wedge': 'lw' };

/** Club code for an E6 club name: "Driver" -> d, "3 Wood" -> 3w, "4 Hybrid" -> 4h, "7 Iron" -> 7i. */
export function e6ClubCode(name) {
  const c = String(name).toLowerCase().replace(/\s+/g, ' ').trim();
  if (c === 'driver') return 'd';
  let m;
  if ((m = c.match(/^(\d+) wood$/))) return `${m[1]}w`;
  if ((m = c.match(/^(\d+) hybrid$/))) return `${m[1]}h`;
  if ((m = c.match(/^(\d+) iron$/))) return `${m[1]}i`;
  if (E6_WEDGES[c]) return E6_WEDGES[c];
  if (c === 'putter') return 'p';
  return c; // unknown name: kept as written so it shows up as its own club and can be mapped
}

/** Display name and sort order (longest club first) for a Rapsodo club code. */
export function clubInfo(code) {
  const c = String(code).toLowerCase().trim();
  if (c === 'd' || c === 'dr' || c === 'driver') return { name: 'Driver', order: 0 };
  let m;
  if ((m = c.match(/^(\d+)w$/))) return { name: `${m[1]} wood`, order: 10 + +m[1] };
  if ((m = c.match(/^(\d+)(h|hy)$/))) return { name: `${m[1]} hybrid`, order: 30 + +m[1] };
  if ((m = c.match(/^(\d+)i$/))) return { name: `${m[1]} iron`, order: 50 + +m[1] };
  if (WEDGES[c]) return { name: WEDGES[c][0], order: 70 + WEDGES[c][1] };
  if ((m = c.match(/^(\d{2})(°|deg)?$/))) return { name: `${m[1]}° wedge`, order: 70 + +m[1] };
  if (c === 'p' || c === 'putter') return { name: 'Putter', order: 200 };
  return { name: code.toUpperCase(), order: 150 };
}
