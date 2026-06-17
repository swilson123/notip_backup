# ACTIVE DEBUG — Sidewalk edge detection: "both edges disappear together" (UNRESOLVED)

**Status as of 2026-06-17: NOT FIXED. In progress. Continuing on the Raspberry Pi (Noah) so the vision pipeline can actually be run/instrumented.**

## The bug (Scott's report)
On LCD screen 3 the rover shows a left edge (EL) and right edge (ER) for sidewalk
detection. **When ONE physical edge leaves the camera view, BOTH edges read as
not-seen.** They are coupled — losing one nulls the other. Scott wants each edge
tracked INDEPENDENTLY: lose the right edge → ER goes blank, EL stays live, and
vice-versa.

## LCD display work (DONE, working)
`lib/lcd_screen/write_to_lcd.js` `draw_realsense()`:
- Removed the old `EL1/EL0`, `ER1/ER0` seen-flag suffix.
- Confidence is the single seen-indicator: a detected edge always reports >= ~55,
  so `C00` means "no edge". Not-seen row shows `EL C00 X---- Y----`.
- `fmt_m_1(v, seen)` returns `----` for X/Y when not seen (was showing stale values).
- `el_seen`/`er_seen` still gate conf + X/Y; they read `det.edge_left_known` /
  `det.edge_right_known` (fall back to `left/right_boundary_visible`).

## Root-cause hunt — CRITICAL LESSON
There are THREE edge implementations in `lib/realsense/realsense_vision.py`:
1. `_detect_path_from_lines` (line ~302)  ← **THE LIVE ONE**
2. `_compute_edge_guidance` (line ~1201) BEV path + legacy path  ← **DEAD by default**
3. `_compute_edge_clearance` (line ~984) — clearance/safety only

`detect_path()` (~line 512) routes:
```python
if bool(self.config.get("edge_lines_only", True)):   # DEFAULT TRUE, NOT set in setup.json
    return self._detect_path_from_lines(...)
```
`edge_lines_only` is ABSENT from setup.json → defaults True → **only
`_detect_path_from_lines` runs.** `_compute_edge_guidance` is never called in the
live config. I wasted two rounds editing `_compute_edge_guidance` before realizing
this. **ALWAYS trace `detect_path` entry + `edge_lines_only` FIRST.**

## The coupling mechanism
All three paths used `find_nearest_mask_edges()` (~line 1723), which returns the
LEFT and RIGHT ends of ONE contiguous walkable run — both-or-neither, never one
side alone. So `nearest_left`/`nearest_right` (and thus `edge_left_known`/
`edge_right_known`) were always set/cleared as a pair.

## Fixes applied so far (committed to working tree, may need git sync to Pi)
- Added `find_independent_edges()` (~line 1783): finds the central walkable run,
  then reports each boundary ONLY if it's a real transition INSIDE the frame; a run
  reaching an image border = that side out of view = None for THAT side alone.
- Swapped all 3 call sites to `find_independent_edges`:
  - line ~408  `_detect_path_from_lines`  ← THE LIVE FIX
  - line ~1278 `_compute_edge_guidance` BEV (dead by default)
  - line ~1483 `_compute_edge_guidance` legacy (dead by default)
- New tunable `edge_border_margin_px` (default 2) added to setup.json + setup_example.json.
- Also fixed an earlier (real but secondary) bug: the `path_lost` early-return in
  `_compute_edge_guidance` (~line 621) dropped all `edge_*` fields → handler read
  both `!!undefined` = false. (Dead path by default, but fixed.)

**Scott reports it STILL doesn't work after these.** So either (a) the run-detection
itself fails entirely when one edge leaves (nulling both legitimately), or (b)
there's another coupling/state issue, or (c) the scenario is mask degradation not
"run reaches border".

## NEXT STEPS ON THE PI (where numpy + pyrealsense2 + camera exist)
1. **Confirm the live path:** check `edge_lines_only` actual value; confirm
   `_detect_path_from_lines` is running (add a one-line stderr print of method name + 
   `nearest_left`/`nearest_right` is/None per frame).
2. **Read the existing per-frame log** in `lib/realsense/realsense_message_handler.js`
   (~line 268): prints `L=<m>@conf known/unknown age=..ms  R=...` plus a `RAW:` JSON
   dump. Have Scott occlude/remove ONE edge and capture several frames. This shows
   definitively whether the Python emits independent knowns.
3. **Run the vision script standalone** and dump `band_scores` for the lookahead band
   when one edge is gone. Verify whether `find_independent_edges` returns
   (left, None) as intended, or (None, None) because the central walkable run failed.
   - If the run fails entirely → need genuinely independent per-side scans:
     from image center, scan LEFT until walkable stops (= left edge; None if it
     reaches col 0); scan RIGHT independently (= right edge; None if reaches last col).
     This does NOT depend on a single shared run surviving.
4. Watch `self.last_edge_obs` cache + `edge_known_ttl_ms` (5000): a gone edge lingers
   "known" for 5 s. Test by waiting >5 s after an edge leaves.

## Key files
- `lib/realsense/realsense_vision.py` — detection (the live `_detect_path_from_lines`)
- `lib/realsense/realsense_message_handler.js` — JSON→state + the per-frame debug log
- `lib/lcd_screen/write_to_lcd.js` — `draw_realsense()` LCD rows
- setup.json: `edge_lines_only`(absent→True), `edge_mask_threshold` 0.14,
  `edge_min_run_px` 6, `edge_border_margin_px` 2, `edge_known_ttl_ms` 5000,
  `edge_confidence_min` 0.4 (JS clamps to 0.5).

## Dead-code cleanup pending (separate, agreed but not done)
The carrot/centerline stack is dead: `get_adjusted_nav_target`, `get_history_analysis`,
`interpolate_centerline_lateral` in `run_mission.js` (no callers). Steering runs purely
on `x_angle_deg`. Retiring it lets us drop `sidewalk_seek_confidence_threshold` and
`confidence_threshold` from setup.json. Phase 1 = delete dead carrot stack (safe).
