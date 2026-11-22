// Run: node tests/run.mjs path/to/session-*.csv
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import assert from 'node:assert/strict';
import { parseCSV, parseSessionFile, infoFromFilename, clubInfo } from '../js/parse.js';
import { buildProfiles, pickClub } from '../js/stats.js';

// Unit checks
assert.deepEqual(parseCSV('﻿"a","b"\r\n"1,5","x""y"\r\n\r\n'), [['a', 'b'], ['1,5', 'x"y']]);
assert.deepEqual(infoFromFilename('aa346f13-session-range-2026-10-12.csv'), { date: '2026-10-12', type: 'range' });
assert.deepEqual(infoFromFilename('41d8ebf5-session-studios-courses-2026-11-12.csv'), { date: '2026-11-12', type: 'studios-courses' });
assert.equal(clubInfo('d').name, 'Driver');
assert.equal(clubInfo('4h').name, '4 hybrid');
assert.equal(clubInfo('aw').name, 'Approach wedge');
assert.equal(clubInfo('5w').name, '5 wood');
assert.equal(clubInfo('pw').name, 'Pitching wedge');
assert.ok(clubInfo('3w').order < clubInfo('5w').order && clubInfo('5w').order < clubInfo('4i').order);
assert.equal(parseSessionFile('x,y\n1,2', 'bad.csv').ok, false);

const files = process.argv.slice(2);
if (!files.length) { console.log('Unit checks passed. Pass CSV files to test real data.'); process.exit(0); }

const sessions = [];
for (const f of files) {
  const res = parseSessionFile(readFileSync(f, 'utf8'), basename(f));
  assert.ok(res.ok, res.error);
  assert.ok(res.session.date, 'date from filename');
  sessions.push(res.session);
  console.log(`${res.session.date} ${res.session.type}: ${res.session.shots.length} shots, id ${res.session.id}`);
}
// Same file twice gives the same id (dedupe)
const again = parseSessionFile(readFileSync(files[0], 'utf8'), basename(files[0]));
assert.equal(again.session.id, sessions[0].id);

for (const window of ['recent', 'all']) {
  console.log(`\nProfiles (${window})`);
  for (const p of buildProfiles(sessions, { window })) {
    console.log(`${p.name.padEnd(14)} median ${p.median.toFixed(0)}  mid-half ${p.p25.toFixed(0)}-${p.p75.toFixed(0)}  good ${p.goodShots}/${p.shots} (partial ${p.partials}, mishit ${p.mishits})  ${p.confidence}  sessions ${p.sessions.map(s => s.date).join(',')}${p.gapWarning ? '  ⚠ ' + p.gapWarning : ''}`);
  }
}
const profiles = buildProfiles(sessions);
for (const t of [105, 130, 150]) {
  const { best, backup } = pickClub(profiles, t, 8);
  const r = [best, backup].filter(Boolean);
  console.log(`\n${t} yd: ` + r.map(x => `${x.profile.name} ${(x.inside * 100).toFixed(0)}% in, ${(x.short * 100).toFixed(0)}% short, ${(x.long * 100).toFixed(0)}% long`).join(' | '));
  for (const x of r) assert.ok(Math.abs(x.inside + x.short + x.long - 1) < 1e-9);
}
console.log('\nAll checks passed.');
