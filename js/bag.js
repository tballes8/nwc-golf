// The bag: the clubs the golfer carries (settings.bag), and the clubs they took out or said no
// to (settings.removedClubs). Both sync with the account.
// - Until the bag is edited (or the first import), it's every club with shots.
// - Clubs not in the bag keep the shots already on record, but are left out of club picks, the
//   chart and the gapping warnings (see buildProfiles in stats.js).
// - Importing a file: shots with removed clubs are left out; a club that's neither in the bag
//   nor removed is a new club, and the app asks whether to add it (see importFiles in app.js).
import { clubInfo } from './parse.js';

export const byOrder = (a, b) => clubInfo(a).order - clubInfo(b).order;

/** Putters (and anything sorting after them) aren't part of the bag; their shots always import. */
export const isBagClub = code => clubInfo(code).order < 200;

/** Shots on record per club code. */
export function shotCounts(data) {
  const n = new Map();
  for (const s of data.sessions) for (const x of s.shots) n.set(x.clubCode, (n.get(x.clubCode) || 0) + 1);
  return n;
}

/** The bag as edited, or every club with shots until it's edited. */
export function currentBag(data) {
  return data.settings.bag ?? [...shotCounts(data).keys()].filter(isBagClub).sort(byOrder);
}

export const removedClubs = data => data.settings.removedClubs || [];

/** Put a club in the bag, or take it out (its shots in new files are then left out). */
export function setClub(data, code, inBag) {
  const bag = currentBag(data);
  data.settings.bag = (inBag ? [...new Set([...bag, code])] : bag.filter(c => c !== code)).sort(byOrder);
  data.settings.removedClubs = inBag
    ? removedClubs(data).filter(c => c !== code)
    : [...new Set([...removedClubs(data), code])];
}

/**
 * Before importing `fresh` sessions (parsed from files, not yet stored): make sure the bag is
 * set, then list the new clubs to ask about. On a first import the bag simply becomes the
 * clubs in the files, with no questions.
 * Returns [{ code, shots, files: [label] }] in bag order; may set data.settings.bag (returns
 * bagStarted: true then, so the caller can save and sync it).
 */
export function newClubs(data, fresh) {
  let bagStarted = false;
  if (!data.settings.bag) {
    const known = currentBag(data);
    data.settings.bag = known.length
      ? known
      : [...new Set(fresh.flatMap(s => s.shots.map(x => x.clubCode)))].filter(isBagClub).sort(byOrder);
    bagStarted = true;
  }
  const bag = new Set(data.settings.bag), removed = new Set(removedClubs(data));
  const found = new Map();
  for (const s of fresh) {
    for (const x of s.shots) {
      const c = x.clubCode;
      if (!isBagClub(c) || bag.has(c) || removed.has(c)) continue;
      if (!found.has(c)) found.set(c, { code: c, shots: 0, files: new Set() });
      found.get(c).shots++;
      found.get(c).files.add(s.label || s.fileName || 'this file');
    }
  }
  return {
    bagStarted,
    clubs: [...found.values()].sort((a, b) => byOrder(a.code, b.code)).map(f => ({ ...f, files: [...f.files] })),
  };
}

/**
 * Leave out shots with clubs not in the bag (after the new-club questions are answered).
 * Changes `fresh` in place and returns the left-out shot counts per club. The session keeps
 * the ID worked out from the whole file, so importing the same file again is still caught
 * as a duplicate.
 */
export function keepBagShots(data, fresh) {
  const bag = new Set(currentBag(data));
  const skipped = new Map();
  for (const s of fresh) {
    s.shots = s.shots.filter(x => {
      if (!isBagClub(x.clubCode) || bag.has(x.clubCode)) return true;
      skipped.set(x.clubCode, (skipped.get(x.clubCode) || 0) + 1);
      return false;
    });
  }
  return skipped;
}
