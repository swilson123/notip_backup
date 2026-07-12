"""
concrete_edge_detector.py

Architecture
------------
1.  Build a concrete-probability map  (LAB L, HSV S, local texture variance)
2.  Remove yellow parking lines in HSV before thresholding
3.  Threshold the probability map → binary candidate mask
4.  Morphological clean-up
5.  Connected-component scoring by material confidence (NOT edge shape)
6.  Width soft-penalty; horizon hard-reject; interior concrete-ratio check (≥ 55%)
7.  Extract left/right boundary columns from the selected blob only
8.  RANSAC + degree-2 polynomial smoothing of boundaries
9.  Temporal EMA on polynomial coefficients
10. State machine  SEARCH → APPROACH → TRACK  with hysteresis

Rejection chain
---------------
- Sky / far objects  — above horizon hard-reject
- White vehicles     — outside ground ROI  OR  too high in ROI
- Yellow lines       — HSV yellow mask removed before thresholding
- Asphalt speckles   — local texture-variance term penalises rough regions
- Tiny patches       — MIN_BLOB_AREA_PX hard floor
- Bad polygons       — interior concrete-ratio < 55 % → rejected
"""

import sys
import cv2
import numpy as np
from collections import deque


def _assert_same_hw(name_a, a, name_b, b):
    """Raise clearly if two arrays have different H×W before boolean indexing."""
    if a.shape[:2] != b.shape[:2]:
        raise ValueError(
            f"Shape mismatch: {name_a}{a.shape[:2]} vs {name_b}{b.shape[:2]}"
        )


def _crop_to(arr, h, w):
    """Return arr[:h, :w] — safely crop any 2-D or 3-D array to (h, w, ...)."""
    return arr[:h, :w]


def safe_pixels(arr, bool_mask, name="arr"):
    """Index arr with bool_mask after verifying shapes match. Raises clearly."""
    if arr.shape[:2] != bool_mask.shape[:2]:
        raise ValueError(
            f"safe_pixels: {name} shape {arr.shape[:2]} "
            f"does not match mask {bool_mask.shape[:2]}"
        )
    return arr[bool_mask]

# ── Tunable constants ──────────────────────────────────────────────────────────
ROI_START_FRAC      = 0.38
ROI_END_FRAC        = 1.00

BLUR_KERNEL         = 21      # large Gaussian to smear asphalt speckles
LOCAL_STAT_KERNEL   = 17      # window for local mean / variance computation

# Probability-map component weights
W_BRIGHT            = 0.40
W_LOW_SAT           = 0.35
W_SMOOTH            = 0.25

PROB_THRESHOLD      = 0.45    # probability > this → candidate concrete pixel
INTERIOR_MIN_RATIO  = 0.55    # polygon interior must be ≥ 55 % concrete

# Yellow line removal
YELLOW_H_LO         = 15
YELLOW_H_HI         = 40
YELLOW_S_MIN        = 80
YELLOW_V_MIN        = 80

MIN_BLOB_AREA_PX    = 2000
MAX_BLOB_WIDTH_FRAC = 0.65    # soft penalty beyond this
WIDTH_PENALTY       = 20      # score deducted for too-wide blobs

MORPH_OPEN_K        = 5
MORPH_CLOSE_K       = 5    # was 19 — large close bridged asphalt gap

N_BANDS             = 20
MIN_CONCRETE_COLS   = 6

RANSAC_ITERS        = 60

# ── FastSCNN edge-extraction constants ────────────────────────────────────────
# Controls downstream edge detection only. FastSCNN inference is unaffected.

# Mask validity
MIN_MASK_PIXELS            = 500  # fewer pixels → skip frame; raise to tighten

# Anchor region — bottom-centre of ROI, area directly ahead of the rover
ANCHOR_X_FRAC              = 0.30  # central width fraction; decrease = narrower anchor
ANCHOR_Y_FRAC              = 0.15  # bottom height fraction; increase = taller anchor zone
MIN_ANCHOR_OVERLAP_PIXELS  = 10    # min pixels in anchor to accept primary component

# Anchor fallback — when no component overlaps anchor but tracking was recent
ANCHOR_FALLBACK_CX_TOL     = 80   # max px from last component centre; decrease = stricter
MIN_FALLBACK_COMPONENT_AREA = 200  # ignore tiny noise blobs during fallback

# Contiguous-run extraction
MIN_RUN_WIDTH_PX   = 6      # narrower runs rejected; increase on noisy masks
MAX_CX_JUMP_PX     = 80     # max horizontal centroid shift per sample row
                             # decrease to follow tighter curves
MAX_WIDTH_RATIO    = 3.0    # max run-width ratio between adjacent sample rows
                             # decrease to reject sudden width changes

# Fitting
MIN_FIT_POINTS     = 4      # min valid boundary pts for RANSAC; increase for stricter fits
MAX_RESIDUAL_FRAC  = 0.35   # reject fit if >this fraction of pts are outliers

# Geometry validation (per-side, applied after fitting)
MIN_EDGE_SEPARATION_PX = 5   # only reject if lines actually cross or nearly cross
RANSAC_THRESH_PX    = 40     # px — wider tolerance handles steep-angle perspective spreads
POLY_DEGREE         = 2
SMOOTH_HISTORY      = 5      # frames — smaller = lines track current data more closely

# Border-clip / field-of-view detection
BORDER_CLIP_TOL  = 8     # px from image edge counted as "touching the border"
BORDER_CLIP_FRAC = 0.35  # fraction of scanline pts required to confirm clipping

# Raw-point fallback parameters
_RAW_SMOOTH_K    = 3     # moving-median kernel size for x-coordinate smoothing
_RAW_OUTLIER_STD = 2.5   # reject pts where |x − median(x)| > this many standard deviations
SMOOTH_ALPHA        = 0.40

# State machine
STATE_SEARCH   = "SEARCH"
STATE_APPROACH = "APPROACH"
STATE_TRACK    = "TRACK"
FRAMES_TO_LOCK = 4
FRAMES_TO_LOSE = 6
SEED_W_FRAC    = 0.30
SEED_H_FRAC    = 0.20


# ── RANSAC polynomial helpers ──────────────────────────────────────────────────

def _fit_poly_ransac(pts, degree=2, n_iter=60, thresh=20):
    if len(pts) < degree + 1:
        return None
    xs = np.array([p[0] for p in pts], dtype=np.float32)
    ys = np.array([p[1] for p in pts], dtype=np.float32)
    n  = len(pts)
    best_c, best_n = None, 0
    for _ in range(n_iter):
        idx  = np.random.choice(n, degree + 1, replace=False)
        c    = np.polyfit(ys[idx], xs[idx], degree)
        pred = np.polyval(c, ys)
        nin  = int(np.sum(np.abs(pred - xs) < thresh))
        if nin > best_n:
            best_n, best_c = nin, c
    if best_c is None or best_n < degree + 1:
        return None
    pred    = np.polyval(best_c, ys)
    inliers = np.abs(pred - xs) < thresh
    if inliers.sum() < degree + 1:
        return best_c
    return np.polyfit(ys[inliers], xs[inliers], degree)


def _smooth_history(history):
    if not history:
        return None
    return np.array(list(history), dtype=np.float32).mean(axis=0)


def _eval_line(coeffs, y_values, W):
    if coeffs is None:
        return None
    xs = np.clip(np.round(np.polyval(coeffs, y_values)).astype(int), 0, W - 1)
    return [(int(x), int(y)) for x, y in zip(xs, y_values)]


def _filter_border_pts(pts, border_x, mask_roi, side):
    """
    Remove individual points within BORDER_CLIP_TOL of border_x, but only when
    the segmentation mask confirms the sidewalk actually exits through that border.

    Returns (pts_to_use, any_filtered: bool).
    When no border contact is confirmed, returns the original pts list unchanged.
    """
    if not pts:
        return pts, False
    interior = [(x, y) for (x, y) in pts if abs(x - border_x) > BORDER_CLIP_TOL]
    n_clipped = len(pts) - len(interior)
    if n_clipped == 0:
        return pts, False
    # Confirm the mask extends into the border strip before removing anything
    border_confirmed = False
    if mask_roi is not None:
        strip = (mask_roi[:, :BORDER_CLIP_TOL]
                 if side == 'left'
                 else mask_roi[:, -BORDER_CLIP_TOL:])
        border_confirmed = bool(np.any(strip))
    else:
        # No mask available — use fraction as a proxy
        border_confirmed = n_clipped / len(pts) >= BORDER_CLIP_FRAC
    if border_confirmed:
        return interior, True
    return pts, False


def _smooth_raw_pts(pts):
    """
    Outlier-filter + moving-median smooth of raw scanline edge points.
    - Sorts by y (top→bottom).
    - Removes isolated x outliers (> _RAW_OUTLIER_STD σ from median).
    - Applies a moving-median to x while preserving original y positions.
    Returns list of (x, y) int tuples, or None when too few points survive.
    Does NOT fit a polynomial.
    """
    if len(pts) < MIN_FIT_POINTS:
        return None
    pts_s = sorted(pts, key=lambda p: p[1])          # top → bottom
    xs = np.array([p[0] for p in pts_s], dtype=np.float32)
    ys = [p[1] for p in pts_s]
    # Outlier removal
    med = float(np.median(xs))
    std = float(np.std(xs)) or 1.0
    keep = np.abs(xs - med) <= _RAW_OUTLIER_STD * std
    if int(keep.sum()) < MIN_FIT_POINTS:
        return None
    xs_k = xs[keep]
    ys_k = [ys[i] for i, k in enumerate(keep) if k]
    # Moving-median smooth of x
    pad   = _RAW_SMOOTH_K // 2
    xs_p  = np.pad(xs_k, pad, mode='edge')
    xs_sm = np.array([float(np.median(xs_p[i:i + _RAW_SMOOTH_K]))
                      for i in range(len(xs_k))], dtype=np.float32)
    return [(int(round(float(x))), int(y)) for x, y in zip(xs_sm, ys_k)]


# ══════════════════════════════════════════════════════════════════════════════
# Detector
# ══════════════════════════════════════════════════════════════════════════════

class ConcreteEdgeDetector:

    def __init__(self, device="cpu", camera_height_m=0.406, segmentation_model_path=None):
        self.camera_height_m = camera_height_m
        self._left_hist   = deque(maxlen=SMOOTH_HISTORY)
        self._right_hist  = deque(maxlen=SMOOTH_HISTORY)
        self._left_poly   = None
        self._right_poly  = None
        self._confidence  = 0.0
        self._last_mask   = None

        self.state          = STATE_SEARCH
        self._lock_counter  = 0
        self._lose_counter  = 0
        self._target_cx     = None
        self._target_cy     = None
        self._last_debug    = None

        # Mask centroid tracking for camera-angle-change detection
        self._last_centroid_y  = None   # px, full-image coords
        self._CENTROID_RESET_PX = 40    # shift > this → reset polynomial history

        # FastSCNN miss counter and continuity trackers
        self._fs_miss_counter   = 0
        self._last_left_run_cx  = None  # leftmost px of last selected run
        self._last_right_run_cx = None  # rightmost px of last selected run
        self._last_component_cx = None  # centre-x of last selected component

        # FastSCNN trained segmentation
        self._zero_shot     = None
        self._use_zero_shot = False
        try:
            from fastscnn_detector import FastSCNNDetector
            self._zero_shot     = FastSCNNDetector(model_path=segmentation_model_path)
            self._use_zero_shot = True
            print("ConcreteEdgeDetector: segmentation = fastscnn", file=sys.stderr, flush=True)
        except Exception as exc:
            print(f"ConcreteEdgeDetector: FastSCNN unavailable ({exc}), using rule-based", file=sys.stderr, flush=True)

    # ══════════════════════════════════════════════════════════════════════════
    # PUBLIC ENTRY POINT
    # ══════════════════════════════════════════════════════════════════════════

    # ══════════════════════════════════════════════════════════════════════════
    # GEOMETRY FILTER — depth-based ground-plane check
    # ══════════════════════════════════════════════════════════════════════════

    def _ground_plane_mask(self, depth_z16, intrinsics,
                           pitch_rad=0.0, roll_rad=0.0):
        """
        Returns a uint8 (H, W) mask where 255 = pixel is physically on the
        ground plane (flat, horizontal, at the expected camera height).

        Walls, vehicles, and buildings are ABOVE the ground plane and will
        have world_Y >> 0 — they fail this check even if CLIPSeg labels them
        as concrete.  This is the core geometry filter.

        Uses the same 3-D back-projection math as notip_backup RealsenseVision.
        """
        import math
        H, W     = depth_z16.shape
        CAM_H    = self.camera_height_m    # camera height above ground (m)
        MIN_Y    = -0.08    # below ground — likely measurement noise
        MAX_Y    =  0.12    # max height above ground still walkable
        MIN_Z    =  0.15    # min forward depth
        MAX_Z    =  6.0     # max forward depth

        dm = depth_z16.astype(np.float32) * 0.001
        rows, cols = np.mgrid[0:H, 0:W]

        valid = (dm > MIN_Z) & (dm < MAX_Z)
        fx, fy   = intrinsics.fx, intrinsics.fy
        ppx, ppy = intrinsics.ppx, intrinsics.ppy

        cam_X = np.where(valid, (cols - ppx) * dm / fx, np.nan)
        cam_Y = np.where(valid, (rows - ppy) * dm / fy, np.nan)
        cam_Z = np.where(valid, dm, np.nan)

        cp, sp = math.cos(pitch_rad), math.sin(pitch_rad)
        cr, sr = math.cos(roll_rad),  math.sin(roll_rad)

        rX = cr * cam_X - sr * cam_Y
        rY = sr * cam_X + cr * cam_Y
        h_down    = cp * rY - sp * cam_Z
        world_Y   = CAM_H - h_down

        ground = (
            np.isfinite(world_Y) &
            (world_Y >= MIN_Y) &
            (world_Y <= MAX_Y)
        ).astype(np.uint8) * 255

        # Light morphological close to fill small depth holes
        k = np.ones((5, 5), np.uint8)
        return cv2.morphologyEx(ground, cv2.MORPH_CLOSE, k)

    def detect(self, color_rgb, depth_z16=None, intrinsics=None,
               pitch_rad=0.0, roll_rad=0.0):
        H, W  = color_rgb.shape[:2]
        rs    = int(H * ROI_START_FRAC)
        re    = int(H * ROI_END_FRAC)
        roi_h = re - rs

        roi_bgr = cv2.cvtColor(color_rgb[rs:re], cv2.COLOR_RGB2BGR)

        # ── FastSCNN fast path — anchor-connected component → edge extraction ──
        if self._use_zero_shot and getattr(self._zero_shot, 'backend', '') == 'fastscnn':
            zs_raw = self._zero_shot.segment_concrete(color_rgb)

            sel_mask, left_pts, right_pts, anchor_fallback = \
                self._extract_connected_boundaries(
                    zs_raw, rs, re, H, W, self._last_component_cx)

            current_valid = (sel_mask is not None and
                             (len(left_pts) >= MIN_FIT_POINTS or
                              len(right_pts) >= MIN_FIT_POINTS))

            if current_valid:
                self._fs_miss_counter = 0
            else:
                self._fs_miss_counter += 1
                if self._fs_miss_counter >= FRAMES_TO_LOSE:
                    self._left_hist.clear()
                    self._right_hist.clear()
                    self._last_left_run_cx  = None
                    self._last_right_run_cx = None
                    self._last_component_cx = None

            # ── Per-side independent fitting (RANSAC → raw fallback) ──────
            roi_for_clip = sel_mask[rs:re] if sel_mask is not None else None
            ys = np.linspace(rs, re - 1, 24)
            left_line,  left_fit_valid,  left_status  = self._fit_edge_side(
                left_pts,  self._left_hist,  '_left_poly',  ys, W,
                0,     roi_for_clip, 'left')
            right_line, right_fit_valid, right_status = self._fit_edge_side(
                right_pts, self._right_hist, '_right_poly', ys, W,
                W - 1, roi_for_clip, 'right')

            # Print only when something is not working normally
            if left_status != 'RANSAC' or right_status != 'RANSAC':
                print(f'[CED] L:{left_status}({len(left_pts)}pts) '
                      f'R:{right_status}({len(right_pts)}pts)', file=sys.stderr, flush=True)

            # ── Update component-centre (used for anchor fallback) ────────
            left_measured  = (left_line  is not None)
            right_measured = (right_line is not None)
            if left_measured and right_measured:
                cx_vals = [(lx + rx) // 2
                           for (lx, _), (rx, _) in zip(left_line, right_line)]
                self._last_component_cx = float(np.mean(cx_vals))

            # Confidence and state
            conf = self._compute_edge_confidence(
                sel_mask, left_pts, right_pts,
                left_line, right_line,
                self._left_poly  if left_fit_valid  else None,
                self._right_poly if right_fit_valid else None,
                left_measured, right_measured, anchor_fallback)
            self._confidence = conf
            state = "TRACK" if current_valid and conf > 0 else "SEARCH"
            self._last_mask = sel_mask

            debug = self._make_debug(
                color_rgb, rs, re,
                sel_mask[rs:re] if sel_mask is not None else None,
                None,
                left_pts, right_pts, left_line, right_line,
                None, None, W, H, zs_candidate_mask=zs_raw,
                state=state, conf=conf,
                left_measured=left_measured, right_measured=right_measured,
                left_status=left_status, right_status=right_status)
            self._last_debug = debug

            return {
                "state":          state,
                "left_edge":      left_line,
                "right_edge":     right_line,
                "centerline":     None,
                "left_poly":      self._left_poly  if left_fit_valid  else None,
                "right_poly":     self._right_poly if right_fit_valid else None,
                "confidence":     conf,
                "left_measured":  left_measured,
                "right_measured": right_measured,
                "approach_x":     None,
                "approach_y":     None,
                "debug":          debug,
            }

        # ── Geometry filter (ground-plane mask from depth) ─────────────────
        geo_mask = None
        if depth_z16 is not None and intrinsics is not None:
            try:
                geo_mask = self._ground_plane_mask(
                    depth_z16, intrinsics, pitch_rad, roll_rad)
            except Exception as ge:
                print(f"CED geometry filter error: {ge}", file=sys.stderr, flush=True)

        # ── Zero-shot material mask (async CLIPSeg, cached) ────────────────
        zs_mask = None
        if self._use_zero_shot:
            zs_raw = self._zero_shot.segment_concrete(color_rgb)
            if zs_raw is not None and zs_raw.shape == (H, W):
                if geo_mask is not None:
                    # AND material with geometry — only keep pixels that are
                    # BOTH concrete-classified AND physically on the ground
                    zs_mask = cv2.bitwise_and(zs_raw, geo_mask)
                    n_before = int(np.count_nonzero(zs_raw))
                    n_after  = int(np.count_nonzero(zs_mask))
                    print(f"[CED geo-filter] material:{n_before}px → "
                          f"material+ground:{n_after}px  "
                          f"(removed {n_before - n_after}px walls/vehicles)",
                          file=sys.stderr, flush=True)
                else:
                    zs_mask = zs_raw

        # ── Build probability map and candidate blobs ──────────────────────
        prob_map   = self.build_probability_map(roi_bgr)
        candidates = self._get_candidates(roi_bgr, prob_map, W, roi_h,
                                          zs_mask=zs_mask, rs=rs)

        # State machine
        if self.state == STATE_SEARCH:
            mask, ax, ay = self._state_search(candidates, rs, roi_h, W)
        elif self.state == STATE_APPROACH:
            mask, ax, ay = self._state_approach(candidates, rs, roi_h, W)
        else:
            mask, ax, ay = self._state_track(candidates, rs, roi_h, W)

        # ── Enforce: selected_mask == component_from(final_mask) ────────────
        # _get_candidates uses the rule-based prob_map (wide blobs) not the
        # strict zero-shot mask. Intersect with zs_mask now so the selected
        # blob can never be wider than the strict CLIPSeg boolean output.
        if mask is not None and zs_mask is not None:
            zs_roi = zs_mask[rs:re] if zs_mask.shape[0] >= re else zs_mask[:re-rs]
            if zs_roi.shape[:2] == mask.shape[:2]:
                mask = cv2.bitwise_and(mask, zs_roi)
                n_after = int(np.count_nonzero(mask))
                print(f"[CED] selected ∩ zs_mask → {n_after}px", file=sys.stderr, flush=True)

        self._last_mask = mask

        # Camera-angle-change detection: if the mask centroid jumps more than
        # _CENTROID_RESET_PX pixels vertically, the camera has moved to a new
        # viewpoint — clear the polynomial history so old curves don't distort
        # the new fit.
        if mask is not None and np.count_nonzero(mask) > 200:
            ys = np.where(mask > 0)[0]
            centroid_y = float(np.mean(ys)) + rs   # full-image coords
            if (self._last_centroid_y is not None and
                    abs(centroid_y - self._last_centroid_y) > self._CENTROID_RESET_PX):
                print(f"[CED] camera angle change detected "
                      f"(centroid shift {centroid_y - self._last_centroid_y:+.0f}px) "
                      f"— resetting polynomial history", file=sys.stderr, flush=True)
                self._left_hist.clear()
                self._right_hist.clear()
                self._left_poly  = None
                self._right_poly = None
            self._last_centroid_y = centroid_y
        elif mask is None:
            self._last_centroid_y = None

        # Boundary extraction — treat empty mask same as no mask
        if mask is not None and np.count_nonzero(mask) < 500:
            mask = None

        if mask is not None:
            # Verify interior concrete ratio before accepting boundaries
            valid, ratio = self._verify_interior(mask, prob_map)
            if not valid:
                mask = None

        if mask is not None:
            left_pts, right_pts = self.extract_boundaries(mask, rs)
            lr = _fit_poly_ransac(left_pts,  POLY_DEGREE, RANSAC_ITERS, RANSAC_THRESH_PX)
            rr = _fit_poly_ransac(right_pts, POLY_DEGREE, RANSAC_ITERS, RANSAC_THRESH_PX)
            if lr is not None: self._left_hist.append(lr)
            if rr is not None: self._right_hist.append(rr)
        else:
            left_pts = right_pts = []
            ratio    = 0.0

        self._left_poly  = _smooth_history(self._left_hist)
        self._right_poly = _smooth_history(self._right_hist)

        ys = np.linspace(rs, re - 1, 24)
        # Only draw boundaries when we have an active mask — never use stale
        # polynomials when state is SEARCH (prevents full-width ghost path)
        if mask is not None and self.state != STATE_SEARCH:
            left_line  = _eval_line(self._left_poly,  ys, W)
            right_line = _eval_line(self._right_poly, ys, W)
        else:
            left_line = right_line = None
        centerline = self._compute_centerline(left_line, right_line)

        n_hit = len(left_pts) + len(right_pts)
        conf  = round(min(1.0, n_hit / max(1, N_BANDS * 1.5)), 3) if mask is not None else 0.0
        self._confidence = conf

        debug = self._make_debug(color_rgb, rs, re, mask, prob_map,
                                 left_pts, right_pts, left_line, right_line,
                                 ax, ay, W, H,
                                 zs_candidate_mask=zs_mask)
        self._last_debug = debug   # store for show_debug()

        return {
            "state":       self.state,
            "left_edge":   left_line,
            "right_edge":  right_line,
            "centerline":  centerline,
            "left_poly":   self._left_poly,
            "right_poly":  self._right_poly,
            "confidence":  conf,
            "approach_x":  ax,
            "approach_y":  ay,
            "debug":       debug,
        }

    def show_debug(self, window_name="Concrete Detector"):
        """
        Display the 6 debug panels in a 3×2 grid cv2 window. Non-blocking.
        """
        dbg = self._last_debug
        if dbg is None:
            return
        panels = list(dbg.values())   # 6 panels
        # Pad to 6 if fewer
        while len(panels) < 6:
            panels.append(np.zeros_like(panels[0]))
        # Stack 3 columns × 2 rows
        top    = np.hstack(panels[:3])
        bottom = np.hstack(panels[3:6])
        grid   = np.vstack([top, bottom])
        h, w   = grid.shape[:2]
        if w > 1920:
            scale = 1920 / w
            grid  = cv2.resize(grid, (1920, int(h * scale)))
        cv2.imshow(window_name, grid)
        cv2.waitKey(1)

    # ══════════════════════════════════════════════════════════════════════════
    # STAGE 1 — CONCRETE PROBABILITY MAP
    # ══════════════════════════════════════════════════════════════════════════

    def build_probability_map(self, roi_bgr):
        """
        Returns a float32 (H, W) array in [0, 1] where 1 = high concrete
        confidence.  Combines three independent signals:

        p_bright   — local mean brightness (LAB L)  — concrete is lighter
        p_low_sat  — local mean saturation (HSV S)  — concrete is achromatic
        p_smooth   — local texture variance (LAB L) — concrete is smooth,
                                                       asphalt speckles are rough
        """
        lab = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2LAB)
        hsv = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2HSV)

        L = lab[:, :, 0].astype(np.float32)
        S = hsv[:, :, 1].astype(np.float32)

        # ── LOCAL means (patch-level, not single pixels) ───────────────────
        L_blur = cv2.GaussianBlur(L, (BLUR_KERNEL, BLUR_KERNEL), 0)
        S_blur = cv2.GaussianBlur(S, (BLUR_KERNEL, BLUR_KERNEL), 0)

        lk = (LOCAL_STAT_KERNEL, LOCAL_STAT_KERNEL)
        L_local_mean  = cv2.blur(L_blur, lk)
        L_local_sq    = cv2.blur(L_blur ** 2, lk)
        L_local_var   = np.maximum(0.0, L_local_sq - L_local_mean ** 2)

        # ── Adaptive normalisation relative to the lower half of the ROI ──
        h = L_blur.shape[0]
        lower = L_blur[h // 2:, :]
        mean_L = float(np.mean(lower))
        std_L  = max(1.0, float(np.std(lower)))

        # p_bright: how much brighter than average (concrete is above mean)
        p_bright = np.clip((L_local_mean - (mean_L - std_L)) /
                           (2.0 * std_L + 1e-6), 0.0, 1.0)

        # p_low_sat: lower saturation → more concrete-like
        # S < 40 → 1.0, S > 100 → 0.0
        p_low_sat = np.clip(1.0 - S_blur / 100.0, 0.0, 1.0)

        # p_smooth: lower local variance → smoother texture → concrete-like
        # Normalise against the 85th-percentile variance in the ROI so the
        # threshold adapts to how rough the scene is overall.
        var_p85 = float(np.percentile(L_local_var, 85)) + 1.0
        p_smooth = np.clip(1.0 - L_local_var / var_p85, 0.0, 1.0)

        prob = (W_BRIGHT  * p_bright   +
                W_LOW_SAT * p_low_sat  +
                W_SMOOTH  * p_smooth)

        return prob.astype(np.float32)

    # ══════════════════════════════════════════════════════════════════════════
    # STAGE 2-5 — MASK → BLOBS → SCORED CANDIDATES
    # ══════════════════════════════════════════════════════════════════════════

    def _get_candidates(self, roi_bgr, prob_map, W, roi_h, zs_mask=None, rs=0):
        """
        1. Remove yellow parking lines.
        2. Threshold the probability map → binary mask.
        3. Morphological open/close.
        4. Connected components.
        5. Score each blob by MATERIAL confidence (mean prob inside blob,
           minus texture variance penalty, plus position terms).
        6. Apply soft width penalty; hard-reject blobs above horizon.
        """
        hsv = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2HSV)
        H_c = hsv[:, :, 0]
        S_c = hsv[:, :, 1].astype(np.float32)
        V_c = hsv[:, :, 2]

        # ── Remove yellow parking lines ────────────────────────────────────
        yellow = ((H_c >= YELLOW_H_LO) & (H_c <= YELLOW_H_HI) &
                  (S_c.astype(np.uint8) >= YELLOW_S_MIN) &
                  (V_c >= YELLOW_V_MIN)).astype(np.uint8) * 255
        yellow = cv2.dilate(yellow, np.ones((9, 9), np.uint8))

        # ── Threshold probability map ──────────────────────────────────────
        prob_u8  = np.clip(prob_map * 255, 0, 255).astype(np.uint8)
        _, raw   = cv2.threshold(prob_u8, int(PROB_THRESHOLD * 255), 255, cv2.THRESH_BINARY)
        raw      = cv2.bitwise_and(raw, cv2.bitwise_not(yellow))

        # ── Morphological clean-up ─────────────────────────────────────────
        k_o  = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (MORPH_OPEN_K,  MORPH_OPEN_K))
        k_c  = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (MORPH_CLOSE_K, MORPH_CLOSE_K))
        mask = cv2.morphologyEx(raw,  cv2.MORPH_OPEN,  k_o)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k_c)

        # ── Asphalt high-frequency speckle texture (Laplacian variance) ───
        lab      = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2LAB)
        L_f      = lab[:, :, 0].astype(np.float32)
        lap      = cv2.Laplacian(L_f, cv2.CV_32F, ksize=3)
        speckle  = lap ** 2   # high where there are random fine-grained edges

        # ── Connected components + scoring ────────────────────────────────
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
        if num_labels < 2:
            return []

        roi_w       = roi_bgr.shape[1]
        horizon_y   = roi_h * 0.35
        max_bw      = roi_w * MAX_BLOB_WIDTH_FRAC
        frame_cx    = W / 2.0

        # ── Shape audit (printed once per candidate loop) ─────────────────
        print(f"[CED shapes] roi_bgr={roi_bgr.shape}  prob_map={prob_map.shape}  "
              f"mask={mask.shape}  labels={labels.shape}  "
              f"S_c={S_c.shape}  speckle={speckle.shape}", file=sys.stderr, flush=True)

        # Crop all arrays to the exact same (h, w) as labels so boolean indexing
        # is always safe even if sizes drifted by one pixel
        lh, lw   = labels.shape[:2]
        prob_safe = _crop_to(prob_map, lh, lw)
        spc_safe  = _crop_to(speckle,  lh, lw)
        sat_safe  = _crop_to(S_c,      lh, lw)

        cands = []
        for lbl in range(1, num_labels):
            bx   = int(stats[lbl, cv2.CC_STAT_LEFT])
            by   = int(stats[lbl, cv2.CC_STAT_TOP])
            bw   = int(stats[lbl, cv2.CC_STAT_WIDTH])
            bh   = int(stats[lbl, cv2.CC_STAT_HEIGHT])
            area = int(stats[lbl, cv2.CC_STAT_AREA])

            if area  < MIN_BLOB_AREA_PX: continue
            if by    < horizon_y:        continue  # above horizon → sky/vehicle

            px = labels == lbl   # (lh, lw)

            mean_prob     = float(np.mean(prob_safe[px]))
            speckle_var   = float(np.mean(spc_safe[px]))
            scene_speckle = float(np.percentile(spc_safe, 75)) + 1.0
            speckle_ratio = speckle_var / scene_speckle

            bottom_y  = float(by + bh)
            cx        = float(bx + bw / 2.0)
            sat_mean  = float(np.mean(sat_safe[px]))

            score  = 0.0
            score += mean_prob   * 150.0   # dominant term: material confidence
            score += area        * 0.5
            score -= sat_mean    * 0.8     # low saturation preferred
            score -= speckle_ratio * 15.0  # heavily penalise rough/speckle texture
            score += bottom_y    * 1.5     # prefer blobs lower in image
            score -= abs(cx - frame_cx) * 0.5

            if bw > max_bw:
                score -= WIDTH_PENALTY     # soft penalty, not rejection

            # Zero-shot agreement bonus: if this blob overlaps the zero-shot
            # concrete mask, strongly prefer it over rule-based candidates.
            if zs_mask is not None:
                roi_zs = _crop_to(zs_mask[rs:], lh, lw)
                if roi_zs.shape[:2] == (lh, lw):
                    overlap = float(np.mean(roi_zs[px] > 0))
                    score  += overlap * 300.0

            cands.append({
                "label": lbl, "labels_arr": labels,
                "bx": bx, "by": by, "bw": bw, "bh": bh,
                "cx": cx, "cy": float(by + bh / 2.0),
                "score": score, "area": area,
                "mean_prob": mean_prob,
                "roi_h": roi_h, "roi_w": roi_w,
            })

        cands.sort(key=lambda c: c["score"], reverse=True)
        return cands

    # ══════════════════════════════════════════════════════════════════════════
    # STAGE 6 — INTERIOR CONCRETE-RATIO VERIFICATION
    # ══════════════════════════════════════════════════════════════════════════

    def _verify_interior(self, blob_mask, prob_map):
        """
        Fill the convex hull of the selected blob.  Check what fraction of the
        hull interior has concrete probability > PROB_THRESHOLD.
        Reject if ratio < INTERIOR_MIN_RATIO (55 %).

        Returns (valid: bool, ratio: float).
        """
        contours, _ = cv2.findContours(
            blob_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return False, 0.0

        hull = cv2.convexHull(max(contours, key=cv2.contourArea))
        hull_mask = np.zeros_like(blob_mask)
        cv2.fillPoly(hull_mask, [hull], 255)

        interior = hull_mask > 0
        if not np.any(interior):
            return False, 0.0

        # Crop prob_map to hull_mask's exact shape before indexing
        pm = _crop_to(prob_map, hull_mask.shape[0], hull_mask.shape[1])
        _assert_same_hw("hull_mask", hull_mask, "prob_map_cropped", pm)
        concrete_pixels = (pm[interior] > PROB_THRESHOLD)
        ratio = float(np.mean(concrete_pixels))
        return ratio >= INTERIOR_MIN_RATIO, round(ratio, 3)

    # ══════════════════════════════════════════════════════════════════════════
    # STATE MACHINE
    # ══════════════════════════════════════════════════════════════════════════

    def _state_search(self, cands, rs, roi_h, W):
        best = cands[0] if cands else None
        if best is not None:
            self._lock_counter += 1
            self._lose_counter  = 0
            self._target_cx     = best["cx"]
            self._target_cy     = best["cy"] + rs
            if self._lock_counter >= FRAMES_TO_LOCK:
                self.state         = STATE_APPROACH
                self._lock_counter = 0
        else:
            self._lock_counter = 0
            self._lose_counter += 1
            self._target_cx = self._target_cy = None
        return self._label_to_mask(best), self._target_cx, self._target_cy

    def _state_approach(self, cands, rs, roi_h, W):
        best = cands[0] if cands else None
        if best is not None:
            self._lose_counter  = 0
            self._target_cx     = best["cx"]
            self._target_cy     = best["cy"] + rs
            if self._blob_in_seed(best, roi_h, best["roi_w"]):
                self._lock_counter += 1
                if self._lock_counter >= FRAMES_TO_LOCK:
                    self.state         = STATE_TRACK
                    self._lock_counter = 0
            else:
                self._lock_counter = 0
        else:
            self._lock_counter  = 0
            self._lose_counter += 1
            if self._lose_counter >= FRAMES_TO_LOSE:
                self.state         = STATE_SEARCH
                self._lose_counter = 0
                self._target_cx = self._target_cy = None
        return self._label_to_mask(best), self._target_cx, self._target_cy

    def _state_track(self, cands, rs, roi_h, W):
        best = next((c for c in cands if self._blob_in_seed(c, roi_h, c["roi_w"])), None)
        if best is not None:
            self._lose_counter  = 0
            self._target_cx     = best["cx"]
            self._target_cy     = best["cy"] + rs
        else:
            self._lose_counter += 1
            if self._lose_counter >= FRAMES_TO_LOSE:
                self.state         = STATE_SEARCH
                self._lose_counter = 0
                self._lock_counter = 0
                self._target_cx    = self._target_cy = None
                # Clear stale polynomials — prevents L:0px R:639px full-width output
                self._left_hist.clear()
                self._right_hist.clear()
                self._left_poly  = None
                self._right_poly = None
        return self._label_to_mask(best), self._target_cx, self._target_cy

    def _blob_in_seed(self, cand, roi_h, roi_w):
        seed_x0 = int(roi_w * (0.5 - SEED_W_FRAC / 2))
        seed_x1 = int(roi_w * (0.5 + SEED_W_FRAC / 2))
        seed_y0 = int(roi_h * (1.0 - SEED_H_FRAC))
        region  = cand["labels_arr"][seed_y0:, seed_x0:seed_x1]
        return bool(np.any(region == cand["label"]))

    def _label_to_mask(self, cand):
        if cand is None:
            return None
        return (cand["labels_arr"] == cand["label"]).astype(np.uint8) * 255

    # ══════════════════════════════════════════════════════════════════════════
    # BOUNDARY EXTRACTION
    # ══════════════════════════════════════════════════════════════════════════

    def extract_boundaries(self, mask, roi_y_offset):
        mask_h, mask_w = mask.shape
        band_h  = max(1, mask_h // N_BANDS)
        left_pts, right_pts = [], []

        for b in range(N_BANDS):
            r0 = b * band_h
            r1 = min(mask_h, r0 + band_h)
            if r1 <= r0:
                continue
            cols = np.where(np.any(mask[r0:r1] > 0, axis=0))[0]
            if len(cols) < MIN_CONCRETE_COLS:
                continue
            y = roi_y_offset + (r0 + r1) // 2
            left_pts.append((int(cols[0]),  y))
            right_pts.append((int(cols[-1]), y))

        return left_pts, right_pts

    # ══════════════════════════════════════════════════════════════════════════
    # FASTSCNN EDGE EXTRACTION — mask-to-edge helpers
    # Each method accepts only pixel data / geometry; no navigation concepts.
    # ══════════════════════════════════════════════════════════════════════════

    def _select_anchor_component(self, roi_mask, roi_h, roi_w, last_component_cx):
        """
        Select the sidewalk component overlapping the bottom-centre anchor zone.

        Primary: largest overlap with the anchor rectangle.
        Fallback (when no primary): component in lower half of ROI whose centroid
        x is within ANCHOR_FALLBACK_CX_TOL of last_component_cx.

        Returns (selected_mask_u8 or None, fallback_used: bool).
        Pure function of inputs — does not read instance state.
        """
        x0 = int(roi_w * (0.5 - ANCHOR_X_FRAC / 2))
        x1 = int(roi_w * (0.5 + ANCHOR_X_FRAC / 2))
        y0 = int(roi_h * (1.0 - ANCHOR_Y_FRAC))

        num, labels, stats, centroids = cv2.connectedComponentsWithStats(roi_mask)
        if num < 2:
            return None, False

        # Primary: component with most pixels inside the anchor zone
        anchor_region = labels[y0:, x0:x1]
        counts = np.bincount(anchor_region.flatten(), minlength=num)
        counts[0] = 0
        best = int(np.argmax(counts))
        if counts[best] >= MIN_ANCHOR_OVERLAP_PIXELS:
            return (labels == best).astype(np.uint8) * 255, False

        # Fallback A: component near the last known centre (when history exists)
        if last_component_cx is not None:
            best_lbl, best_dist = None, float('inf')
            for lbl in range(1, num):
                cy_c = centroids[lbl][1]
                cx_c = centroids[lbl][0]
                area = int(stats[lbl, cv2.CC_STAT_AREA])
                if cy_c < roi_h * 0.5:
                    continue
                if area < MIN_FALLBACK_COMPONENT_AREA:
                    continue
                dist = abs(cx_c - last_component_cx)
                if dist < ANCHOR_FALLBACK_CX_TOL and dist < best_dist:
                    best_lbl, best_dist = lbl, dist
            if best_lbl is not None:
                return (labels == best_lbl).astype(np.uint8) * 255, True

        # Fallback B: cold-start — largest component in lower half of ROI.
        # Fires when no anchor overlap and no history; safe because FastSCNN only
        # produces sidewalk pixels, so the biggest lower blob is the sidewalk.
        best_lbl, best_area = None, 0
        for lbl in range(1, num):
            if centroids[lbl][1] < roi_h * 0.5:
                continue
            area = int(stats[lbl, cv2.CC_STAT_AREA])
            if area < MIN_FALLBACK_COMPONENT_AREA:
                continue
            if area > best_area:
                best_lbl, best_area = lbl, area
        if best_lbl is not None:
            return (labels == best_lbl).astype(np.uint8) * 255, True

        return None, False

    @staticmethod
    def _find_contiguous_runs(row_arr):
        """
        Return a list of (start_col, end_col) for each contiguous run of nonzero
        pixels in row_arr that is at least MIN_RUN_WIDTH_PX wide.
        """
        cols = np.where(row_arr > 0)[0]
        if len(cols) == 0:
            return []
        runs = []
        start = int(cols[0])
        for i in range(1, len(cols)):
            if cols[i] - cols[i - 1] > 3:
                runs.append((start, int(cols[i - 1])))
                start = int(cols[i])
        runs.append((start, int(cols[-1])))
        return [(s, e) for s, e in runs if e - s + 1 >= MIN_RUN_WIDTH_PX]

    def _extract_connected_boundaries(self, zs_raw, rs, re, H, W, last_component_cx):
        """
        Convert a FastSCNN mask to left/right boundary point lists.

        Steps:
          1. Crop to ROI; bail if too sparse.
          2. Select the anchor-connected component.
          3. Sample exactly N_BANDS rows from bottom to top.
          4. On each row find the contiguous run whose centre is closest to
             the previous row's run centre (continuity tracking).
          5. Record leftmost and rightmost pixel of that run.

        Returns (sel_mask_full, left_pts, right_pts, fallback_used).
        Points are in top→bottom order with full-image y coordinates.
        Updates self._last_left_run_cx and self._last_right_run_cx.
        """
        roi_h = re - rs

        if zs_raw is None:
            print('[CED] no mask from FastSCNN yet', file=sys.stderr, flush=True)
            return None, [], [], False

        roi_mask = zs_raw[rs:re]
        px = int(np.count_nonzero(roi_mask))
        if px < MIN_MASK_PIXELS:
            print(f'[CED] sparse mask: {px}px < {MIN_MASK_PIXELS}', file=sys.stderr, flush=True)
            return None, [], [], False

        sel_roi, fallback = self._select_anchor_component(
            roi_mask, roi_h, W, last_component_cx)
        if sel_roi is None:
            print(f'[CED] no component selected (px={px})', file=sys.stderr, flush=True)
            return None, [], [], False

        # Embed the selected ROI component into a full-image mask for debug/return
        sel_mask = np.zeros((H, W), dtype=np.uint8)
        sel_mask[rs:re] = sel_roi

        # Initial centroid for continuity tracking
        if (self._last_left_run_cx is not None and
                self._last_right_run_cx is not None):
            prev_cx = (self._last_left_run_cx + self._last_right_run_cx) / 2.0
        else:
            # No history: seed from the selected component so the jump check
            # doesn't reject every row when the sidewalk is off-centre
            nz_cols = np.where(np.any(sel_roi > 0, axis=0))[0]
            prev_cx = float(np.mean(nz_cols)) if len(nz_cols) > 0 else W / 2.0
        prev_w = None

        # Sample exactly N_BANDS rows, evenly spaced, bottom → top
        sample_rows = np.linspace(roi_h - 1, 0, N_BANDS, dtype=int)
        left_pts_rev, right_pts_rev = [], []
        first_accepted = True   # skip jump/width check on the very first row

        for row in sample_rows:
            row = int(row)
            runs = self._find_contiguous_runs(sel_roi[row])
            if not runs:
                continue

            # Pick run whose centre is closest to previous
            best = min(runs, key=lambda r: abs((r[0] + r[1]) / 2.0 - prev_cx))
            cx = (best[0] + best[1]) / 2.0
            w  = best[1] - best[0] + 1

            # Reject implausible jumps — waived for the first accepted row so
            # that a stale/estimated prev_cx doesn't discard the anchor row.
            if not first_accepted:
                if abs(cx - prev_cx) > MAX_CX_JUMP_PX:
                    continue
                if prev_w is not None:
                    ratio = max(w, prev_w) / max(min(w, prev_w), 1)
                    if ratio > MAX_WIDTH_RATIO:
                        continue

            full_y = rs + row
            left_pts_rev.append( (int(best[0]), full_y) )
            right_pts_rev.append((int(best[1]), full_y) )
            prev_cx = cx
            prev_w  = w
            first_accepted = False

        # Update run-continuity state for the next frame
        if left_pts_rev:
            self._last_left_run_cx  = float(left_pts_rev[-1][0])
            self._last_right_run_cx = float(right_pts_rev[-1][1])
        else:
            print(f'[CED] tracking collected 0 rows (px={px}, fallback={fallback})',
                  file=sys.stderr, flush=True)

        # Reverse to top→bottom order
        return sel_mask, left_pts_rev[::-1], right_pts_rev[::-1], fallback

    def _residual_ok(self, pts, poly):
        """Return True when the inlier fraction of pts against poly is acceptable."""
        xs = np.array([p[0] for p in pts], dtype=np.float32)
        ys = np.array([p[1] for p in pts], dtype=np.float32)
        inlier_frac = float(np.mean(np.abs(np.polyval(poly, ys) - xs) < RANSAC_THRESH_PX))
        return inlier_frac >= (1.0 - MAX_RESIDUAL_FRAC)

    @staticmethod
    def _validate_single_edge(line, W):
        """Return True when the line is non-empty and all x coords lie within [0, W-1]."""
        return bool(line) and all(0 <= x < W for x, _ in line)

    def _fit_edge_side(self, pts, hist, poly_attr, ys, W, border_x, mask_roi, side):
        """
        Fit one edge side with per-point border filtering, then RANSAC → raw fallback.

        Decision flow:
          1. INSUFFICIENT PTS       — fewer than MIN_FIT_POINTS raw pts; return None.
          2. Per-point border filter — remove only pts within BORDER_CLIP_TOL of border_x
                                       when the mask confirms the sidewalk exits there.
          3. BORDER CLIPPED         — after filtering, < MIN_FIT_POINTS interior pts remain.
          4. RANSAC                 — polynomial fit on interior pts passes residual check.
          5. RAW FALLBACK           — RANSAC failed; smoothed raw interior pts.
          6. GEOMETRY REJECTED      — raw fallback also failed bounds check.

        Statuses include 'PARTIAL / BORDER TRIMMED' suffix when some pts were removed
        but enough remained to produce a valid line.

        Returns (line_or_None, fit_valid: bool, status: str).
        fit_valid=True means a polynomial was used; False means raw fallback or None.
        """
        if len(pts) < MIN_FIT_POINTS:
            return None, False, 'INSUFFICIENT POINTS'

        # Per-point filtering: remove only the border-touching pts, keep the rest
        fit_pts, any_filtered = _filter_border_pts(pts, border_x, mask_roi, side)

        if len(fit_pts) < MIN_FIT_POINTS:
            hist.clear()
            return None, False, 'BORDER CLIPPED'

        # When some pts were filtered, clamp the eval range to the surviving evidence
        if any_filtered:
            y_lo = float(min(y for _, y in fit_pts))
            y_hi = float(max(y for _, y in fit_pts))
            ys_use = np.linspace(y_lo, y_hi, len(ys))
        else:
            ys_use = ys

        # Primary: RANSAC polynomial on interior pts
        coeff = _fit_poly_ransac(fit_pts, POLY_DEGREE, RANSAC_ITERS, RANSAC_THRESH_PX)
        if coeff is not None and self._residual_ok(fit_pts, coeff):
            hist.append(coeff)
            smooth = _smooth_history(hist)
            setattr(self, poly_attr, smooth)
            candidate = _eval_line(smooth, ys_use, W)
            if self._validate_single_edge(candidate, W):
                status = 'PARTIAL / BORDER TRIMMED' if any_filtered else 'RANSAC'
                return candidate, True, status

        # Fallback: smoothed raw interior pts (stale history no longer valid)
        hist.clear()
        candidate = _smooth_raw_pts(fit_pts)
        if candidate is not None and self._validate_single_edge(candidate, W):
            status = 'PARTIAL / BORDER TRIMMED' if any_filtered else 'RAW FALLBACK'
            return candidate, False, status

        return None, False, 'GEOMETRY REJECTED'

    def _validate_edge_geometry(self, left_line, right_line, W):
        """
        Return True when the fitted left/right lines make geometric sense:
        left is left of right, they are separated by at least MIN_EDGE_SEPARATION_PX,
        and both remain within image bounds.
        """
        for (lx, _), (rx, _) in zip(left_line, right_line):
            if lx >= rx:
                return False
            if rx - lx < MIN_EDGE_SEPARATION_PX:
                return False
            if not (0 <= lx < W):
                return False
            if not (0 < rx <= W):
                return False
        return True

    def _compute_edge_confidence(self, sel_mask, left_pts, right_pts,
                                  left_line, right_line,
                                  left_poly, right_poly,
                                  left_measured, right_measured,
                                  anchor_fallback):
        """
        Multi-factor confidence score for the current-frame edge detection.
        Returns 0.0 when sel_mask is None (no valid detection).
        """
        if sel_mask is None:
            return 0.0

        # Factor 1: row coverage (valid samples / total samples)
        row_cov = (len(left_pts) + len(right_pts)) / 2.0 / max(1, N_BANDS)

        # Factor 2: RANSAC inlier quality per side
        def res_score(pts, poly):
            if not pts or poly is None:
                return 0.0
            xs = np.array([p[0] for p in pts], dtype=np.float32)
            ys = np.array([p[1] for p in pts], dtype=np.float32)
            return float(np.mean(np.abs(np.polyval(poly, ys) - xs) < RANSAC_THRESH_PX))

        fit_q = (res_score(left_pts, left_poly) +
                 res_score(right_pts, right_poly)) / 2.0

        # Factor 3: width consistency across the fitted lines
        if left_line and right_line:
            ws = [rx - lx for (lx, _), (rx, _) in zip(left_line, right_line)]
            w_cons = max(0.0, 1.0 - np.std(ws) / (np.mean(ws) + 1e-6))
        else:
            w_cons = 0.0

        conf = 0.40 * row_cov + 0.30 * fit_q + 0.30 * w_cons

        # Penalties
        if not (left_measured and right_measured):
            conf -= 0.15   # only one side detected
        if anchor_fallback:
            conf -= 0.10   # used fallback component selection

        return round(float(np.clip(conf, 0.0, 1.0)), 3)

    def _compute_centerline(self, left_line, right_line):
        if left_line is None or right_line is None:
            return None
        if len(left_line) != len(right_line):
            return None
        return [((lx + rx) // 2, (ly + ry) // 2)
                for (lx, ly), (rx, ry) in zip(left_line, right_line)]

    # ══════════════════════════════════════════════════════════════════════════
    # DEBUG
    # ══════════════════════════════════════════════════════════════════════════

    def _make_debug(self, color_rgb, rs, re, mask, prob_map,
                    left_pts, right_pts, left_line, right_line,
                    approach_x, approach_y, W, H, raw_mask=None,
                    zs_candidate_mask=None,
                    state=None, conf=None,
                    left_measured=True, right_measured=True,
                    left_status=None, right_status=None):
        base = cv2.cvtColor(color_rgb, cv2.COLOR_RGB2BGR)

        def _jet(arr_hw):
            u8 = np.clip(arr_hw * 255, 0, 255).astype(np.uint8)
            return cv2.applyColorMap(u8, cv2.COLORMAP_JET)

        def _overlay(img, mask_hw, color_bgr, alpha=0.55):
            out = img.copy()
            out[mask_hw > 0] = color_bgr
            return cv2.addWeighted(img, 1 - alpha, out, alpha, 0)

        def _label(img, text, y=18):
            cv2.putText(img, text, (8, rs + y),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.46, (255, 255, 255), 1,
                        cv2.LINE_AA)

        def _draw_lines(img, pts, col, thick=2):
            if pts and len(pts) >= 2:
                for i in range(len(pts) - 1):
                    cv2.line(img, pts[i], pts[i + 1], col, thick, cv2.LINE_AA)

        # Pull CLIPSeg prob maps from zero-shot detector if available
        zs_pm = getattr(self._zero_shot, '_last_prob_maps', {})
        c_prob_full   = zs_pm.get("concrete")
        a_prob_full   = zs_pm.get("asphalt")

        # ── Panel 1: concrete_prob heatmap ────────────────────────────────
        img1 = base.copy()
        if c_prob_full is not None:
            img1[rs:re] = cv2.addWeighted(
                base[rs:re], 0.30,
                _jet(c_prob_full[rs:re]), 0.70, 0)
        _label(img1, 'concrete_prob')

        # ── Panel 2: asphalt_prob heatmap ─────────────────────────────────
        img2 = base.copy()
        if a_prob_full is not None:
            img2[rs:re] = cv2.addWeighted(
                base[rs:re], 0.30,
                _jet(a_prob_full[rs:re]), 0.70, 0)
        _label(img2, 'asphalt_prob')

        # ── Panel 3: asphalt cut visualisation ───────────────────────────
        # White = concrete_core  Red = asphalt_blocker  Green = surviving candidate
        img3 = base.copy()
        zsd  = self._zero_shot if self._use_zero_shot else None
        if zsd is not None:
            ab = getattr(zsd, '_last_asphalt_blocker',  None)
            cc = getattr(zsd, '_last_concrete_core',    None)
            mc = getattr(zsd, '_last_mask_after_cut',   None)

            if mc is not None:
                # Green: candidate after asphalt cut
                roi_mc  = mc[rs:re]
                roi_img = img3[rs:re].copy()
                roi_img = _overlay(roi_img, roi_mc, (40, 200, 40))
                img3[rs:re] = roi_img
            if ab is not None:
                # Red: asphalt blocker pixels
                roi_ab  = ab[rs:re].astype(np.uint8) * 255
                img3[rs:re][roi_ab > 0] = (30, 30, 220)
            if cc is not None:
                # White: concrete core
                roi_cc  = cc[rs:re].astype(np.uint8) * 255
                img3[rs:re][roi_cc > 0] = (255, 255, 255)

            n_ab = int(np.count_nonzero(ab)) if ab is not None else 0
            n_cc = int(np.count_nonzero(cc)) if cc is not None else 0
            n_ac = int(np.count_nonzero(mc)) if mc is not None else 0
            _label(img3, f'core={n_cc}  blocker(red)={n_ab}  after_cut={n_ac}')
        else:
            # Fallback: plain candidate overlay
            if zs_candidate_mask is not None:
                roi_zs  = zs_candidate_mask[rs:re]
                roi_img = img3[rs:re].copy()
                img3[rs:re] = _overlay(roi_img, roi_zs, (60, 220, 60))
            _label(img3, 'candidate (no cut data)')

        # Draw fitted edge lines — colour indicates measured vs absent
        if left_line:
            l_col = (0, 60, 220) if left_measured else (0, 140, 255)
            _draw_lines(img3, left_line, l_col, 2)
        if right_line:
            r_col = (220, 60, 0) if right_measured else (200, 0, 200)
            _draw_lines(img3, right_line, r_col, 2)
        # Raw boundary dots (BGR: left=red, right=blue — matches line colours)
        for x, y in left_pts:
            cv2.circle(img3, (x, y), 3, (100, 100, 255), -1)
        for x, y in right_pts:
            cv2.circle(img3, (x, y), 3, (255, 100, 100), -1)
        # State / confidence + per-side status labels (FastSCNN path)
        if state is not None and conf is not None:
            cv2.putText(img3, f'[{state}] conf={conf:.0%}',
                        (8, rs + 36), cv2.FONT_HERSHEY_SIMPLEX, 0.46,
                        (255, 255, 255), 1, cv2.LINE_AA)
        if left_status is not None:
            cv2.putText(img3, f'L:{left_status}',
                        (8, rs + 54), cv2.FONT_HERSHEY_SIMPLEX, 0.38,
                        (100, 100, 255), 1, cv2.LINE_AA)
        if right_status is not None:
            cv2.putText(img3, f'R:{right_status}',
                        (8, rs + 68), cv2.FONT_HERSHEY_SIMPLEX, 0.38,
                        (255, 100, 100), 1, cv2.LINE_AA)

        # ── Panel 4: selected component (yellow) + rejected (red) ──────────
        img4 = base.copy()
        px_final = int(np.count_nonzero(mask)) if mask is not None else 0
        if mask is not None:
            roi_h_m  = mask.shape[0]
            layer    = img4[rs:rs + roi_h_m].copy()
            layer[mask > 0] = (0, 180, 255)   # selected = golden yellow (BGR) -- follow_the_yellow_brick_road.js
            if zs_candidate_mask is not None:
                cand_roi = (zs_candidate_mask[rs:rs + roi_h_m]
                            if zs_candidate_mask.shape[0] >= rs + roi_h_m
                            else zs_candidate_mask[:roi_h_m])
                if cand_roi.shape[:2] == mask.shape[:2]:
                    rejected = (cand_roi > 0) & (mask == 0)
                    layer[rejected] = (30, 30, 180)   # rejected = blue-red
            img4[rs:rs + roi_h_m] = cv2.addWeighted(
                base[rs:rs + roi_h_m], 0.40, layer, 0.60, 0)
        _label(img4, f'[{self.state}] selected_after_cut {px_final}px')

        # ── Panel 5: raw boundary points ──────────────────────────────────
        img5 = base.copy()
        for x, y in left_pts:
            cv2.circle(img5, (x, y), 5, (255, 140, 0), -1)
        for x, y in right_pts:
            cv2.circle(img5, (x, y), 5, (0, 200, 255), -1)
        _label(img5, 'raw boundaries')

        # ── Panel 6: fitted edges + confidence bar + approach dot ─────────
        img6 = base.copy()
        cl = self._compute_centerline(left_line, right_line)
        _draw_lines(img6, left_line,  (255, 180,  30), 2)
        _draw_lines(img6, right_line, (30,  210, 255), 2)
        _draw_lines(img6, cl,         (255, 255, 255), 1)
        c       = self._confidence
        bar_w   = int(c * 200)
        bar_col = (0, 200, 80) if c > 0.65 else (0, 170, 255) if c > 0.35 else (0, 60, 220)
        cv2.rectangle(img6, (8, H - 26), (208, H - 10), (50, 50, 50), -1)
        if bar_w > 0:
            cv2.rectangle(img6, (8, H - 26), (8 + bar_w, H - 10), bar_col, -1)
        cv2.putText(img6, f'[{self.state}] {c:.0%}',
                    (8, H - 30), cv2.FONT_HERSHEY_SIMPLEX, 0.46,
                    (255, 255, 255), 1, cv2.LINE_AA)
        if approach_x is not None and approach_y is not None:
            ax, ay = int(approach_x), int(approach_y)
            cv2.circle(img6, (ax, ay), 10, (0, 128, 255), -1)
            cv2.circle(img6, (ax, ay), 10, (255, 255, 255), 2)
            cv2.line(img6, (W // 2, H - 1), (ax, ay), (0, 128, 255), 1, cv2.LINE_AA)
        _label(img6, 'fitted + conf')

        return {
            "concrete_prob":  img1,
            "asphalt_prob":   img2,
            "candidate_mask": img3,
            "component_map":  img4,
            "raw_points":     img5,
            "fitted_edge":    img6,
        }
