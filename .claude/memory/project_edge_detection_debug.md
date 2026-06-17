# ACTIVE DEBUG — Sidewalk edge detection: "both edges disappear together"

**Status 2026-06-17: NEW APPROACH BUILT (not yet tested on Noah). Scott called the
hot-fixes dead-ends — correct. The blob-detector paradigm couples the two edges by
construction. Replaced with a real lane-departure-style line detector. Build done on
the dev box (no numpy/cv2 there → UNTESTED); Scott will push to Noah to test.**

## NEW: `_detect_edges_hough` — independent two-line detector (the real fix)
Why the old approach failed at the root: `_detect_path_from_lines` segments ONE
walkable blob and reports its two sides, so the "left edge" and "right edge" are two
ends of a single region — coupled by construction. No per-side patch can decouple
them. Cars don't do this; lane-departure systems detect LINES directly (Canny →
Hough → split left/right by slope/side, each fit independently).

New method `_detect_edges_hough` in `realsense_vision.py` (~line 621):
- ROI (near-field, edge_roi_top/bottom_frac).
- Candidate edge pixels = Canny(gray) OR color-class boundary gradient OR depth
  drop-off (|horizontal depth jump| > dropoff_min_depth_jump_m). This is the
  color+depth cue Scott chose.
- `cv2.HoughLinesP` → segments; drop near-horizontal (steepness < edge_line_min_abs_slope).
- Split by the nearest (largest-y) endpoint's side of image center; fit ONE line per
  side independently via `np.polyfit(y, x, 1, w=len)`. Either side can be None alone.
- Evaluate each line at the lookahead row → 3D obs (pitch/roll corrected) → reuses
  `_assemble_edge_result` (shared TTL cache + known() + use/target/x_angle + the exact
  edge_* dict shape). LCD / message handler / steering unchanged.
- `_assemble_edge_result` (~line 530) factored out of the old detector's tail.

Routing: `detect_path` now checks `edge_hough_detector` (default TRUE) FIRST → new
detector. Set `edge_hough_detector:false` to A/B back to the old blob detector
(`_detect_path_from_lines`, still intact). Both in setup.json + setup_example.json.

### TEST ON NOAH (Scott pushes, then runs)
1. `python3 -c "import cv2; print(cv2.__version__, hasattr(cv2,'ximgproc'))"` — if
   ximgproc present we can upgrade Hough → FastLineDetector/LSD later (optional).
2. Drive/aim so only ONE sidewalk edge is visible. LCD3: visible side stays live
   (conf>0, X/Y), occluded side shows `C00 X---- Y----` — INDEPENDENTLY.
3. Read per-frame log in `realsense_message_handler.js` (~line 268): `L=..known R=..unknown`
   should differ per side.
4. Tune in setup.json if needed: edge_line_canny_low/high (45/130), edge_line_hough_threshold
   (30), edge_line_min_len_px (30), edge_line_max_gap_px (20), edge_line_min_abs_slope
   (0.25 — raise to reject more clutter), dropoff_min_depth_jump_m (0.15),
   edge_line_lookahead_frac (0.82). Lower hough_threshold/min_len if edges are missed;
   raise them if false lines appear.
5. If a side flickers between known/unknown: edge_known_ttl_ms (5000) bridges gaps.

### 2026-06-17 live-test tweaks (on Noah)
- LCD3 now refreshes at 10Hz. The i2c loop base tick is 100ms (connect_to_lcd.js);
  write_to_lcd refreshes LCD3 every tick, mouth every 5 ticks (~500ms, slowed tick
  passed to draw_mouth), status every 10 ticks (~1Hz). One serialized loop; a heavy
  tick self-throttles.
- "Low confidence driving down the middle": added a both-edges-seen corroboration
  boost in `_detect_edges_hough` (config `edge_both_seen_conf_boost`, default 0.25):
  when both edges are seen at a plausible width (0.4–2.5 m) each edge's confidence is
  raised to >=0.6+boost. Per-edge base confidence uses a fit_quality term
  (residual_std) added in an earlier Noah edit — if still low when centered, lower
  edge_line_hough_threshold / edge_line_min_len_px or raise edge_both_seen_conf_boost.

### Known limitations / next ideas if Hough underperforms
- Aggregating all left/right segments can pull in clutter (fences, building lines).
  Mitigations: tighten min_abs_slope, restrict ROI width, or RANSAC the per-side fit.
- Could add ximgproc FastLineDetector/LSD for cleaner segments.
- Depth currently only ADDS candidate pixels; could also REQUIRE a depth step to
  confirm a curb edge (reject painted-shadow false lines).

---
## (HISTORICAL) Earlier hot-fix attempts — superseded by the Hough detector above

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
