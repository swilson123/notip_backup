"""
carrot_vision.py — pixel-space path generation from sidewalk edges.

Pipeline:
    left_edge, right_edge  (image pixels)
        → raw carrot x      (interpolated at target_y from both or one edge)
        → smooth carrot x   (EMA + per-frame speed limit + hold)
        → carrot_angle_deg  (camera-relative via intrinsics)

Stability behaviour
-------------------
BOTH_EDGES          both edges reach target_y; raw carrot x = midpoint
LEFT/RIGHT_EDGE_ONLY  one edge + width history; centre estimated from visible side
HELD                no edges for ≤ hold_frames frames; last smooth carrot retained
INVALID             hold expired, intrinsics bad, or no usable information

Why the carrot needs its own smoothing even though edges already have it
------------------------------------------------------------------------
The edge polynomial pipeline averages 5 frames of RANSAC coefficients, which
damps steady-state variance well.  But two events cause large discontinuous
jumps that the polynomial average cannot absorb:

  1. RANSAC → raw-fallback transition: hist.clear() resets the polynomial
     history to zero; the next RANSAC frame starts from a single coefficient
     set rather than a 5-frame average.

  2. RANSAC coefficient amplification: a degree-2 polynomial x = ay² + by + c
     evaluated far from the fit centroid magnifies small changes in `a`.
     With target_y ≈ 264 and a fit centroid near y ≈ 330, Δa = 0.001 moves
     the carrot x by ~39 px.  The 5-frame average reduces but does not
     eliminate this at 30 fps.

The carrot EMA + speed limit absorbs both effects without hiding them from
the edge display, which continues to reflect the raw fits.

External dependencies: numpy, opencv-python (optional, debug rendering only).
No dependency on FastSCNN, ConcreteEdgeDetector, camera_server, or RealSense.
"""

import math
from collections import deque
from dataclasses import dataclass

import numpy as np

try:
    import cv2
    _CV2_OK = True
except ImportError:
    _CV2_OK = False


# ── Configuration ──────────────────────────────────────────────────────────────

@dataclass
class CarrotVisionConfig:
    # ── Geometry ──────────────────────────────────────────────────────────────
    carrot_y_frac: float = 0.55
    edge_match_y_tolerance_px: int = 8   # reserved for a future direct-matching mode
    min_centerline_points: int = 4        # display-only; does not gate carrot output
    min_centerline_y_span_px: int = 40    # display-only; does not gate carrot output
    max_abs_angle_deg: float = 35.0
    draw_debug: bool = True

    # ── Temporal stability ────────────────────────────────────────────────────
    carrot_ema_alpha: float = 0.30
    """EMA weight applied to each new raw measurement.
    1.0 = no smoothing (raw measurement used directly).
    0.1 = very heavy smoothing (slow response to real turns)."""

    carrot_max_jump_px: float = 50.0
    """Hard cap on how far the smoothed carrot x may shift in a single frame.
    After the EMA update, any remaining excess is clamped to this limit.
    Acts as a second backstop against mode-transition spikes."""

    hold_frames: int = 6
    """Frames to retain the last smooth carrot when no new measurement arrives.
    Set to 0 to disable holding entirely."""

    single_edge_history_frames: int = 10
    """Length of the sliding window used to estimate sidewalk half-width for
    single-edge operation.  Longer = more stable estimate, slower to adapt."""


def _validate_config(cfg: CarrotVisionConfig) -> None:
    if not (0.0 < cfg.carrot_y_frac < 1.0):
        raise ValueError(f"carrot_y_frac must be in (0, 1), got {cfg.carrot_y_frac}")
    if cfg.edge_match_y_tolerance_px < 0:
        raise ValueError(
            f"edge_match_y_tolerance_px must be >= 0, got {cfg.edge_match_y_tolerance_px}")
    if cfg.min_centerline_points < 2:
        raise ValueError(
            f"min_centerline_points must be >= 2, got {cfg.min_centerline_points}")
    if cfg.min_centerline_y_span_px <= 0:
        raise ValueError(
            f"min_centerline_y_span_px must be > 0, got {cfg.min_centerline_y_span_px}")
    if cfg.max_abs_angle_deg <= 0:
        raise ValueError(
            f"max_abs_angle_deg must be > 0, got {cfg.max_abs_angle_deg}")
    if not (0.0 < cfg.carrot_ema_alpha <= 1.0):
        raise ValueError(
            f"carrot_ema_alpha must be in (0, 1], got {cfg.carrot_ema_alpha}")
    if cfg.carrot_max_jump_px <= 0:
        raise ValueError(
            f"carrot_max_jump_px must be > 0, got {cfg.carrot_max_jump_px}")
    if cfg.hold_frames < 0:
        raise ValueError(f"hold_frames must be >= 0, got {cfg.hold_frames}")
    if cfg.single_edge_history_frames < 1:
        raise ValueError(
            f"single_edge_history_frames must be >= 1, got {cfg.single_edge_history_frames}")


# ── Main class ─────────────────────────────────────────────────────────────────

class CarrotVision:

    def __init__(self, config: CarrotVisionConfig = None) -> None:
        if config is None:
            config = CarrotVisionConfig()
        _validate_config(config)
        self.config = config

        # Tracking state — updated each call to compute()
        self._last_smooth_x: float = None   # smoothed carrot x from last valid frame
        self._miss_counter: int = 0          # consecutive frames with no measurement
        self._half_width_hist: deque = deque(maxlen=config.single_edge_history_frames)

    def reset(self) -> None:
        """Clear all tracking state. Call when the scene changes abruptly."""
        self._last_smooth_x = None
        self._miss_counter = 0
        self._half_width_hist.clear()

    # ── Public API ─────────────────────────────────────────────────────────────

    def compute(
        self,
        left_edge,
        right_edge,
        frame_shape: tuple,
        intrinsics,
    ) -> dict:
        """
        Compute and track the carrot point from sidewalk edges.

        Parameters
        ----------
        left_edge, right_edge
            Pixel-space edge polylines [(x, y) ...] top-to-bottom, or None.
        frame_shape : (H, W) or (H, W, C)
        intrinsics  : object with .fx > 0 and .ppx (both finite floats)

        Returns
        -------
        dict with keys:
            path_valid, carrot_angle_deg, raw_carrot_angle_deg,
            carrot_point_px, centerline_px, path_source, invalid_reason

        path_source values
        ------------------
        "BOTH_EDGES"        both edges interpolated at target_y
        "LEFT_EDGE_ONLY"    left edge + estimated half-width from history
        "RIGHT_EDGE_ONLY"   right edge + estimated half-width from history
        "HELD"              no new measurement; last smooth carrot held
        "INVALID"           hold expired or intrinsics/frame invalid
        """
        # ── Frame / intrinsics validation ──────────────────────────────────────
        if len(frame_shape) < 2 or frame_shape[0] <= 0 or frame_shape[1] <= 0:
            return _invalid("INVALID_INTRINSICS")

        H = int(frame_shape[0])

        try:
            fx  = float(intrinsics.fx)
            ppx = float(intrinsics.ppx)
        except (AttributeError, TypeError, ValueError):
            return _invalid("INVALID_INTRINSICS")
        if not (fx > 0 and math.isfinite(fx) and math.isfinite(ppx)):
            return _invalid("INVALID_INTRINSICS")

        target_y = H * self.config.carrot_y_frac

        # ── Measure raw carrot x from available edges ──────────────────────────
        # Directly interpolates each edge at target_y — more stable than picking
        # the nearest discrete sample from a pre-built centerline, and immune
        # to raw-fallback y-position jitter.
        measured_x, meas_source, half_w = self._measure_carrot_x(
            left_edge, right_edge, target_y)

        # Update sidewalk width history whenever both edges are visible
        if half_w is not None:
            self._half_width_hist.append(half_w)

        # Build display centerline from available edges
        centerline = self._build_display_centerline(left_edge, right_edge, meas_source)

        # ── Temporal tracking: EMA + speed limit → hold → expire ──────────────
        if measured_x is not None:
            smooth_x = self._apply_ema_and_limit(measured_x)
            self._miss_counter = 0
            final_source = meas_source
            raw_angle_for_display = math.degrees(math.atan2(measured_x - ppx, fx))

        elif (self._miss_counter < self.config.hold_frames
              and self._last_smooth_x is not None):
            # Hold the last known position without updating it
            smooth_x = self._last_smooth_x
            final_source = "HELD"
            raw_angle_for_display = None   # no new measurement this frame
            self._miss_counter += 1

        else:
            # No measurement and hold has expired (or never started)
            self._miss_counter += 1
            if self._miss_counter > self.config.hold_frames:
                self._last_smooth_x = None  # full reset for clean restart later
            return _invalid(meas_source, centerline)

        # ── Angles ─────────────────────────────────────────────────────────────
        smooth_angle     = math.degrees(math.atan2(smooth_x - ppx, fx))
        carrot_angle_deg = float(
            np.clip(smooth_angle, -self.config.max_abs_angle_deg,
                    self.config.max_abs_angle_deg))

        return {
            "path_valid":           True,
            "carrot_angle_deg":     carrot_angle_deg,
            "raw_carrot_angle_deg": raw_angle_for_display,
            "carrot_point_px":      (int(round(smooth_x)), int(round(target_y))),
            "centerline_px":        centerline,
            "path_source":          final_source,
            "invalid_reason":       None,
        }

    def draw_debug(self, frame_bgr: np.ndarray, path_result: dict) -> np.ndarray:
        """
        Return a new BGR frame with Carrot Vision overlays drawn on it.
        Does NOT mutate frame_bgr.  Expects original camera image coordinates.
        """
        out = frame_bgr.copy()
        if not _CV2_OK or not self.config.draw_debug:
            return out

        H, W       = out.shape[:2]
        centerline = path_result.get("centerline_px", [])
        carrot_pt  = path_result.get("carrot_point_px")
        path_valid = path_result.get("path_valid", False)
        angle      = path_result.get("carrot_angle_deg")
        raw_angle  = path_result.get("raw_carrot_angle_deg")
        reason     = path_result.get("invalid_reason")
        source     = path_result.get("path_source", "")

        is_estimated = source in ("LEFT_EDGE_ONLY", "RIGHT_EDGE_ONLY")
        is_held      = (source == "HELD")

        # Centerline — dimmer when estimated or held
        cl_col = (0, 180, 0) if not (is_estimated or is_held) else (0, 140, 180)
        for i in range(len(centerline) - 1):
            cv2.line(out, centerline[i], centerline[i + 1], cl_col, 2, cv2.LINE_AA)

        # Carrot point
        cp_col = (0, 255, 255) if not (is_estimated or is_held) else (0, 200, 140)
        if carrot_pt is not None:
            cv2.circle(out, carrot_pt, 14, cp_col, -1)
            cv2.circle(out, carrot_pt, 16, (0, 120, 0), 2)

        # Arrow from bottom-centre to carrot
        if carrot_pt is not None:
            cv2.arrowedLine(out, (W // 2, H - 1), carrot_pt,
                            (57, 255, 20), 2, cv2.LINE_AA, tipLength=0.12)

        font = cv2.FONT_HERSHEY_SIMPLEX
        cv2.putText(out, 'CARROT VISION', (8, 22), font, 0.62,
                    (255, 255, 255), 2, cv2.LINE_AA)

        if path_valid and angle is not None:
            cv2.putText(out, f'angle : {angle:+.1f}', (8, 48), font, 0.55,
                        (57, 255, 20), 1, cv2.LINE_AA)
            if raw_angle is not None and abs(raw_angle - angle) > 0.05:
                cv2.putText(out, f'raw   : {raw_angle:+.1f}', (8, 68), font, 0.50,
                            (120, 210, 120), 1, cv2.LINE_AA)
            src_col = ((200, 200, 0) if is_estimated
                       else (180, 180, 0) if is_held
                       else (0, 240, 0))
            cv2.putText(out, f'src: {source}', (8, 92), font, 0.48,
                        src_col, 1, cv2.LINE_AA)
        else:
            cv2.putText(out, reason or 'INVALID', (8, 48), font, 0.52,
                        (0, 80, 255), 1, cv2.LINE_AA)

        return out

    # ── Private helpers ────────────────────────────────────────────────────────

    def _measure_carrot_x(self, left_edge, right_edge, target_y):
        """
        Interpolate left and right edges at target_y and compute carrot x.

        Returns
        -------
        (measured_x, source_or_reason, half_width)
            measured_x   : float when a measurement was obtained, else None
            source_or_reason : path_source string on success; invalid_reason on failure
            half_width   : half the pixel width between edges (BOTH_EDGES only)
        """
        lx = _interp_edge_at_y(left_edge,  target_y)
        rx = _interp_edge_at_y(right_edge, target_y)

        if lx is not None and rx is not None and lx < rx:
            half_w = (rx - lx) / 2.0
            return (lx + rx) / 2.0, "BOTH_EDGES", half_w

        # Single-edge estimation using the width accumulated from recent both-edge frames
        median_hw = self._median_half_width()
        if median_hw is not None:
            if lx is not None:
                return lx + median_hw, "LEFT_EDGE_ONLY", None
            if rx is not None:
                return rx - median_hw, "RIGHT_EDGE_ONLY", None

        # No measurement possible — classify the reason
        if not left_edge:
            reason = "LEFT_EDGE_MISSING"
        elif not right_edge:
            reason = "RIGHT_EDGE_MISSING"
        elif lx is None and rx is None:
            reason = "NO_CARROT_POINT"   # target_y outside both edges' y range
        elif lx is None:
            reason = "NO_CARROT_POINT"   # left edge doesn't reach target_y
        elif rx is None:
            reason = "NO_CARROT_POINT"   # right edge doesn't reach target_y
        else:
            reason = "INSUFFICIENT_CENTERLINE_POINTS"   # lx >= rx (edges crossed)

        return None, reason, None

    def _apply_ema_and_limit(self, measured_x: float) -> float:
        """
        Apply exponential moving average then speed limit; update _last_smooth_x.

        EMA first: absorbs continuous frame-to-frame RANSAC variance.
        Speed limit second: catches large spikes from mode transitions that
        survive the EMA (e.g. a 150 px jump after hist.clear() in the edge fitter).
        """
        alpha    = self.config.carrot_ema_alpha
        max_jump = self.config.carrot_max_jump_px

        if self._last_smooth_x is None:
            smooth_x = measured_x           # first measurement: no smoothing
        else:
            smooth_x = alpha * measured_x + (1.0 - alpha) * self._last_smooth_x
            delta = smooth_x - self._last_smooth_x
            if abs(delta) > max_jump:
                smooth_x = self._last_smooth_x + math.copysign(max_jump, delta)

        self._last_smooth_x = smooth_x
        return smooth_x

    def _median_half_width(self):
        """Median half-width from recent both-edge frames, or None if no history."""
        if not self._half_width_hist:
            return None
        return float(np.median(list(self._half_width_hist)))

    def _build_display_centerline(self, left_edge, right_edge, meas_source):
        """
        Build a pixel-space polyline for display.

        BOTH_EDGES    standard midpoint interpolation.
        Single-edge   offset the visible edge by the median half-width estimate.
        Anything else empty list (no data to display).
        """
        if meas_source == "BOTH_EDGES" and left_edge and right_edge:
            return _build_centerline(left_edge, right_edge)
        hw = self._median_half_width()
        if meas_source == "LEFT_EDGE_ONLY" and left_edge and hw is not None:
            return [(int(round(x + hw)), y) for x, y in left_edge]
        if meas_source == "RIGHT_EDGE_ONLY" and right_edge and hw is not None:
            return [(int(round(x - hw)), y) for x, y in right_edge]
        return []


# ── Module-level helpers ───────────────────────────────────────────────────────

def _invalid(reason: str, centerline=None) -> dict:
    return {
        "path_valid":           False,
        "carrot_angle_deg":     None,
        "raw_carrot_angle_deg": None,
        "carrot_point_px":      None,
        "centerline_px":        centerline or [],
        "path_source":          "INVALID",
        "invalid_reason":       reason,
    }


def _interp_edge_at_y(edge, target_y: float):
    """
    Interpolate the x value of an edge polyline at target_y.

    Returns float, or None when the edge is absent or target_y lies outside
    the edge's observed y range (no extrapolation).
    """
    if not edge:
        return None
    sorted_edge = sorted(edge, key=lambda p: p[1])
    ys = np.array([p[1] for p in sorted_edge], dtype=np.float32)
    xs = np.array([p[0] for p in sorted_edge], dtype=np.float32)
    if target_y < float(ys[0]) or target_y > float(ys[-1]):
        return None   # do not extrapolate beyond observed data
    return float(np.interp(target_y, ys, xs))


def _build_centerline(left_edge, right_edge):
    """
    Interpolate left and right edges over their shared y-overlap range,
    emit midpoints at every actual y sample from either side.

    Returns [(int x, int y) ...] top-to-bottom. Rows where left_x >= right_x
    or any value is non-finite are dropped silently.
    """
    left_sorted  = sorted(left_edge,  key=lambda p: p[1])
    right_sorted = sorted(right_edge, key=lambda p: p[1])

    left_ys  = np.array([p[1] for p in left_sorted],  dtype=np.float32)
    left_xs  = np.array([p[0] for p in left_sorted],  dtype=np.float32)
    right_ys = np.array([p[1] for p in right_sorted], dtype=np.float32)
    right_xs = np.array([p[0] for p in right_sorted], dtype=np.float32)

    y_lo = max(float(left_ys[0]),  float(right_ys[0]))
    y_hi = min(float(left_ys[-1]), float(right_ys[-1]))
    if y_lo > y_hi:
        return []

    sample_ys = np.array(sorted({
        float(y) for y in np.concatenate([left_ys, right_ys])
        if y_lo <= y <= y_hi
    }))
    if len(sample_ys) == 0:
        return []

    lxs   = np.interp(sample_ys, left_ys,  left_xs)
    rxs   = np.interp(sample_ys, right_ys, right_xs)
    valid = np.isfinite(lxs) & np.isfinite(rxs) & (lxs < rxs)
    cxs   = (lxs + rxs) / 2.0

    return [
        (int(round(float(cx))), int(round(float(y))))
        for cx, y, ok in zip(cxs, sample_ys, valid)
        if ok
    ]
