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

**Scott reports it STILL doesn't work after these.** Root cause identified: the
first `find_independent_edges` STILL used run-detection (padded diff / starts / ends)
to pick the central walkable run. When a band is sparse or the run is shifted to one
corner, `selected` stays None → BOTH sides return None together. This is option (a).

## Fix applied 2026-06-17 (on Noah / Pi session)

`find_independent_edges` rewritten as a genuinely center-out per-side scan
(`realsense_vision.py` ~line 1789). No more shared run detection. Each direction
is scanned independently from the anchor:

```
anchor = nearest walkable col to image center
LEFT : scan leftward from anchor → stop at non-walkable → None if reached col 0
RIGHT: scan rightward from anchor → stop at non-walkable → None if reached last col
```

Two-threshold fallback retained. Guard: `walkable_cols.size < min_run_px` replaces the
old run-length check (more permissive — scattered pixels still provide a valid anchor).

## NEXT: live test to verify fix
Occlude one physical edge and watch the LCD3 EL/ER display:
- Remaining edge should stay live (non-zero conf, X/Y values)
- Disappeared edge should show `C00 X---- Y----`
Also verify in the realsense_message_handler.js log: `L=<m>@conf known` and
`R=--@0.00 unknown` (or vice-versa) — they should differ when one edge is gone.

## Watch for: `self.last_edge_obs` TTL cache
A gone edge lingers "known" for `edge_known_ttl_ms` (5000 ms default). If occluding
an edge and the display keeps showing it "known", wait >5 s or lower the TTL.

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
