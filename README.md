# NWC Golf

Club selection from your own shot data, exported from the Rapsodo R-Cloud website (https://golf-cloud.rapsodo.com/). A static web app (no server, no build step) that runs on your phone and works offline.

Live at: https://golf.nwc-analytics.com

## What v1 does

- Imports Rapsodo MLM2PRO session CSVs exported from R-Cloud and E6 Connect shot data exports (several at once). It also restores backups made by the app.
- Takes the session date from the filename (`session-range-2026-10-12.csv`). If a file has no date in its name, the app asks for one. E6 filenames hold the export time in UTC (`shot_data_export_2026-11-20T00_49_06Z.csv`), so the app uses the local export date and lets you change it on the Sessions screen.
- Skips sessions that were already imported.
- Builds a profile for each club from **carry only**. Spin and total distance are ignored because the MLM2PRO's indoor spin readings are unreliable without RPT balls.
- Leaves out mishits: shots with a smash factor under 1.0, or a carry under 75% of that club's median.
- Uses recent sessions by default: the last 120 days of each club's data, reaching further back until the club has 15 good shots. Switch to "All sessions" on the Sessions screen.
- Caddie screen: enter yards to carry and get the club with the best chance of landing inside the landing zone (±8 yd by default), plus a second choice.
- Flags clubs with thin data and clubs that carry no farther than the next club down.
- Your bag: **Edit bag** on the Bag screen picks the clubs you carry. Clubs taken out (say, a 4 iron a simulator app chose for you) keep the shots already on record but are left out of club picks, the chart and the gapping warnings; **Add back** returns them. Until you edit it (or until your first import), the bag is every club you've hit. Warns above 14 clubs.
- Importing with a bag (`js/bag.js`): shots with clubs you took out aren't imported. A club that's in a file but in neither your bag nor the taken-out list brings up **New club found**: Yes adds it to the bag with its shots; No leaves its shots out and puts it on the taken-out list, so you aren't asked again. Your first import sets the bag without asking. Backups restore as they are. Shots left out at import are never stored, so adding the club back later doesn't bring them in from files already imported.
- Stores everything on the phone (localStorage). Use **Download backup** now and then.
- Invited testers only: each device signs in once (email code via Cloudflare Access) before the app opens. After that it opens offline too; Sign out is on the Sessions screen.
- Syncs sessions, your bag, and the two Sessions-screen settings between your devices through the account (Cloudflare D1); landing zone and target yardage stay per device. Syncs at start, a couple of seconds after an import or edit, when back online or back in the foreground, and with **Sync now**. The phone stays the working copy, so everything works offline; the newer change wins.

## Deploy (Cloudflare Workers static assets + GitHub)

The site is a Cloudflare Worker named `nwc-golf` that serves static files only (no Worker script). Workers Builds is connected to GitHub `tballes8/nwc-golf` and runs `npx wrangler deploy` on every push to `main`.

- `wrangler.jsonc` is the deploy config. It serves the repo folder and turns off the `workers.dev` and preview URLs, so the app is only at https://golf.nwc-analytics.com. Keep it committed: without it, Wrangler generates its own config on each deploy and turns those URLs back on.
- `.assetsignore` lists repo files that must not be served (docs, tests, config). Add any new non-app file or folder to it.
- Custom domain: in the Worker, **Settings > Domains & Routes** has `golf.nwc-analytics.com`.
- API: `worker/index.js` runs only for `/api/*` (`run_worker_first`). It uses the D1 database `nwc-golf` (binding `DB`). Cloudflare Access (team `nwc-golf`, application "NWC Golf API", policy "Testers") protects `/api/*`; add testers' emails to that policy. The Worker checks the Access token itself using `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc`. See `cloud-sync-plan.md`.
- Database changes are not applied on push. After adding a file to `migrations/`, run it yourself (Node 22+, `npx wrangler login` once):
  ```
  npx wrangler d1 migrations apply nwc-golf --remote
  ```
  Apply it **before** pushing code that needs it.

**When you change files, bump `VERSION` in `sw.js`** (for example `nwc-golf-v2`) so installed copies pick up the update.

## Put it on your iPhone

1. Open https://golf.nwc-analytics.com in **Safari**.
2. Tap **Share > Add to Home Screen**.
3. Open it from the Home Screen icon from now on. Safari can clear data for sites that aren't on the Home Screen, so this matters.

## Run locally

```
python3 -m http.server 8000
```
Then open http://localhost:8000. (Offline mode only switches on over HTTPS, so it's off locally.) This serves the app only; the sign-in box stays hidden because there's no API.

With the API and a local copy of the database (needs Node 22+):
```
npx wrangler d1 migrations apply nwc-golf --local
npx wrangler dev
```
Then open http://localhost:8787. Access can't run locally, so create a `.dev.vars` file (git-ignored, never deployed) with `DEV_EMAIL=you@example.com`; the Worker treats that as the signed-in user on localhost only.

## Tests

```
node tests/run.mjs
node tests/run.mjs path/to/session-*.csv path/to/shot_data_export_*.csv
```
The first runs built-in checks (CSV parsing, filename dates, E6 import, units). Passing real exports also checks duplicate detection, club profiles and club picks against your data. CSVs are git-ignored, so keep them outside the repo or uncommitted.

```
node tests/worker.mjs
node tests/sync.mjs
```
Need Node 22.13+ (built-in SQLite). `worker.mjs` checks the API Worker: the Cloudflare Access token check (bad signature, wrong audience or issuer, expired) and every route, against a real SQLite database built from `migrations/`. `sync.mjs` runs several simulated devices through the Worker and checks sync end to end: uploads, downloads, edits, deletes, the newer change winning, re-imports, backups and a second account. `tests/helpers.mjs` holds the D1 stand-in and fake Access.

## Files

```
index.html            app shell
css/app.css           styles
js/parse.js           CSV parsing, Rapsodo column mapping, club names
js/stats.js           mishit filter, club profiles, club picks
js/store.js           local storage and backups
js/account.js         sign-in status (Cloudflare Access)
js/sync.js            sync with the account (upload, download, merge)
js/bag.js             the bag: clubs carried, clubs taken out, new clubs at import
worker/index.js       API Worker (/api/*): routes and the Access token check
worker/sessions.js    sessions API
worker/settings.js    settings API (bag, units, window)
worker/http.js        shared response helpers
migrations/           D1 database schema changes
js/app.js             screens and events
sw.js                 offline cache
manifest.webmanifest  Home Screen install
_headers              response headers (keeps sw.js uncached)
wrangler.jsonc        Cloudflare deploy config
.assetsignore         repo files that are not served
fonts/                Barlow and Barlow Condensed (SIL Open Font License)
icons/                app icons
tests/run.mjs         tests
```

## Data notes

- Every session carries `userId: 'local'`, so accounts and cloud sync can be added later without reshaping the data.
- Units: Rapsodo exports have no unit labels. Set "Distances in Rapsodo files" to Meters if your Rapsodo app is set to meters. E6 exports put the units in the headers and are converted to yards, mph and feet at import, so the setting doesn't affect them.
- Club codes mapped so far: `d`, `3w`, `5w`, `4h`, `4i`–`9i`, `pw`, `aw`, `lw`. Other hybrids, `gw`, `sw` and degree wedges (`52`) are guessed; check them against a real export.
- E6 club names map to the same codes (`Driver`→`d`, `3 Wood`→`3w`, `4 Hybrid`→`4h`, `7 Iron`→`7i`). Wedges follow this bag: E6 `Gap Wedge` is Rapsodo `aw` and E6 `Sand Wedge` is Rapsodo `lw` (`E6_WEDGES` in `js/parse.js`). An unmapped name such as `Lob Wedge` shows up as its own club.
- E6 has no smash factor or side carry. Smash is computed as ball speed / head speed; clubs with only E6 shots show no left/right line.

## Next

- Plays-like distance: forecast wind, temperature, elevation.
- Course GPS: distance to pin and hazards.
- Tournament mode toggle.
- Accounts and cloud sync (Cloudflare Workers + D1).
