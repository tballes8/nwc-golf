// Club profiles and club selection from stored sessions.
import { clubInfo } from './parse.js';

export const DEFAULTS = {
  recentDays: 120,     // prefer sessions within this many days of a club's newest session
  minShots: 15,        // ...but keep reaching back until a club has this many good shots
  mishitCarryRatio: 0.75, // shots carrying under 75% of the club's median are mishits
  mishitSmash: 1.0,    // smash factor under 1.0 is a mishit
  partialSpeedRatio: 0.85, // club speed under 85% of the club's full-swing speed = partial swing
  bandwidth: 4,        // yards of smoothing per shot when estimating chances
};

const M_TO_YD = 1.09361;

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => a.length < 2 ? 0 : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1));

function isMishit(shot, clubMedian, opts) {
  if (shot.smash != null && shot.smash < opts.mishitSmash) return true;
  return shot.carry < clubMedian * opts.mishitCarryRatio;
}

/**
 * Split one club's shots into full swings, partial swings and mishits.
 * Partial = club speed well below this club's normal full-swing speed
 * (chips and pitches from sim rounds, mostly).
 */
function classify(shots, opts) {
  const speeds = shots.map(s => s.clubSpeed).filter(x => x != null).sort((a, b) => a - b);
  const fullSpeed = speeds.length ? quantile(speeds, 0.9) : null;
  const full = [], partial = [];
  for (const s of shots) {
    (fullSpeed && s.clubSpeed != null && s.clubSpeed < fullSpeed * opts.partialSpeedRatio ? partial : full).push(s);
  }
  const med = quantile(full.map(s => s.carry).sort((a, b) => a - b), 0.5);
  const good = [], mishit = [];
  for (const s of full) (isMishit(s, med, opts) ? mishit : good).push(s);
  return { good, partial, mishit };
}

function daysBetween(a, b) { return Math.round((new Date(a) - new Date(b)) / 86400000); }

/**
 * Build one profile per club.
 * window: 'recent' (default) or 'all'.
 * units: 'yd' or 'm', what Rapsodo files contain. Sessions that record their own units
 * (E6, converted to yards at import) ignore it.
 * bag: club codes the golfer carries, or null for every club with shots. Every club still
 * gets a profile; ones not in the bag are marked inBag: false and left out of the gapping
 * warnings (and of club picks, see pickClub).
 */
export function buildProfiles(sessions, { window = 'recent', units = 'yd', bag = null, ...o } = {}) {
  const opts = { ...DEFAULTS, ...o };

  // Group shots by club, keeping their session.
  const byClub = new Map();
  for (const s of sessions) {
    if (s.excluded) continue; // the golfer chose to leave this session out
    const k = (s.units || units) === 'm' ? M_TO_YD : 1;
    for (const shot of s.shots) {
      if (!byClub.has(shot.clubCode)) byClub.set(shot.clubCode, new Map());
      const m = byClub.get(shot.clubCode);
      if (!m.has(s.id)) m.set(s.id, { session: s, shots: [] });
      m.get(s.id).shots.push({
        ...shot,
        carry: shot.carry * k,
        side: shot.side != null ? shot.side * k : null, // E6 has no side carry
        total: shot.total != null ? shot.total * k : null,
      });
    }
  }

  const profiles = [];
  for (const [code, sessMap] of byClub) {
    const groups = [...sessMap.values()].sort((a, b) => (b.session.date || '').localeCompare(a.session.date || ''));

    // Choose which sessions feed this club.
    let chosen = groups;
    if (window === 'recent') {
      chosen = [];
      const newest = groups[0].session.date;
      let good = 0;
      for (const g of groups) {
        const age = newest && g.session.date ? daysBetween(newest, g.session.date) : 0;
        if (age <= opts.recentDays || good < opts.minShots) {
          chosen.push(g);
          good = classify(chosen.flatMap(x => x.shots), opts).good.length;
        } else break;
      }
    }

    const all = chosen.flatMap(g => g.shots);
    const { good, partial, mishit } = classify(all, opts);
    if (!good.length) continue;
    const carries = good.map(s => s.carry).sort((a, b) => a - b);
    const sides = good.map(s => s.side).filter(x => x != null);
    const hasSide = sides.length >= 2; // otherwise there's no left/right spread to show
    const info = clubInfo(code);

    profiles.push({
      code,
      name: info.name,
      order: info.order,
      model: (all.find(s => s.model)?.model || '').trim(),
      shots: all.length,
      goodShots: good.length,
      mishits: mishit.length,
      partials: partial.length,
      carries,
      median: quantile(carries, 0.5),
      p10: quantile(carries, 0.1),
      p25: quantile(carries, 0.25),
      p75: quantile(carries, 0.75),
      p90: quantile(carries, 0.9),
      sd: sd(carries),
      sideSd: hasSide ? sd(sides) : null,
      sideMean: hasSide ? mean(sides) : null,
      clubSpeed: quantile(good.map(s => s.clubSpeed).filter(x => x != null).sort((a, b) => a - b), 0.5),
      sessions: chosen.map(g => ({ id: g.session.id, date: g.session.date, shots: g.shots.length })),
      confidence: good.length >= 20 ? 'solid' : good.length >= 10 ? 'thin' : 'very thin',
      inBag: !bag || bag.includes(code),
    });
  }
  profiles.sort((a, b) => a.order - b.order);

  // Flag clubs that carry shorter than a club meant to go less far (clubs in the bag only).
  const carried = profiles.filter(p => p.inBag);
  for (let i = 0; i < carried.length - 1; i++) {
    const longer = carried[i], shorter = carried[i + 1];
    if (longer.order < 200 && longer.median <= shorter.median) {
      longer.gapWarning = `${longer.name} is carrying no farther than your ${shorter.name.toLowerCase()}.`;
    }
  }
  return profiles;
}

/**
 * A club's most recent shots, newest first (session date, then latest import, then shot
 * order), each labelled 'good', 'mishit' or 'partial' by the same rules as the club's numbers,
 * applied to all of the club's shots. For checking how a club is being struck lately.
 * Sessions left out are skipped. Returns { shots, counts: { good, mishit, partial }, goodMedian }
 * for the shots returned.
 */
export function recentShots(sessions, code, { units = 'yd', limit = 10, ...o } = {}) {
  const opts = { ...DEFAULTS, ...o };
  const all = [];
  for (const s of sessions) {
    if (s.excluded) continue;
    const k = (s.units || units) === 'm' ? M_TO_YD : 1;
    s.shots.forEach((shot, i) => {
      if (shot.clubCode !== code) return;
      all.push({ ...shot, carry: shot.carry * k, total: shot.total != null ? shot.total * k : null, date: s.date, n: i, importedAt: s.importedAt || '' });
    });
  }
  const { partial, mishit } = classify(all, opts);
  const partials = new Set(partial), mishits = new Set(mishit);
  all.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.importedAt.localeCompare(a.importedAt) || b.n - a.n);
  const shots = all.slice(0, limit).map(s => ({
    date: s.date,
    carry: s.carry,
    total: s.total,
    ballSpeed: s.ballSpeed ?? null,
    clubSpeed: s.clubSpeed ?? null,
    label: partials.has(s) ? 'partial' : mishits.has(s) ? 'mishit' : 'good',
  }));
  const counts = { good: 0, mishit: 0, partial: 0 };
  for (const s of shots) counts[s.label]++;
  const goodCarries = shots.filter(s => s.label === 'good').map(s => s.carry).sort((a, b) => a - b);
  return { shots, counts, goodMedian: quantile(goodCarries, 0.5) };
}

// Normal CDF (Abramowitz–Stegun 7.1.26 via erf).
function phi(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Chance a club's carry lands short of, inside, and past [target-w, target+w]. */
export function chances(profile, target, w, bandwidth = DEFAULTS.bandwidth) {
  // Each recorded carry is treated as a small bell curve (bandwidth yards wide),
  // so a handful of shots still gives smooth, non-zero chances.
  let inside = 0, short = 0;
  for (const c of profile.carries) {
    const below = phi((target - w - c) / bandwidth); // lands short of the window
    const upTo = phi((target + w - c) / bandwidth);  // lands at or before the back edge
    short += below;
    inside += upTo - below;
  }
  const n = profile.carries.length;
  inside /= n; short /= n;
  return { inside, short, long: Math.max(0, 1 - inside - short) };
}

/**
 * Rank clubs for a target carry. window = half-width in yards (green depth / 2).
 * Clubs with very thin data are ranked but marked.
 */
export function pickClub(profiles, target, w = 8, reach = 20, minShots = 5) {
  // A club needs a few full swings on record before it can be recommended;
  // one lucky shot shouldn't make it the answer.
  const scored = profiles
    .filter(p => p.inBag !== false && p.order < 200 && p.goodShots >= minShots)
    .map(p => ({ profile: p, ...chances(p, target, w), gap: Math.abs(p.median - target) }));
  // Only clubs whose typical carry is near the target compete; a wild club with a
  // huge spread shouldn't win just because its misses happen to cover the number.
  if (!scored.length) return { best: null, backup: null };
  const near = scored.filter(x => x.gap <= reach).sort((a, b) => b.inside - a.inside);
  const best = near[0] || [...scored].sort((a, b) => a.gap - b.gap)[0];
  // Second choice is the club one longer or one shorter in the bag, like a caddie
  // would offer, whichever puts more shots in the zone.
  const i = scored.indexOf(best); // scored keeps bag order (longest first)
  const neighbors = [scored[i - 1], scored[i + 1]].filter(Boolean).sort((a, b) => b.inside - a.inside);
  return { best, backup: neighbors[0] || null };
}
