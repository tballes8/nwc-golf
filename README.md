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
- Stores everything on the phone (localStorage). Use **Download backup** now and then.

## Deploy (Cloudflare Workers static assets + GitHub)

The site is a Cloudflare Worker named `nwc-golf` that serves static files only (no Worker script). Workers Builds is connected to GitHub `tballes8/nwc-golf` and runs `npx wrangler deploy` on every push to `main`.

- `wrangler.jsonc` is the deploy config. It serves the repo folder and turns off the `workers.dev` and preview URLs, so the app is only at https://golf.nwc-analytics.com. Keep it committed: without it, Wrangler generates its own config on each deploy and turns those URLs back on.
- `.assetsignore` lists repo files that must not be served (docs, tests, config). Add any new non-app file or folder to it.
- Custom domain: in the Worker, **Settings > Domains & Routes** has `golf.nwc-analytics.com`.

**When you change files, bump `VERSION` in `sw.js`** (for example `nwc-golf-v2`) so installed copies pick up the update.

## Put it on your iPhone

1. Open https://golf.nwc-analytics.com in **Safari**.
2. Tap **Share > Add to Home Screen**.
3. Open it from the Home Screen icon from now on. Safari can clear data for sites that aren't on the Home Screen, so this matters.

## Run locally

```
python3 -m http.server 8000
```
Then open http://localhost:8000. (Offline mode only switches on over HTTPS, so it's off locally.)

## Tests

```
node tests/run.mjs
node tests/run.mjs path/to/session-*.csv path/to/shot_data_export_*.csv
```
The first runs built-in checks (CSV parsing, filename dates, E6 import, units). Passing real exports also checks duplicate detection, club profiles and club picks against your data. CSVs are git-ignored, so keep them outside the repo or uncommitted.

## Files

```
index.html            app shell
css/app.css           styles
js/parse.js           CSV parsing, Rapsodo column mapping, club names
js/stats.js           mishit filter, club profiles, club picks
js/store.js           local storage and backups
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
