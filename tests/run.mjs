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

// The bag: clubs taken out keep a profile but aren't picked and don't trigger gapping warnings.
const bagShots = [['5h', 150], ['4i', 155], ['5i', 145], ['6i', 135], ['7i', 125]]
  .flatMap(([clubCode, c]) => [0, 2, -2, 1, -1].map(d => ({ clubCode, carry: c + d, clubSpeed: 80, smash: 1.4 })));
const bagSession = [{ id: 'b', date: '2026-11-01', shots: bagShots }];
const everything = buildProfiles(bagSession);
assert.ok(everything.every(p => p.inBag), 'no bag set: every club is in the bag');
assert.ok(everything.find(p => p.code === '5h').gapWarning, '5h carries less than the 4i, so it is flagged');
const myBag = buildProfiles(bagSession, { bag: ['5h', '5i', '6i', '7i'] });
assert.equal(myBag.length, 5, 'clubs out of the bag still get a profile');
assert.equal(myBag.find(p => p.code === '4i').inBag, false);
assert.equal(myBag.find(p => p.code === '5h').gapWarning, undefined, 'no warning against a club not in the bag');
assert.equal(pickClub(everything, 155, 4).best.profile.code, '4i');
assert.notEqual(pickClub(myBag, 155, 4).best.profile.code, '4i', 'a club not in the bag is never picked');

// Mishit rule (e6-import-spec.md): the 4 hybrid from the Oslo round. Carries 17, 36, 66, 76 were
// topped (smash ~1.43 but low carry for the ball speed, apex 0.1-4.3 ft). The old rule kept 66 and
// 76 because the topped shots dragged the median down to 76.
{
  const h = (carry, ballSpeed, apex) => ({ clubCode: '4h', carry, ballSpeed, apex, clubSpeed: 82, smash: 1.43 });
  const oslo = [h(17, 109, 0.1), h(36, 120, 0.2), h(66, 107, 4.3), h(76, 118, 2.1), h(116, 117, 30), h(119, 109, 33), h(144, 118, 40)];
  const [p] = buildProfiles([{ id: 'oslo', date: '2026-11-19', units: 'yd', shots: oslo }]);
  assert.deepEqual(p.carries.map(Math.round), [116, 119, 144], 'all four topped shots are mishits');
  assert.equal(p.mishits, 4);

  // Each new sign on its own, on an otherwise normal 7 iron.
  const i7 = (over = {}) => ({ clubCode: '7i', carry: 130, ballSpeed: 100, apex: 70, clubSpeed: 75, smash: 1.33, ...over });
  const base = [130, 132, 128, 131, 129].map(carry => i7({ carry }));
  const one = (over, sessionUnits = 'yd') => buildProfiles([{ id: 'x', date: '2026-11-01', units: sessionUnits, shots: [...base, i7(over)] }])[0].mishits;
  assert.equal(one({ carry: 110, ballSpeed: 130 }), 1, 'carry under 0.9 yd per mph of ball speed');
  assert.equal(one({ carry: 120, apex: 8 }), 1, 'apex under 10 ft');
  assert.equal(one({ carry: 120 }), 0, 'a normal shot');
  assert.equal(one({ carry: 120, ballSpeed: 140, apex: 8 }, 'm'), 0, 'metric Rapsodo: ball speed and apex checks skipped');
  assert.equal(one({ carry: 120, smash: 0.9 }, 'm'), 1, '...but smash still applies');
}

// Recent shots for a club: newest first, labelled by the same rules as the club's numbers.
{
  const { recentShots } = await import('../js/stats.js');
  const shot = (carry, extra = {}) => ({ clubCode: '6i', carry, clubSpeed: 75, ballSpeed: 100, smash: 1.33, ...extra });
  const older = { id: 'o', date: '2026-11-10', importedAt: '2026-11-10T10:00:00.000Z', shots: [140, 142, 141, 139, 143, 140].map(c => shot(c)) };
  const today = {
    id: 't', date: '2026-11-22', importedAt: '2026-11-22T10:00:00.000Z',
    shots: [shot(141), shot(60, { smash: 0.8 }), shot(40, { clubSpeed: 50 }), { clubCode: '7i', carry: 130 }, shot(138)],
  };
  const skippedSession = { id: 'x', date: '2026-11-23', excluded: true, shots: [shot(999)] };
  const r = recentShots([older, today, skippedSession], '6i', { limit: 6 });
  assert.deepEqual(r.shots.map(s => [s.date, Math.round(s.carry), s.label]), [
    ['2026-11-22', 138, 'good'],
    ['2026-11-22', 40, 'partial'], // club speed far below this club's usual
    ['2026-11-22', 60, 'mishit'],  // smash under 1.0
    ['2026-11-22', 141, 'good'],
    ['2026-11-10', 140, 'good'],
    ['2026-11-10', 143, 'good'],
  ], 'newest first: latest date, then the last shot of the session; left-out sessions skipped');
  assert.deepEqual(r.counts, { good: 4, mishit: 1, partial: 1 });
  assert.equal(r.goodMedian, 140.5);
  const metric = recentShots([{ ...older, shots: [shot(100)] }], '6i', { units: 'm' });
  assert.equal(Math.round(metric.shots[0].carry), 109, 'Rapsodo meters are converted');
  assert.deepEqual(recentShots([older], 'lw').shots, []);

  // Strike comparison for the Caddie screen.
  const { strikeComparison } = await import('../js/stats.js');
  const form = (good, mishit, partial = 0) => ({ counts: { good, mishit, partial } });
  assert.deepEqual(strikeComparison(form(6, 4), form(9, 1)), { mishits: 4, swings: 10, altGood: 9, altSwings: 10 }, '3 wood 6/10 vs 4 hybrid 9/10');
  assert.equal(strikeComparison(form(7, 3), form(9, 1)), null, '70% vs 90%: not a clear enough difference');
  assert.deepEqual(strikeComparison(form(4, 3, 3), form(5, 0, 5)), { mishits: 3, swings: 7, altGood: 5, altSwings: 5 }, 'partials left out of both');
  assert.equal(strikeComparison(form(8, 2), form(10, 0)), null, 'only 2 mishits');
  assert.equal(strikeComparison(form(2, 3), form(4, 0)), null, 'too few swings with the other club');
  assert.equal(strikeComparison(form(5, 5), form(6, 4)), null, 'both being mishit: nothing to gain');
  assert.equal(strikeComparison(form(6, 4), null), null, 'no second choice');
}

// Importing with a bag: new clubs are asked about, removed clubs' shots are left out.
{
  const { normalize } = await import('../js/store.js');
  const { currentBag, setClub, newClubs, keepBagShots } = await import('../js/bag.js');
  const file = (id, clubs) => ({ id, label: `File ${id}`, shots: clubs.map(clubCode => ({ clubCode, carry: 100 })) });

  // First import ever: the bag becomes the clubs in the files, no questions; putters aren't bag clubs.
  const d = normalize({});
  let r = newClubs(d, [file('a', ['d', '7i', '7i', 'p'])]);
  assert.deepEqual(r, { bagStarted: true, clubs: [] });
  assert.deepEqual(d.settings.bag, ['d', '7i']);

  // Later: a club in neither the bag nor the removed list is new, asked about once with its count and files.
  const fresh = [file('b', ['d', '4i', '4i', 'lob wedge']), file('c', ['4i', 'p'])];
  r = newClubs(d, fresh);
  assert.equal(r.bagStarted, false);
  assert.deepEqual(r.clubs, [
    { code: '4i', shots: 3, files: ['File b', 'File c'] },
    { code: 'lob wedge', shots: 1, files: ['File b'] },
  ]);
  // No to the 4 iron, yes to the other: 4 iron shots are left out, the putter stays.
  setClub(d, '4i', false);
  setClub(d, 'lob wedge', true);
  const skipped = keepBagShots(d, fresh);
  assert.deepEqual([...skipped], [['4i', 3]]);
  assert.deepEqual(fresh.map(s => s.shots.map(x => x.clubCode)), [['d', 'lob wedge'], ['p']]);
  assert.equal(fresh[0].id, 'b', 'the session keeps the ID from the whole file');
  assert.ok(currentBag(d).includes('lob wedge'));
  assert.deepEqual(d.settings.removedClubs, ['4i']);

  // Next time the 4 iron is left out without asking; adding it back takes it off the removed list.
  assert.deepEqual(newClubs(d, [file('e', ['4i'])]).clubs, []);
  setClub(d, '4i', true);
  assert.deepEqual(d.settings.removedClubs, []);
  assert.deepEqual(keepBagShots(d, [file('f', ['4i'])]).size, 0);

  // A bag set before removedClubs existed: clubs with shots outside the bag count as removed (no question).
  const older = normalize({ settings: { bag: ['d'] }, sessions: [file('g', ['d', '4i'])] });
  assert.deepEqual(older.settings.removedClubs, ['4i']);
  assert.deepEqual(newClubs(older, [file('h', ['4i'])]).clubs, []);
}

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
