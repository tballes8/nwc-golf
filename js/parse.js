// Parsing launch monitor exports into one internal shot format.
// v1 supports Rapsodo MLM2PRO session CSVs exported from R-Cloud.

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

export function detectFormat(header) {
  const h = header.map(s => s.trim());
  if (h.includes('Club Type') && h.includes('Carry Distance') && h.includes('Club Data Est Type')) return 'rapsodo-mlm2pro';
  return null;
}

/** Date and session type from a filename like "session-range-2026-10-12.csv". */
export function infoFromFilename(name = '') {
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
  const rows = parseCSV(text);
  if (rows.length < 2) return { ok: false, error: `${fileName || 'File'} has no shots in it.` };
  const header = rows[0].map(s => s.trim());
  const format = detectFormat(header);
  if (!format) return { ok: false, error: `${fileName || 'File'} isn't a Rapsodo session export. Export a session as CSV from R-Cloud and try again.` };

  const idx = {};
  header.forEach((name, i) => { if (RAPSODO_COLUMNS[name]) idx[RAPSODO_COLUMNS[name]] = i; });

  const shots = [];
  for (const r of rows.slice(1)) {
    const shot = {};
    for (const [key, i] of Object.entries(idx)) {
      const raw = (r[i] ?? '').trim();
      if (TEXT_FIELDS.has(key)) shot[key] = raw;
      else { const n = parseFloat(raw); shot[key] = Number.isFinite(n) ? n : null; }
    }
    if (!shot.clubCode || shot.carry == null) continue;
    shot.clubCode = shot.clubCode.toLowerCase();
    shots.push(shot);
  }
  if (!shots.length) return { ok: false, error: `${fileName || 'File'} has no shots with a club and carry distance.` };

  const { date, type } = infoFromFilename(fileName);
  return {
    ok: true,
    session: {
      id: fingerprint(shots),
      userId: 'local', // replaced by the account ID once logins exist
      source: format,
      fileName,
      date,            // may be null; the app asks for it
      type,
      importedAt: new Date().toISOString(),
      shots,
    },
  };
}

// ---- Clubs ---------------------------------------------------------------

const WEDGES = { pw: ['Pitching wedge', 46], gw: ['Gap wedge', 50], aw: ['Approach wedge', 50], sw: ['Sand wedge', 56], lw: ['Lob wedge', 60] };

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
