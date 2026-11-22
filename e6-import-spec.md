# E6 Connect import: spec (from two sample exports, Nov 21, 2026)

Samples: `shot_data_export_2026-11-20T00_49_06.772054Z.csv` (Oslo Golf Club, 18 holes, 56 shots) and `shot_data_export_2026-11-20T01_27_34.044257Z.csv` (Practice Area Targets, 17 drivers).

## Format
- Plain CSV, unquoted, lowercase headers with units in the header text:
  `course,hole,shot,club type,head speed (mph),total distance (yds),carry distance (yds),apex height (ft),ball speed (mph),back spin,side spin,launch dir,launch angle`
- Detect by headers containing `club type` and `carry distance (yds)`.
- Units are in the headers (yds, mph, ft), so no unit setting is needed for this format. Watch for `(m)` / `(km/h)` variants if E6 is set to metric.
- Club names are full words: `Driver`, `3 Wood`, `5 Wood`, `4 Hybrid`, `4 Iron`…`9 Iron`, `Gap Wedge`, `Sand Wedge` (expect `Pitching Wedge`, `Lob Wedge` too). Map to the internal codes: Driver→`d`, `N Wood`→`Nw`, `N Hybrid`→`Nh`, `N Iron`→`Ni`, Pitching/Gap/Sand/Lob Wedge→`pw`/`gw`/`sw`/`lw`. Add `gw` to clubInfo (Rapsodo files used `aw`).
- Blank fields happen (shot 18 has no carry or apex). Skip shots with no carry, as now.

## Differences from Rapsodo
| Field | Rapsodo | E6 |
|---|---|---|
| Date | in filename (`session-range-2026-10-12`) | filename is the **export time in UTC** (`2026-11-20T00_49_06Z` = Nov 19, 4:49 PM Pacific). Convert to local date; treat as "exported on", let the user correct it |
| Session label | type from filename | `course` column (e.g. "Oslo Golf Club", "Practice Area Targets") |
| Hole / shot no. | no | yes (`hole`, `shot`), keep for later round analysis |
| Smash factor | column | **not provided**; compute `ball speed / head speed` |
| Side carry | column | **not provided**; only `launch dir` and `side spin`. Store `side: null` and hide the left/right line when a club has no side data (today `side ?? 0` would show a false "±0 yd") |
| Spin | spin rate + axis | back spin + side spin; total spin = sqrt(back² + side²) if needed |
| Apex | yes | yes (ft) |

## Data quality seen
- Total is never less than carry here either; same roll-estimate caveat as Rapsodo.
- Head speed repeats exact values (82.32 mph on 12 of 56 shots), so it may be estimated or rounded by the device. A computed smash factor is less trustworthy than Rapsodo's.
- Bad readings: back spin 0 / side spin 0 (shot 52), driver back spin 11,319 (shot 34).
- **Topped shots slip past the current mishit filter.** 4 Hybrid has 7 shots: carries 17, 36, 66, 76, 116, 119, 144 with smash ~1.43 and apex 0.1–4.3 ft on the bad ones. The median (76) is dragged down by the mishits, so "under 75% of median" keeps 66 and 76.
  - Proposed extra rule for all formats: mishit if carry per mph of ball speed < 0.9 (good shots run 1.0–1.6 yd/mph; the topped 4h shots are 0.15–0.71), or apex under 10 ft on a full swing.
  - Also compute the 75%-of-median check on shots that pass the yd/mph rule, so mishits don't drag the median down.

## Double counting (resolved Nov 22: not an issue)
All shots come from the MLM2PRO, but E6 Connect stores the rounds played through it only on the E6 platform, and R-Cloud stores only sessions played in Rapsodo's own app. The same shots never appear in both exports, so no cross-format duplicate check is needed.
