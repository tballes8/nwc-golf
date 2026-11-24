# NWC Golf: handoff notes (Nov 21, 2026)

State of the app when development moved to Claude Code in VS Code.

## Live setup
- Repo: GitHub `tballes8/nwc-golf`, deployed by Cloudflare Workers (static assets) on push to `main`.
- Domain: https://golf.nwc-analytics.com (workers.dev URLs switched off in the dashboard; add `"workers_dev": false` and `"preview_urls": false` to `wrangler.jsonc` so a deploy doesn't turn them back on).
- Bump `VERSION` in `sw.js` on every deploy so installed phones pick up changes.
- Data is stored per browser (localStorage). Importing on the PC does not reach the phone; use Download backup, then import the .json on the phone.

## How the numbers are built (js/stats.js)
- Club picks use carry only. Total distance is shown next to carry (Caddie, chart circle, Bag cards) from the same good shots, added Nov 23; spin is not used.
- Partial swings left out: club speed under 85% of that club's 90th-percentile club speed (chips and pitches from sim rounds).
- Mishits left out: smash factor under 1.0, carry under 0.9 yd per mph of ball speed, apex under 10 ft, or carry under 75% of the median of the club's full swings that pass those three checks. (Ball-speed and apex checks added Nov 22 from e6-import-spec.md; skipped for metric Rapsodo files. Rapsodo apex is in feet, like E6.)
- Recent window: last 120 days of each club's sessions, reaching back until the club has 15 good shots. "All sessions" option on the Sessions screen.
- Club pick: each shot smoothed as a 4-yd bell curve; chance of landing within ± landing zone. Only clubs with 5+ good shots and a median within 20 yd of the target compete. Second choice = next club longer or shorter in the bag.
- Sessions can be left out without deleting them.

## What the data showed
- Rapsodo CSVs: UTF-8 BOM, no date inside the file (date comes from the filename, e.g. `session-range-2026-10-12.csv`, `session-studios-courses-2026-11-12.csv`), no unit labels, short club codes (`d`, `3w`, `4h`, `7i`, `pw`, `aw`, `lw`).
- Spin readings on range/practice sessions are often wrong (many ~1,000 rpm and ~12,000 rpm values on irons). Sim-round sessions look sane (3,000–5,000 rpm).
- Club speed varies 70–78 mph across sessions with the same club, moving carry 15–25 yd. This drives most of the gapping oddities.
- Sim rounds have no elevation data, so uphill/downhill shots add noise to carry.

## Total distance / rollout (raised Nov 21)
Tyrone wants total distance used, e.g. to spot wedges that check up or spin back.
Finding from all 463 shots so far: total is never less than carry. Every club rolls forward in Rapsodo's numbers, wedges included (AW median +15 yd, LW +12 yd). Indoors, total is the software's roll estimate from spin and descent angle, not a measurement, and it doesn't model spin-back.
Options discussed:
- Show rollout (total − carry) per club as a separate, clearly labelled estimate, most useful for tee shots and lay-ups.
- For wedges, use spin rate directly, only from sessions where spin is believable (RPT balls or sim rounds), rather than total.
- Validate against real rollout on course in spring.

## Roadmap
- Plays-like distance: forecast wind, temperature, elevation.
- Course GPS: distance to pin and hazards.
- Tournament mode toggle (turns off anything not allowed under Rules of Golf 4.3).
- Accounts and cloud sync (Cloudflare Workers + D1); every record already has `userId`.
- Later: normalise carry to a common club speed; importers for Garmin R10, SkyTrak, Mevo.
- Wide-screen layout: tab bar stretches full width on desktop.
