# NWC Golf

Club selection from your own Rapsodo launch monitor data. A static web app (no server, no build step) that runs on your phone and works offline.

Live at: https://golf.nwc-analytics.com

## What v1 does

- Imports Rapsodo MLM2PRO session CSVs exported from R-Cloud (several at once). It also restores backups made by the app.
- Takes the session date from the filename (`session-range-2026-10-12.csv`). If a file has no date in its name, the app asks for one.
- Skips sessions that were already imported.
- Builds a profile for each club from **carry only**. Spin and total distance are ignored because the MLM2PRO's indoor spin readings are unreliable without RPT balls.
- Leaves out mishits: shots with a smash factor under 1.0, or a carry under 75% of that club's median.
- Uses recent sessions by default: the last 120 days of each club's data, reaching further back until the club has 15 good shots. Switch to "All sessions" on the Sessions screen.
- Caddie screen: enter yards to carry and get the club with the best chance of landing inside the landing zone (±8 yd by default), plus a second choice.
- Flags clubs with thin data and clubs that carry no farther than the next club down.
- Stores everything on the phone (localStorage). Use **Download backup** now and then.

## Deploy (Cloudflare Pages + GitHub)

1. Create a GitHub repo (for example `nwc-golf`) and push this folder to it.
2. In Cloudflare: **Workers & Pages > Create > Pages > Connect to Git**, then pick the repo.
3. Build settings: framework preset **None**, build command **empty**, output directory **/**.
4. Deploy. You get `nwc-golf.pages.dev`.
5. In the project: **Custom domains > Set up a custom domain > `golf.nwc-analytics.com`**. Cloudflare adds the DNS record and HTTPS certificate.

Every push to `main` redeploys.

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
node tests/run.mjs path/to/session-*.csv
```
Checks the CSV parser, filename dates, duplicate detection and club picks against real exports.

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
_headers              Cloudflare Pages headers (keeps sw.js uncached)
fonts/                Barlow and Barlow Condensed (SIL Open Font License)
icons/                app icons
tests/run.mjs         tests
```

## Data notes

- Every session carries `userId: 'local'`, so accounts and cloud sync can be added later without reshaping the data.
- Units: Rapsodo exports have no unit labels. Set "Distances in your files" to Meters if your Rapsodo app is set to meters.
- Club codes mapped so far: `d`, `3w`, `5w`, `4i`–`9i`. Hybrids (`4h`), wedges (`pw`, `gw`, `sw`, `lw`) and degree wedges (`52`) are guessed; check them against a real export.

## Next

- Plays-like distance: forecast wind, temperature, elevation.
- Course GPS: distance to pin and hazards.
- Tournament mode toggle.
- Accounts and cloud sync (Cloudflare Workers + D1).
