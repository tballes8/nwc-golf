// Run: node tests/run.mjs path/to/session-*.csv path/to/shot_data_export_*.csv
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import assert from 'node:assert/strict';
import { parseCSV, parseSessionFile, infoFromFilename, clubInfo, e6ClubCode } from '../js/parse.js';
import { buildProfiles, pickClub } from '../js/stats.js';

// E6 filenames are UTC export times; check the local-date conversion in Pacific time.
process.env.TZ = 'America/Los_Angeles';

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

// E6 Connect
const E6_NAME = 'shot_data_export_2026-11-20T00_49_06.772054Z.csv';
assert.deepEqual(infoFromFilename(E6_NAME), { date: '2026-11-19', type: null, exported: true }); // 00:49 UTC = Nov 19, 4:49 PM Pacific
assert.equal(e6ClubCode('Driver'), 'd');
assert.equal(e6ClubCode('3 Wood'), '3w');
assert.equal(e6ClubCode('4 Hybrid'), '4h');
assert.equal(e6ClubCode('7 Iron'), '7i');
assert.equal(e6ClubCode('Gap Wedge'), 'aw'); // same club as Rapsodo AW
assert.equal(e6ClubCode('Sand Wedge'), 'lw'); // same club as Rapsodo LW
assert.equal(e6ClubCode('Pitching Wedge'), 'pw');

const E6_HEAD = 'course,hole,shot,club type,head speed (mph),total distance (yds),carry distance (yds),apex height (ft),ball speed (mph),back spin,side spin,launch dir,launch angle';
const e6 = parseSessionFile('﻿' + [
  E6_HEAD,
  'Test Course,1,1,Driver,80,200,180,40,120,2400,300,-1.5,12',
  'Test Course,1,2,Gap Wedge,60,95,90,60,75,8000,0,1,28',
  'Test Course,1,3,5 Iron,75,76,,,99,2700,-38,4,3.5', // no carry: skipped
  'Test Course,2,4,Sand Wedge,55,80,75,55,66,9000,200,0,32',
].join('\n'), E6_NAME);
assert.ok(e6.ok, e6.error);
const s6 = e6.session;
assert.equal(s6.source, 'e6-connect');
assert.equal(s6.date, '2026-11-19');
assert.equal(s6.dateGuessed, true);
assert.equal(s6.label, 'Test Course');
assert.equal(s6.units, 'yd');
assert.deepEqual(s6.shots.map(x => x.clubCode), ['d', 'aw', 'lw']);
assert.equal(s6.shots[0].smash, 1.5);
assert.equal(s6.shots[0].side, null);
assert.equal(s6.shots[0].spin, 2419); // sqrt(2400² + 300²)
assert.deepEqual([s6.shots[0].hole, s6.shots[0].shotNo], [1, 1]);

// Metric E6 headers are converted to yards, mph and feet at import.
const e6m = parseSessionFile(
  'course,hole,shot,club type,head speed (km/h),carry distance (m),apex height (m),ball speed (km/h)\nX,1,1,7 Iron,120,100,10,150',
  E6_NAME,
).session.shots[0];
assert.deepEqual([e6m.carry, e6m.clubSpeed, e6m.apex, e6m.ballSpeed], [109.36, 74.56, 32.81, 93.21]);
assert.equal(parseSessionFile('course,club type,carry distance (furlongs)\nX,Driver,1', E6_NAME).ok, false);

// The Rapsodo units setting doesn't touch E6 sessions; clubs without side data show no left/right.
const drives = { ...s6, shots: [180, 182, 178, 185, 175].map(carry => ({ ...s6.shots[0], carry })) };
const [dr] = buildProfiles([drives], { units: 'm' });
assert.equal(dr.median, 180);
assert.equal(dr.sideSd, null);

const files = process.argv.slice(2);
if (!files.length) { console.log('Unit checks passed. Pass CSV files to test real data.'); process.exit(0); }

const sessions = [];
for (const f of files) {
  const res = parseSessionFile(readFileSync(f, 'utf8'), basename(f));
  assert.ok(res.ok, res.error);
  assert.ok(res.session.date, 'date from filename');
  sessions.push(res.session);
  console.log(`${res.session.date} ${res.session.label || res.session.type}: ${res.session.shots.length} shots, id ${res.session.id}`);
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
