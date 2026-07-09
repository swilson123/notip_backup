#!/usr/bin/env python3

import json
import math
import os
import signal
import sys
import threading
import time
import warnings

try:
    import cv2
    import numpy as np
    import psutil
    import pyrealsense2 as rs
except Exception as exc:
    sys.stdout.write(json.dumps({
        "message_type": "status",
        "status": "error",
        "error": "dependency_import_failed",
        "detail": str(exc),
        "timestamp": int(time.time() * 1000)
    }) + "\n")
    sys.stdout.flush()
    raise


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def parse_config():
    if len(sys.argv) < 2:
        return {}

    try:
        return json.loads(sys.argv[1])
    except Exception:
        return {}


class RealsenseVision:
    def __init__(self, config):
        self.config = config or {}
        self.running = True
        self.pipeline = None
        self.pipeline_started = False
        self.align = None
        self.current_fps_target = int(self.config.get("fps_normal", 15))
        self.last_processed_at = 0.0
        self.last_emit_at = 0.0
        self.last_path_width_meters = 0.9
        self.last_fx = 380.0
        # TRON-grid ground-plane filter: fraction of the appearance mask removed
        # last frame because it wasn't flat ground at the expected height.
        self._last_ground_removed_frac = 0.0
        self.frame_counter = 0
        self.last_fps_sample_at = time.time()
        self.last_fps_counter = 0
        self.measured_fps = 0
        # Latest rover pitch and roll in radians, updated via stdin messages from the
        # Node.js parent. Used to rotate camera-frame depth into a rover-horizontal frame
        # so potholes / bumps / off-camber surfaces don't corrupt object heights, lateral
        # positions, or centerline forward distances.
        #   pitch positive = nose up
        #   roll  positive = right side down
        # Static camera mount tilt. config camera_mount_pitch_deg is positive when the
        # camera is pitched FORWARD (nose-down) — the opposite sign of the nose-up-positive
        # convention, so it is SUBTRACTED from the rover's dynamic body pitch to get the
        # camera's true pitch vs the ground. (If ground distances/heights read inverted on
        # the rover, flip the sign of camera_mount_pitch_deg in setup.json.)
        self.mount_pitch_rad = math.radians(float(self.config.get("camera_mount_pitch_deg", 0.0)))
        self.current_pitch_rad = -self.mount_pitch_rad   # rover level + the camera mount tilt
        self.current_roll_rad  = 0.0
        # Compass heading in degrees, updated via stdin same as pitch/roll. None until the
        # first "heading" message arrives, so the residual check below stays inert (no
        # confidence penalty applied) rather than guessing at a rover that hasn't reported
        # in yet.
        self.current_heading_deg = None
        # Last tick's ACCEPTED (pre-smoothing) edge point per side, tagged with the heading
        # at the moment it was seen. Ground truth for _predict_and_score: a real, physical
        # edge is a fixed point in the world, so rotating it by how much Noah's heading has
        # changed since predicts exactly where it must appear again this tick. A shadow or
        # color artifact isn't tied to a 3D point and won't obey that rotation.
        self._edge_residual_prev = {"left": None, "right": None}
        # Edge-guidance hysteresis: once an edge is chosen as the steering reference,
        # stick with it as long as it stays confident — only switch sides when the
        # chosen edge degrades or the OTHER edge becomes substantially more confident.
        # Prevents the rover oscillating between left/right when the two edge
        # confidences are close and jitter by a few percent frame to frame.
        self.last_edge_used = None        # "left" / "right" / None
        self.last_edge_used_ts = 0.0
        # Last-known per-side edge observations, populated from nearest-band detections.
        # Stored so telemetry can report each side reliably even if one edge blinks out.
        self.last_edge_obs = {"left": None, "right": None}
        # EMA smoothing state: per-side exponential moving average of edge X/Y positions.
        # Prevents frame-to-frame measurement noise from causing steering jitter.
        self._edge_smooth = {"left": None, "right": None}
        self._guidance_smooth = {"left": None, "right": None}
        # Stable reference color for the seed-adaptive ground mask (see
        # _stable_ground_seed) -- the sidewalk's own color shouldn't change tick to
        # tick, so this is a slow EMA, not a fresh re-sample every frame. None until
        # the first frame bootstraps it.
        self._ground_seed_ref = None
        self._ground_seed_pending = None
        # HDMI screen preview: OFF by default (display_enabled in setup.json), toggled
        # live via SIGUSR1 so it can be flipped on/off without restarting the mission --
        # this process already owns the exclusive RealSense camera handle, so the
        # preview has to live here rather than in a second standalone script.
        self.display_enabled = bool(self.config.get("display_enabled", False))
        self._display_window_name = "Noah Vision"
        self._display_window_ready = False
        self._display_window_failed = False
        self._display_error_logged = False
        self._last_display_row_start = 0
        self._last_display_row_end = 0
        # Periodic frame capture to disk (display_capture_enabled) -- independent of
        # whether a live HDMI window is even possible, so a running set of real,
        # annotated frames builds up for review on a headless run too.
        self._last_capture_ts = 0.0
        # Set by Node over stdin ("capture_session", see pixhawk_message_handler.js)
        # on each arm/disarm so frames land next to that session's rc_edge_capture
        # JSON log instead of one flat directory. None/None = Node hasn't taken over
        # yet (e.g. running this script standalone for bench testing) -- fall back to
        # the static display_capture_dir/always-on behavior in that case.
        self._session_capture_active = None
        self._session_capture_dir = None
        # The selected-blob color mask (2026-07-09) -- set only when it was actually
        # used as the edge source that tick (use_mask_source in _detect_edges_hough),
        # so the green overlay shows exactly the same classification driving the edge
        # lines, not a separately-idealized corridor. None when the Hough fallback ran
        # instead -- green means the real sidewalk mask, or nothing at all, no
        # fallback shape.
        self._last_display_center_mask = None
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        signal.signal(signal.SIGUSR1, self._toggle_display)

    def stop(self, *_args):
        self.running = False

    def _toggle_display(self, *_args):
        self.display_enabled = not self.display_enabled
        if not self.display_enabled and self._display_window_ready:
            try:
                cv2.destroyWindow(self._display_window_name)
            except Exception:
                pass
            self._display_window_ready = False

    def _draw_carrot_arrow(self, frame, base, tip, status_color):
        # A literal carrot: tapered orange body pointing at the steering target
        # (Noah follows the carrot -- see carrot.js), status_color as the outline
        # so tracking/low-confidence/lost is still legible at a glance, plus a
        # leafy green top fanned out from the base end.
        bx, by = float(base[0]), float(base[1])
        tx, ty = float(tip[0]), float(tip[1])
        dx, dy = tx - bx, ty - by
        axis_len = math.hypot(dx, dy)
        if axis_len < 1e-3:
            return
        ux, uy = dx / axis_len, dy / axis_len   # unit vector along the carrot's long axis
        px, py = -uy, ux                        # unit perpendicular, for body width

        def along(t):
            return (bx + ux * axis_len * t, by + uy * axis_len * t)

        def offset(pt, w):
            x, y = pt
            return (int(round(x + px * w)), int(round(y + py * w)))

        half_w_base = max(10, int(axis_len * 0.11))
        p0 = along(0.0)
        p_shoulder = along(0.12)
        body_pts = np.array([
            offset(p0, -half_w_base),
            offset(p_shoulder, -half_w_base * 0.9),
            [int(round(tx)), int(round(ty))],
            offset(p_shoulder, half_w_base * 0.9),
            offset(p0, half_w_base),
        ], dtype=np.int32)

        carrot_orange = (0, 140, 255)   # BGR
        ridge_orange  = (0, 100, 210)
        leaf_green    = (40, 170, 60)

        cv2.fillPoly(frame, [body_pts], carrot_orange)
        cv2.polylines(frame, [body_pts], True, status_color, 3, cv2.LINE_AA)

        # Ridge marks along the body for a bit of carrot texture.
        for t in (0.30, 0.50, 0.70):
            c = along(t)
            w = half_w_base * (1.0 - t) * 0.85
            cv2.line(frame, offset(c, -w), offset(c, w), ridge_orange, 2, cv2.LINE_AA)

        # Leafy top, fanned out from the base end (opposite the steering tip).
        leaf_len = axis_len * 0.22
        rev_x, rev_y = -ux, -uy
        base_px = (int(round(bx)), int(round(by)))
        for angle_deg in (-32, 0, 32):
            a = math.radians(angle_deg)
            rx = rev_x * math.cos(a) - rev_y * math.sin(a)
            ry = rev_x * math.sin(a) + rev_y * math.cos(a)
            leaf_tip = (int(round(bx + rx * leaf_len)), int(round(by + ry * leaf_len)))
            cv2.line(frame, base_px, leaf_tip, leaf_green, 5, cv2.LINE_AA)

    def _render_display(self, color_image, detection):
        # HDMI screen preview: highlighted walkable-mask overlay + a carrot pointing
        # along x_angle_deg. Runs inline in the same process/tick that already owns
        # the camera, gated on display_enabled (toggled live via SIGUSR1). Wrapped in
        # a broad try/except and self-disables on any failure (e.g. no X server on
        # this session) -- a display problem must never take down live steering.
        if not self.display_enabled:
            return
        try:
            frame = color_image.copy()
            h, w = frame.shape[:2]

            # Single vantage point for the whole overlay (noah_knows.pdf: "all edges
            # are calculated from a single point of view -- the bottom center of the
            # screen"). The carrot is already drawn from here; the edge rays below are
            # pinned to the same point so they read as two sightlines from Noah's own
            # position, not as floating lines with their own independent anchor.
            base = (w // 2, h - 30)

            x_angle_deg = float(detection.get("x_angle_deg", 0) or 0)

            # Dots mark the fitted lines' ANGLE (same angle x_angle_deg/el_x/er_x come
            # from), re-anchored through the shared base point above instead of each
            # fit's own near-field anchor -- that raw anchor moves with whatever noisy
            # segment was closest this tick, which swung the whole line's position
            # (not just its angle) and read as the lines jumping around. Two real
            # sidewalk edges only meet at the vanishing point, which should sit beyond
            # what we're analyzing here -- if the fitted lines cross INSIDE the ROI, at
            # least one fit has gone bad. Stop drawing both dots at that row rather than
            # let them visibly swap sides on screen.
            el_x_m = detection.get("edge_left_x_m")
            el_y_m = detection.get("edge_left_y_m")
            er_x_m = detection.get("edge_right_x_m")
            er_y_m = detection.get("edge_right_y_m")
            if el_x_m is not None or er_x_m is not None:
                r0, r1 = self._last_display_row_start, self._last_display_row_end
                base_y_roi = min(base[1], r1 - 1) - r0
                # Noah's actual visible half-angle from straight-ahead, at this focal
                # length: atan((w/2)/fx). Measured live on this D435I at 640x480
                # (fx ~606) that comes out to ~28 deg per side, not a symmetric 45 --
                # 45 would assume a 90 deg horizontal FOV this camera doesn't have.
                # el is held to [-half_fov, 0] and er to [0, +half_fov] -- a noisy fit
                # can still swing the reported angle within its own half, but el/er can
                # never cross the boresight and paint the wrong edge on the wrong side
                # of the center path. Angle comes from edge_left_x_m/y_m and
                # edge_right_x_m/y_m -- the SAME EMA-smoothed, TTL-latched point
                # actually reported as el_x/el_y, er_x/er_y (LCD screen3, steering) --
                # not the raw per-tick Hough line fit, which carries zero temporal
                # smoothing and is why this line visibly bounced every frame while the
                # reported edge point itself stayed stable.
                half_fov_deg = math.degrees(math.atan((w * 0.5) / max(1.0, self.last_fx)))
                a_left = a_right = None
                if el_x_m is not None and el_y_m:
                    el_angle_deg = max(-half_fov_deg, min(0.0, math.degrees(math.atan2(el_x_m, el_y_m))))
                    a_left = -math.tan(math.radians(el_angle_deg))
                if er_x_m is not None and er_y_m:
                    er_angle_deg = max(0.0, min(half_fov_deg, math.degrees(math.atan2(er_x_m, er_y_m))))
                    a_right = -math.tan(math.radians(er_angle_deg))
                for y_roi in range(0, max(0, r1 - r0)):
                    y_full = r0 + y_roi
                    if y_full < 0 or y_full >= h:
                        continue
                    x_left = None
                    x_right = None
                    if a_left is not None:
                        x_left = a_left * (y_roi - base_y_roi) + base[0]
                    if a_right is not None:
                        x_right = a_right * (y_roi - base_y_roi) + base[0]
                    if x_left is not None and x_right is not None and x_right <= x_left:
                        continue                        # crossed -- stop trusting both here
                    if x_left is not None:
                        cv2.circle(frame, (int(np.clip(x_left, 0, w - 1)), y_full), 1, (255, 120, 0), -1)  # blue: left edge
                    if x_right is not None:
                        cv2.circle(frame, (int(np.clip(x_right, 0, w - 1)), y_full), 1, (0, 80, 255), -1)  # orange: right edge

            # Green overlay: ONLY the actual sidewalk color-mask blob the edges were
            # read from this tick (_last_display_center_mask, set in
            # _detect_edges_hough only when use_mask_source was true) -- what's
            # painted on screen IS the classification driving the edge lines, never a
            # separately-idealized corridor. No fallback shape when the mask wasn't
            # the source that tick (Hough fallback ran instead) -- green means the
            # real sidewalk mask, or it means nothing at all.
            center_mask_disp = self._last_display_center_mask
            if center_mask_disp is not None and cv2.countNonZero(center_mask_disp) > 0:
                r0 = self._last_display_row_start
                mh = center_mask_disp.shape[0]
                mask_bool = np.zeros((h, w), dtype=bool)
                r_end = min(h, r0 + mh)
                if r_end > r0:
                    mask_bool[r0:r_end, :] = center_mask_disp[:r_end - r0, :] > 0
                if np.any(mask_bool):
                    tint = np.zeros_like(frame)
                    tint[:] = (0, 200, 0)  # BGR green
                    blended = cv2.addWeighted(frame, 0.55, tint, 0.45, 0)
                    frame[mask_bool] = blended[mask_bool]

            confidence = float(detection.get("confidence", 0) or 0)
            status = detection.get("status", "unknown")
            valid = bool(detection.get("edge_guidance_valid", False))

            if valid and confidence >= 0.6:
                status_color = (0, 220, 0)      # green: tracking
            elif valid:
                status_color = (0, 210, 255)    # amber: low confidence
            else:
                status_color = (60, 60, 220)    # red: no signal

            length = int(min(h, w) * 0.28)
            # Clamp only how far the CARROT is drawn, not the underlying angle value --
            # a 70 degree steering angle should still visibly point hard to one side
            # rather than run off the top of the frame.
            display_angle_deg = max(-70.0, min(70.0, x_angle_deg))
            angle_rad = math.radians(display_angle_deg)
            tip = (int(base[0] + length * math.sin(angle_rad)),
                   int(base[1] - length * math.cos(angle_rad)))
            self._draw_carrot_arrow(frame, base, tip, status_color)

            label = "x_angle: {:+.1f} deg   conf: {:.2f}   {}".format(x_angle_deg, confidence, status)
            cv2.putText(frame, label, (12, h - 12), cv2.FONT_HERSHEY_SIMPLEX,
                        0.6, (255, 255, 255), 2, cv2.LINE_AA)

            # Periodic capture to disk -- deliberately independent of whether the live
            # HDMI window below succeeds, so this still works on a headless run (no X
            # server) instead of dying with it on the first namedWindow/imshow failure.
            # Gated on _session_capture_active only once Node has actually said
            # something (arm/disarm, via the "capture_session" stdin message below) --
            # while it's still None (this script run standalone, no Node driving it)
            # display_capture_enabled alone controls capture, same as before.
            if bool(self.config.get("display_capture_enabled", False)) and self._session_capture_active is not False:
                capture_interval_s = float(self.config.get("display_capture_interval_s", 1.0))
                now_ts = time.time()
                if now_ts - self._last_capture_ts >= capture_interval_s:
                    self._last_capture_ts = now_ts
                    try:
                        capture_dir = self._session_capture_dir or str(self.config.get("display_capture_dir", "./screenshots/auto_capture"))
                        os.makedirs(capture_dir, exist_ok=True)
                        fname = os.path.join(capture_dir, "frame_{:013d}.jpg".format(int(now_ts * 1000)))
                        cv2.imwrite(fname, frame)
                        max_frames = int(self.config.get("display_capture_max_frames", 200))
                        files = sorted(os.listdir(capture_dir))
                        for old in files[:max(0, len(files) - max_frames)]:
                            try:
                                os.remove(os.path.join(capture_dir, old))
                            except Exception:
                                pass
                    except Exception:
                        pass  # a capture failure must never affect steering or the live display

            # Live HDMI window: isolated from the block above so a windowing failure
            # (e.g. no X server) only disables the WINDOW, not the overlay build or
            # the disk capture -- those keep running every tick regardless.
            if not self._display_window_failed:
                try:
                    if not self._display_window_ready:
                        cv2.namedWindow(self._display_window_name, cv2.WND_PROP_FULLSCREEN)
                        cv2.setWindowProperty(self._display_window_name, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)
                        self._display_window_ready = True
                    cv2.imshow(self._display_window_name, frame)
                    cv2.waitKey(1)
                except Exception as exc:
                    self._display_window_failed = True
                    if not self._display_error_logged:
                        self._display_error_logged = True
                        sys.stderr.write("realsense_vision display window disabled after error: {}\n".format(exc))
                        sys.stderr.flush()
        except Exception as exc:
            if not self._display_error_logged:
                self._display_error_logged = True
                sys.stderr.write("realsense_vision display disabled after error: {}\n".format(exc))
                sys.stderr.flush()
            self.display_enabled = False

    def _apply_edge_use_hysteresis(self, natural_use, left_m, left_conf, right_m, right_conf):
        # Once an edge (or "center", both edges averaged) is chosen as the steering
        # reference, stick with it as long as it's still available -- only switch when
        # the currently-used side disappears, or the candidate is clearly better
        # (edge_hysteresis_keep_conf / _switch_margin) and edge_hysteresis_ttl_ms has
        # passed since the last switch. Without this, x_angle_deg mode-flips between
        # "center" and a single-edge offset every time a borderline edge's confidence
        # jitters a few percent frame to frame -- a real jump, not sensor noise.
        def mode_conf(mode):
            if mode == "center":
                return (left_conf + right_conf) / 2.0
            if mode == "left":
                return left_conf
            if mode == "right":
                return right_conf
            return 0.0

        def holdable(mode):
            if mode == "center":
                return left_m is not None and right_m is not None
            if mode == "left":
                return left_m is not None
            if mode == "right":
                return right_m is not None
            return False

        keep_conf     = float(self.config.get("edge_hysteresis_keep_conf", 0.6))
        switch_margin = float(self.config.get("edge_hysteresis_switch_margin", 0.2))
        switch_ttl_s  = float(self.config.get("edge_hysteresis_ttl_ms", 3000)) / 1000.0
        now = time.time()

        prev = self.last_edge_used
        use = natural_use
        if prev is not None and prev != natural_use and holdable(prev):
            dwell_met = (now - self.last_edge_used_ts) >= switch_ttl_s
            confident_enough = (mode_conf(natural_use) >= keep_conf
                                 or (mode_conf(natural_use) - mode_conf(prev)) >= switch_margin)
            if not (dwell_met and confident_enough):
                use = prev

        if use != self.last_edge_used:
            self.last_edge_used = use
            self.last_edge_used_ts = now
        return use

    def _finalize_edge_guidance_result(self, result, left_cur, right_cur, side_offset_m,
                                        left_age_ms=None, right_age_ms=None):
        if left_cur is None and right_cur is None:
            return result

        left_m    = left_cur["m"]    if left_cur  is not None else None
        left_conf = left_cur["conf"] if left_cur  is not None else 0.0
        right_m    = right_cur["m"]    if right_cur is not None else None
        right_conf = right_cur["conf"] if right_cur is not None else 0.0

        # known_edge() reuses the last real detection (at its original, undecayed
        # confidence) for up to edge_known_ttl_ms when a side has no fresh hit this
        # frame -- age_ms is 0.0 for a fresh hit, > 0 for a cached one. Averaging a
        # cached reading from a second-plus ago with a live opposite-side reading
        # ("center" mode) blends a position from before Noah moved with where he is
        # now, producing a target that matches neither edge. When exactly one side
        # is stale, steer off the fresh side alone instead of blending.
        left_stale  = bool(left_age_ms)  and left_age_ms  > 0
        right_stale = bool(right_age_ms) and right_age_ms > 0

        if left_m is not None and right_m is not None:
            if left_stale and not right_stale:
                natural_use = "right"
            elif right_stale and not left_stale:
                natural_use = "left"
            else:
                natural_use = "center"
        elif left_m is not None:
            natural_use = "left"
        else:
            natural_use = "right"

        use = self._apply_edge_use_hysteresis(natural_use, left_m, left_conf, right_m, right_conf)

        if use == "center":
            u_target    = (left_m + right_m) / 2.0
            chosen_conf = (left_conf + right_conf) / 2.0
            forward_m   = (left_cur["y_m"] + right_cur["y_m"]) / 2.0
        elif use == "left":
            u_target    = left_m - side_offset_m
            chosen_conf = left_conf
            forward_m   = left_cur["y_m"]
        else:
            u_target    = right_m + side_offset_m
            chosen_conf = right_conf
            forward_m   = right_cur["y_m"]

        x_angle_deg = math.degrees(math.atan2(-u_target, float(forward_m))) if forward_m > 0 else 0.0

        result.update({
            "valid": True,
            "x_angle_deg": round(float(x_angle_deg), 2),
            "offset_m": round(float(u_target), 4),
            "used": use,
            "forward_m": round(float(forward_m), 3),
            "confidence": round(float(chosen_conf), 2),
        })
        return result

    def _smooth_obs(self, side, obs):
        # Exponential moving average on detected edge X/Y.
        # alpha (default 0.3): 30% new value, 70% old — ~4-frame time constant at 15 fps.
        # Masks camera auto-exposure flicker and mask-boundary pixel noise (1-3 px jitter)
        # without adding meaningful lag on genuine lateral motion.
        if obs is None:
            return obs
        alpha = float(self.config.get("edge_ema_alpha", 0.3))
        prev = self._edge_smooth.get(side)
        x = float(obs["x_distance_m"])
        y = float(obs["y_distance_m"])
        if prev is None:
            self._edge_smooth[side] = {"x": x, "y": y}
            return obs
        sx = alpha * x + (1.0 - alpha) * prev["x"]
        sy = alpha * y + (1.0 - alpha) * prev["y"]
        self._edge_smooth[side] = {"x": sx, "y": sy}
        out = dict(obs)
        out["x_distance_m"] = round(float(sx), 4)
        out["y_distance_m"] = round(float(sy), 3)
        out["m"]   = round(float(-sx), 4)
        out["x_m"] = round(float(sx), 4)
        out["y_m"] = round(float(sy), 3)
        return out

    def _reset_camera(self):
        try:
            ctx = rs.context()
            devices = ctx.query_devices()
            if len(devices) == 0:
                return
            devices[0].hardware_reset()
            # Wait for the camera to reconnect after firmware reset
            deadline = time.time() + 10
            while time.time() < deadline:
                time.sleep(0.5)
                ctx2 = rs.context()
                if len(ctx2.query_devices()) > 0:
                    time.sleep(1.0)  # extra settle time
                    return
        except Exception:
            pass

    def start(self):
        self._reset_camera()

        width = int(self.config.get("width", 640))
        height = int(self.config.get("height", 480))
        fps = int(self.config.get("fps_normal", 15))

        self.pipeline = rs.pipeline()
        rs_config = rs.config()
        rs_config.enable_stream(rs.stream.depth, width, height, rs.format.z16, fps)
        rs_config.enable_stream(rs.stream.color, width, height, rs.format.bgr8, fps)
        profile = self.pipeline.start(rs_config)
        self.pipeline_started = True
        self.align = rs.align(rs.stream.color)

        device = profile.get_device()
        for sensor in device.sensors:
            if sensor.supports(rs.option.emitter_enabled):
                sensor.set_option(rs.option.emitter_enabled, 1)

        emit({
            "message_type": "status",
            "status": "ready",
            "timestamp": int(time.time() * 1000),
            "fps_target": self.current_fps_target
        })

    def update_target_fps(self):
        cpu_percent = psutil.cpu_percent(interval=None)
        high_threshold = float(self.config.get("cpu_high_threshold", 70))
        critical_threshold = float(self.config.get("cpu_critical_threshold", 85))

        if cpu_percent >= critical_threshold:
            self.current_fps_target = int(self.config.get("fps_critical_cpu", 7))
        elif cpu_percent >= high_threshold:
            self.current_fps_target = int(self.config.get("fps_high_cpu", 10))
        else:
            self.current_fps_target = int(self.config.get("fps_normal", 15))

        return cpu_percent

    def should_process_frame(self):
        if self.current_fps_target <= 0:
            return True

        now = time.time()
        min_interval = 1.0 / float(self.current_fps_target)
        if now - self.last_processed_at < min_interval:
            return False

        self.last_processed_at = now
        return True

    def update_measured_fps(self):
        now = time.time()
        self.frame_counter += 1
        self.last_fps_counter += 1
        elapsed = now - self.last_fps_sample_at
        if elapsed >= 1.0:
            self.measured_fps = self.last_fps_counter / elapsed
            self.last_fps_counter = 0
            self.last_fps_sample_at = now

    def run(self):
        try:
            self.start()
            startup_frames = 0
            while self.running:
                timeout_ms = 8000 if startup_frames < 5 else 1000
                frames = self.pipeline.wait_for_frames(timeout_ms)
                startup_frames += 1
                cpu_percent = self.update_target_fps()
                if not self.should_process_frame():
                    continue

                detection = self.process_frames(frames, cpu_percent)
                if detection is not None:
                    emit(detection)
                    self.last_emit_at = time.time()
        finally:
            if self.pipeline is not None and self.pipeline_started:
                self.pipeline.stop()

    def process_frames(self, frames, cpu_percent):
        aligned_frames = self.align.process(frames)
        depth_frame = aligned_frames.get_depth_frame()
        color_frame = aligned_frames.get_color_frame()
        if not depth_frame or not color_frame:
            return None

        depth_image = np.asanyarray(depth_frame.get_data())
        color_image = np.asanyarray(color_frame.get_data())
        intrinsics = color_frame.profile.as_video_stream_profile().intrinsics
        self.last_fx = intrinsics.fx

        result = self.detect_path(color_image, depth_image, intrinsics)
        objects = self.detect_objects(depth_image, intrinsics)
        self.update_measured_fps()
        self._render_display(color_image, result)

        return {
            "message_type": "path_detection",
            "x_angle_deg": result.get("x_angle_deg", 0),
            "ground_grid_removed_frac": result.get("ground_grid_removed_frac", 0),
            "offset_meters": result["offset_meters"],
            "path_width_meters": result["path_width_meters"],
            "confidence": result["confidence"],
            "left_boundary_visible": result["left_boundary_visible"],
            "right_boundary_visible": result["right_boundary_visible"],
            "centerline": result["centerline"],
            "nearest_edge_m": result["nearest_edge_m"],
            "nearest_edge_side": result["nearest_edge_side"],
            "nearest_edge_clearance_m": result["nearest_edge_clearance_m"],
            "nearest_edge_type": result["nearest_edge_type"],
            "left_edge_clearance_m": result.get("left_edge_clearance_m"),
            "right_edge_clearance_m": result.get("right_edge_clearance_m"),
            "edge_left_m": result.get("edge_left_m"),
            "edge_left_conf": result.get("edge_left_conf", 0),
            "edge_left_x_m": result.get("edge_left_x_m"),
            "edge_left_y_m": result.get("edge_left_y_m"),
            "edge_left_known": result.get("edge_left_known", False),
            "edge_left_known_age_ms": result.get("edge_left_known_age_ms"),
            "edge_right_m": result.get("edge_right_m"),
            "edge_right_conf": result.get("edge_right_conf", 0),
            "edge_right_x_m": result.get("edge_right_x_m"),
            "edge_right_y_m": result.get("edge_right_y_m"),
            "edge_right_known": result.get("edge_right_known", False),
            "edge_right_known_age_ms": result.get("edge_right_known_age_ms"),
            "edge_left_bands": result.get("edge_left_bands", []),
            "edge_right_bands": result.get("edge_right_bands", []),
            "edge_used": result.get("edge_used", "none"),
            "edge_target_offset_m": result.get("edge_target_offset_m"),
            "edge_forward_m": result.get("edge_forward_m"),
            "edge_guidance_valid": result.get("edge_guidance_valid", False),
            "edge_mask_source": result.get("edge_mask_source"),
            "cpu_percent": round(cpu_percent, 1),
            "fps_current": round(self.measured_fps, 1),
            "fps_target": self.current_fps_target,
            "status": result["status"],
            "source": "realsense_vision",
            "timestamp": int(time.time() * 1000),
            "objects": objects
        }

    def _build_simple_ground_mask(self, roi_color):
        # CLAHE illumination normalization: equalizes local contrast so dappled
        # tree shadows on concrete don't push pixels below the walkable-value floor.
        if bool(self.config.get("simple_edge_clahe_enabled", True)):
            clahe_clip = float(self.config.get("edge_line_clahe_clip", 2))
            clahe_tile = int(self.config.get("edge_line_clahe_tile", 8))
            lab = cv2.cvtColor(roi_color, cv2.COLOR_BGR2LAB)
            clahe = cv2.createCLAHE(clipLimit=clahe_clip, tileGridSize=(clahe_tile, clahe_tile))
            lab[:, :, 0] = clahe.apply(lab[:, :, 0])
            roi_color_eq = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
        else:
            roi_color_eq = roi_color

        hsv = cv2.cvtColor(roi_color_eq, cv2.COLOR_BGR2HSV)
        sat_limit = int(self.config.get("simple_edge_saturation_limit", 100))
        light_min = int(self.config.get("simple_edge_light_min", 55))
        min_area = int(self.config.get("simple_edge_component_min_area", 250))

        # Brightness gate: NOT a classifier, just a numerical-stability floor. Hue and
        # saturation are meaningless noise on a near-black pixel (a shadow void, a gap
        # between joints, deep mulch), so those pixels are excluded regardless of how
        # close their (unstable) hue happens to land to the sidewalk's. Local-adaptive
        # so a large dappled tree-shadow crossing the SAME sidewalk isn't excluded just
        # for reading darker than the sunlit majority of the ROI (confirmed 2026-07-08
        # field test, rc_edge_capture_2: a shadow's own outline got traced as a false
        # edge when this was a single scene-wide floor instead).
        if bool(self.config.get("simple_edge_local_adaptive_enabled", True)):
            local_block = int(self.config.get("simple_edge_local_block_px", 101)) | 1
            local_offset = int(self.config.get("simple_edge_local_offset", 25))
            local_mean = cv2.GaussianBlur(hsv[:, :, 2], (local_block, local_block), 0).astype(np.int32)
            local_floor = np.clip(local_mean - local_offset, 0, 255).astype(np.uint8)
            val_ok = hsv[:, :, 2] >= local_floor
        else:
            val_ok = hsv[:, :, 2] >= light_min

        # The sidewalk mask: not "bright and grey, minus a list of known-not-sidewalk
        # hues" (grass/mulch/near-black) -- that approach has coverage gaps by
        # construction, e.g. shaded grass desaturates below the grass-hue test's own
        # saturation floor and silently stops being excluded (confirmed on
        # screenshots/Screenshot 2026-06-30 at 10.42.14 AM.png: grass in tree shade
        # measured HSV (83, 28, 41) -- hue correctly in the grass band, but sat=28 is
        # under that test's sat>=40 requirement, so it read as "concrete"). Sample the
        # real sidewalk color directly beneath the rover instead -- bottom-center of
        # the ROI is always ground (Noah's own position, the same single-vantage point
        # _render_display anchors the carrot/edge rays to) -- and classify by distance
        # to THAT color. Grass fails on hue alone regardless of its saturation, which
        # is what actually fixes the shaded-grass case above.
        hh, ww = hsv.shape[:2]
        seed_row_frac = float(self.config.get("simple_edge_seed_row_frac", 0.94))
        half_w = int(self.config.get("simple_edge_seed_patch_half_w_px", 20))
        half_h = int(self.config.get("simple_edge_seed_patch_half_h_px", 12))
        sidewalk_mask = np.zeros((hh, ww), dtype=np.uint8)
        if hh > 2 * half_h and ww > 2 * half_w:
            sy = int(np.clip(hh * seed_row_frac, half_h, hh - 1 - half_h))
            sx = ww // 2
            patch = hsv[sy - half_h:sy + half_h + 1, sx - half_w:sx + half_w + 1]
            raw_h, raw_s, raw_v = (float(np.median(patch[:, :, c])) for c in range(3))
            # A shadow, a wet leaf, or an oil stain sitting exactly in the seed patch
            # this one tick isn't "the sidewalk" -- an implausible raw sample never
            # reaches the stabilizer at all, and classification for this frame just
            # falls back to the last known-good reference instead of losing
            # color-based classification entirely for one bad tick.
            plausible = raw_v >= light_min * 0.6 and raw_s <= sat_limit + 30
            seed_hsv = self._stable_ground_seed(raw_h, raw_s, raw_v) if plausible \
                else self._ground_seed_ref
            if seed_hsv is not None:
                seed_h, seed_s, seed_v = seed_hsv
                hue_tol = float(self.config.get("simple_edge_seed_hue_tol", 12))
                sat_tol = float(self.config.get("simple_edge_seed_sat_tol", 40))
                hue = hsv[:, :, 0].astype(np.int16)
                hue_diff = np.minimum(np.abs(hue - int(seed_h)), 180 - np.abs(hue - int(seed_h)))
                chromatic_ok = (hue_diff <= hue_tol) & \
                               (np.abs(hsv[:, :, 1].astype(np.int16) - int(seed_s)) <= sat_tol)
                # KNOWN GAP, not yet fixed: hue is meaningless on a fully desaturated
                # pixel (OpenCV just reports 0), and dappled tree shade on concrete can
                # knock saturation all the way to 0 while staying reasonably bright --
                # confirmed on a real capture
                # (logger/2026-07-09/5/rc_edge_capture_1/frame_1783624555840.jpg):
                # sunlit sidewalk measured HSV(13, 7, 191), the SAME slab in shade a few
                # feet away measured HSV(0, 0, 172). That fragments the sidewalk into
                # disconnected sunlit-only islands under dappled shade -- confirmed as a
                # real driver of low confidence that session (mean confidence 0.14, 44%
                # width anomalies even on ticks where the mask WAS the source). Tried an
                # achromatic exception (any sat-below-floor pixel counts as sidewalk
                # regardless of hue) two ways and rejected both against real data before
                # they shipped: unconditional -- reopened the shaded-grass gap this same
                # session, lawn under a bush measured HSV(110, 9, 76), sat=9, indistinguishable
                # from the concrete shadow by color alone; and dilation-bridged off a
                # denoised chromatic anchor -- the anchor itself was too sparse under
                # this much dappled shade (individual sunlit gaps between shadows often
                # under 100px) for a size filter to both drop lawn noise AND keep enough
                # anchor to bridge, collapsing back to a single ~300px fragment after
                # the full mask pipeline ran. Left as pure hue/sat distance (safe,
                # verified not to leak onto grass/lawn on two separate real photos) until
                # there's a fix that survives verification -- the depth-based
                # _apply_ground_grid_filter downstream is the more promising lever (real
                # geometry instead of more color heuristics) but untested here since
                # these captures have no paired depth to replay offline.
                sidewalk_mask = (chromatic_ok & val_ok).astype(np.uint8) * 255

        walkable = sidewalk_mask
        walkable = cv2.medianBlur(walkable, 5)
        walkable = cv2.morphologyEx(walkable, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        walkable = cv2.morphologyEx(walkable, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
        # Expansion/control joints between sidewalk slabs run the FULL width of the
        # sidewalk, so they touch the real grass/mulch edge at both ends -- that makes
        # them topologically one connected piece with the true exterior background,
        # NOT an enclosed hole (_fill_enclosed_regions below correctly leaves them
        # alone; confirmed by testing a synthetic joint, it stays one background
        # component with the surrounding grass). A tall, thin vertical closing kernel
        # bridges a short vertical break WITHIN A COLUMN regardless of what's on
        # either side of it -- since it's only 1px wide, it can't smear the left/right
        # edges sideways the way a wider kernel would, it only reconnects walkable
        # pixels above and below a joint-width gap in the same column.
        if bool(self.config.get("simple_edge_joint_bridge_enabled", True)):
            joint_bridge_px = int(self.config.get("simple_edge_joint_bridge_px", 40))
            walkable = cv2.morphologyEx(walkable, cv2.MORPH_CLOSE, np.ones((joint_bridge_px, 1), np.uint8))
        if bool(self.config.get("simple_edge_fill_enclosed_holes_enabled", True)):
            walkable = self._fill_enclosed_regions(walkable)

        if min_area > 0 and cv2.countNonZero(walkable) > 0:
            n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(walkable, connectivity=8)
            clean = np.zeros_like(walkable)
            for lbl in range(1, n_labels):
                if stats[lbl, cv2.CC_STAT_AREA] >= min_area:
                    clean[labels == lbl] = 255
            walkable = clean

        # non_walkable is just the logical complement now -- there's no separate
        # grass/mulch/dark hue classification anymore, walkable IS the sidewalk-color
        # test. mask_grad (the caller that needs this, in _detect_edges_hough's Hough
        # fallback) traces a boundary either way; tracing NOT(walkable) instead of a
        # separately-computed exclusion mask gives the identical boundary here.
        # green_mask_roi is returned as None -- only _validate_perspective_narrowing
        # (the non-live _detect_path_from_lines path) ever consumed it, and it
        # already treats None as "no green signal available."
        non_walkable = cv2.bitwise_not(walkable)
        return walkable, None, non_walkable

    def _fill_enclosed_regions(self, mask):
        # Expansion/control joints between sidewalk slabs, and small stains, patched
        # repairs, sun-bleached spots, leaves, or debris sitting on an otherwise
        # continuous sidewalk, all cut a dark or oddly-colored gap INTO the walkable
        # mask -- but none of them is a real edge. A real edge only ever borders the
        # mask from the side; anything fully enclosed by walkable pixels on every side
        # is just surface variation on the same slab. Left unfilled, a joint line
        # running the full width of the sidewalk would split what's visually one
        # continuous path into as many disconnected components as it has slabs --
        # _select_center_component can only pick ONE of those, so the row-boundary
        # trace would only ever see the single nearest slab instead of the whole
        # sidewalk ahead.
        #
        # Standard flood-fill-from-the-border hole fill: anything reachable from a
        # corner of the frame is real exterior background (grass/mulch); anything
        # that ISN'T reachable but also isn't already walkable is an enclosed hole --
        # fold it into walkable.
        h, w = mask.shape[:2]
        flood = mask.copy()
        filled_any = False
        for sx, sy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
            if flood[sy, sx] == 0:
                ff_mask = np.zeros((h + 2, w + 2), dtype=np.uint8)
                cv2.floodFill(flood, ff_mask, (sx, sy), 255)
                filled_any = True
        if not filled_any:
            return mask                          # every corner is already walkable -- nothing exterior to compare against
        holes = cv2.bitwise_not(flood)           # 255 only where a real hole was never reached from any corner
        return cv2.bitwise_or(mask, holes)

    def _stable_ground_seed(self, raw_h, raw_s, raw_v):
        # The sidewalk under the rover doesn't change tick to tick, so the reference
        # color shouldn't either -- a single frame's raw sample can land on a crack's
        # shadow, a wet leaf, or an oil stain, none of which is "the sidewalk," just
        # whatever happened to be under the rover this tick. A reading that disagrees
        # with the current reference is held as a PENDING candidate rather than
        # accepted immediately; only once the same divergence persists across several
        # consecutive frames -- a real regime change, e.g. rain soaking in, or moving
        # onto a different house's sidewalk -- does it get accepted as the new
        # reference. A one-off divergent tick never moves the reference at all.
        if self._ground_seed_ref is None:
            self._ground_seed_ref = (raw_h, raw_s, raw_v)
            self._ground_seed_pending = None
            return self._ground_seed_ref

        ref_h, ref_s, ref_v = self._ground_seed_ref
        hue_diff = min(abs(raw_h - ref_h), 180 - abs(raw_h - ref_h))
        sat_diff = abs(raw_s - ref_s)
        val_diff = abs(raw_v - ref_v)
        # Wider than the per-pixel classification tolerance below -- this gate decides
        # whether the WHOLE-FRAME sample still looks like the established sidewalk,
        # not whether one pixel is close enough to count as walkable.
        hue_tol = float(self.config.get("simple_edge_seed_hue_tol", 12)) * 1.5
        sat_tol = float(self.config.get("simple_edge_seed_sat_tol", 40)) * 1.5
        val_tol = float(self.config.get("simple_edge_seed_val_tol", 45))
        if hue_diff <= hue_tol and sat_diff <= sat_tol and val_diff <= val_tol:
            self._ground_seed_pending = None
            alpha = float(self.config.get("simple_edge_seed_ema_alpha", 0.08))
            delta = raw_h - ref_h
            if delta > 90:
                delta -= 180
            elif delta < -90:
                delta += 180
            self._ground_seed_ref = (
                (ref_h + alpha * delta) % 180.0,
                ref_s + alpha * (raw_s - ref_s),
                ref_v + alpha * (raw_v - ref_v),
            )
            return self._ground_seed_ref

        pending = self._ground_seed_pending
        persist_needed = int(self.config.get("simple_edge_seed_persist_frames", 8))
        if pending is not None and \
                min(abs(raw_h - pending["h"]), 180 - abs(raw_h - pending["h"])) <= hue_tol and \
                abs(raw_s - pending["s"]) <= sat_tol and abs(raw_v - pending["v"]) <= val_tol:
            pending["count"] += 1
        else:
            pending = {"h": raw_h, "s": raw_s, "v": raw_v, "count": 1}
        self._ground_seed_pending = pending

        if pending["count"] >= persist_needed:
            self._ground_seed_ref = (raw_h, raw_s, raw_v)
            self._ground_seed_pending = None

        return self._ground_seed_ref

    def _select_center_component(self, walkable_mask):
        if cv2.countNonZero(walkable_mask) == 0:
            return walkable_mask
        n_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(walkable_mask, connectivity=8)
        if n_labels <= 1:
            return walkable_mask

        w = walkable_mask.shape[1]
        cx = w / 2.0
        best_lbl = min(range(1, n_labels), key=lambda lbl: abs(centroids[lbl][0] - cx))

        result = np.zeros_like(walkable_mask)
        result[labels == best_lbl] = 255
        return result

    def _sample_depth_at(self, roi_depth, x_px, y_px, radius=3):
        h, w = roi_depth.shape
        x0 = max(0, int(x_px) - radius)
        x1 = min(w, int(x_px) + radius + 1)
        y0 = max(0, int(y_px) - radius)
        y1 = min(h, int(y_px) + radius + 1)
        patch = roi_depth[y0:y1, x0:x1]
        valid = patch[np.isfinite(patch) & (patch > 0)]
        if valid.size == 0:
            return None
        return float(np.median(valid))

    def _detect_path_from_lines(self, color_image, depth_image, intrinsics):
        # Line-only edge detector: build a simple walkable strip mask, keep the
        # most central connected component, then extract the nearest left/right
        # edge positions from that mask.
        height, width = depth_image.shape[:2]
        row_start = int(height * float(self.config.get("edge_roi_top_frac", 0.40)))
        row_end = int(height * float(self.config.get("edge_roi_bottom_frac", 0.95)))
        row_start = int(np.clip(row_start, 0, height - 2))
        row_end = int(np.clip(max(row_start + 2, row_end), row_start + 2, height))

        roi_color = color_image[row_start:row_end, :]
        roi_depth = depth_image[row_start:row_end, :].astype(np.float32) * 0.001
        roi_depth[roi_depth <= 0] = np.nan

        walkable_mask, green_mask_roi, _nw = self._build_simple_ground_mask(roi_color)
        walkable_mask = self._select_center_component(walkable_mask)
        walkable_mask = self._apply_ground_grid_filter(walkable_mask, roi_depth, intrinsics, row_start)

        if not self._validate_perspective_narrowing(walkable_mask, green_mask_roi, roi_depth):
            # Guidance is invalid, but still serve per-side cached edge positions
            # independently — a perspective-check failure must not silently zero
            # both edges when only one is off-screen or momentarily undetectable.
            _now = time.time()
            _ttl = float(self.config.get("edge_known_ttl_ms", 5000))
            def _stale(side):
                prev = self.last_edge_obs.get(side)
                if prev is None:
                    return None, None, False
                age = (_now - float(prev.get("ts", _now))) * 1000.0
                return (prev, age, True) if age <= _ttl else (None, None, False)
            _lk, _la, _lok = _stale("left")
            _rk, _ra, _rok = _stale("right")
            return {
                "offset_meters": 0,
                "path_width_meters": self.last_path_width_meters,
                "confidence": 0,
                "left_boundary_visible": False,
                "right_boundary_visible": False,
                "centerline": [],
                "nearest_edge_m": None,
                "nearest_edge_side": None,
                "nearest_edge_clearance_m": None,
                "nearest_edge_type": None,
                "left_edge_clearance_m": None,
                "right_edge_clearance_m": None,
                "edge_left_m": round(float(_lk["m"]), 4) if _lok else None,
                "edge_left_conf": round(float(_lk["confidence"]), 2) if _lok else 0.0,
                "edge_left_x_m": round(float(_lk["x_distance_m"]), 4) if _lok else None,
                "edge_left_y_m": round(float(_lk["y_distance_m"]), 3) if _lok else None,
                "edge_left_known": bool(_lok),
                "edge_left_known_age_ms": round(float(_la), 1) if _la is not None else None,
                "edge_right_m": round(float(_rk["m"]), 4) if _rok else None,
                "edge_right_conf": round(float(_rk["confidence"]), 2) if _rok else 0.0,
                "edge_right_x_m": round(float(_rk["x_distance_m"]), 4) if _rok else None,
                "edge_right_y_m": round(float(_rk["y_distance_m"]), 3) if _rok else None,
                "edge_right_known": bool(_rok),
                "edge_right_known_age_ms": round(float(_ra), 1) if _ra is not None else None,
                "edge_used": "none",
                "edge_target_offset_m": None,
                "edge_forward_m": None,
                "edge_guidance_valid": False,
                "ground_grid_removed_frac": self._last_ground_removed_frac,
                "nearest_seen_left_edge": _lk if _lok else {"seen": False, "x_distance_m": None, "y_distance_m": None, "confidence": 0.0},
                "nearest_seen_right_edge": _rk if _rok else {"seen": False, "x_distance_m": None, "y_distance_m": None, "confidence": 0.0},
                "status": "perspective_invalid",
            }

        h, w = walkable_mask.shape
        n_bands = int(self.config.get("edge_line_bands", 6))
        band_h = max(1, h // n_bands)
        lookahead_frac = float(self.config.get("edge_line_lookahead_frac", 0.82))
        y_look = int(np.clip(h * lookahead_frac, 0, h - 1))
        ppx, ppy = intrinsics.ppx, intrinsics.ppy
        fx, fy = intrinsics.fx, intrinsics.fy
        pitch = float(self.current_pitch_rad)
        roll = float(self.current_roll_rad)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll), math.sin(roll)

        def edge_obs_from_px(x_px, y_px, seg_len_px):
            depth_m = self._sample_depth_at(roi_depth, x_px, y_px)
            if not depth_m or np.isnan(depth_m) or depth_m < 0.15 or depth_m > 8.0:
                return None
            full_y = row_start + y_px
            cam_X = (x_px - ppx) * depth_m / fx
            cam_Y = (full_y - ppy) * depth_m / fy
            rolled_X = cr * cam_X - sr * cam_Y
            rolled_Y = sr * cam_X + cr * cam_Y
            forward_m = sp * rolled_Y + cp * depth_m
            if forward_m < 0.1 or forward_m > 8.0:
                return None
            confidence = 0.45 + min(0.5, float(seg_len_px) / 260.0)
            confidence = float(max(0.0, min(0.99, confidence)))
            return {
                "seen": True,
                "x_distance_m": round(float(rolled_X), 4),
                "y_distance_m": round(float(forward_m), 3),
                "confidence": round(float(confidence), 2),
                "m": round(float(-rolled_X), 4),
                "x_m": round(float(rolled_X), 4),
                "y_m": round(float(forward_m), 3),
                "ts": time.time(),
            }

        nearest_left = None
        nearest_right = None
        for i in range(n_bands):
            r0 = i * band_h
            r1 = min(h, r0 + band_h) if i < n_bands - 1 else h
            if r1 - r0 < 4:
                continue

            band_mask = walkable_mask[r0:r1, :]
            band_scores = band_mask.mean(axis=0) / 255.0
            # Independent per-side edges: a boundary touching the image border is out
            # of view and returns None for THAT side alone, so losing one edge never
            # nulls the other. find_nearest_mask_edges returned both ends of one run
            # together — the coupling behind "both edges disappear at once". This is
            # the documented A/B rollback detector (detect_path -> edge_hough_detector:
            # false); _detect_edges_hough is the live default.
            left_px, right_px = self.find_independent_edges(
                band_scores,
                threshold=float(self.config.get("edge_mask_threshold", 0.14)),
                min_run_px=int(self.config.get("edge_min_run_px", 6)),
                border_px=int(self.config.get("edge_border_margin_px", 2)),
            )
            if left_px is None and right_px is None:
                continue

            band_y = int((r0 + r1) / 2.0)
            if left_px is not None:
                seg_len = max(1, int(np.count_nonzero(band_mask[:, max(0, left_px - 1):min(w, left_px + 2)])))
                obs = edge_obs_from_px(left_px, band_y, seg_len)
                if obs is not None and (nearest_left is None or obs["y_distance_m"] < nearest_left["y_distance_m"]):
                    nearest_left = obs
            if right_px is not None:
                seg_len = max(1, int(np.count_nonzero(band_mask[:, max(0, right_px - 1):min(w, right_px + 2)])))
                obs = edge_obs_from_px(right_px, band_y, seg_len)
                if obs is not None and (nearest_right is None or obs["y_distance_m"] < nearest_right["y_distance_m"]):
                    nearest_right = obs

        # Update per-side cached values with the newest seen edges (EMA-smoothed).
        now_ts = time.time()
        ttl_ms = float(self.config.get("edge_known_ttl_ms", 5000))
        if nearest_left is not None:
            nearest_left = self._smooth_obs("left", nearest_left)
            self.last_edge_obs["left"] = nearest_left
        if nearest_right is not None:
            nearest_right = self._smooth_obs("right", nearest_right)
            self.last_edge_obs["right"] = nearest_right

        def known(side, cur):
            if cur is not None:
                return cur, 0.0, True
            prev = self.last_edge_obs.get(side)
            if prev is None:
                return None, None, False
            age_ms = (now_ts - float(prev.get("ts", now_ts))) * 1000.0
            if age_ms > ttl_ms:
                return None, None, False
            return prev, age_ms, True

        left_k, left_age_ms, left_ok = known("left", nearest_left)
        right_k, right_age_ms, right_ok = known("right", nearest_right)
        # Reset EMA when an edge is fully lost (no current detection + TTL expired)
        # so the next detection doesn't blend into a stale position.
        if not left_ok and nearest_left is None:
            self._edge_smooth["left"] = None
        if not right_ok and nearest_right is None:
            self._edge_smooth["right"] = None

        side_offset_m = float(self.config.get("edge_side_offset_m", 0.5))
        use = "none"
        if nearest_left is not None and nearest_right is not None:
            use = "center"
        elif nearest_left is not None:
            use = "left"
        elif nearest_right is not None:
            use = "right"

        valid = use in ("left", "right", "center")
        target_offset = 0.0
        chosen_conf = 0.0
        edge_forward_m = None
        if use == "center":
            target_offset = (nearest_left["m"] + nearest_right["m"]) / 2.0
            edge_forward_m = (nearest_left["y_distance_m"] + nearest_right["y_distance_m"]) / 2.0
            chosen_conf = (nearest_left["confidence"] + nearest_right["confidence"]) / 2.0
        elif valid:
            chosen = nearest_left if use == "left" else nearest_right
            target_offset = chosen["m"] - side_offset_m if use == "left" else chosen["m"] + side_offset_m
            edge_forward_m = chosen["y_distance_m"]
            chosen_conf = chosen["confidence"]

        x_angle_deg = math.degrees(math.atan2(-target_offset, max(0.1, edge_forward_m))) if valid else 0.0
        width_m = self.last_path_width_meters
        if nearest_left is not None and nearest_right is not None:
            current_width = abs(nearest_left["m"] - nearest_right["m"])
            if 0.4 <= current_width <= 2.0:
                width_m = current_width
                self.last_path_width_meters = current_width

        return {
            "x_angle_deg": round(float(x_angle_deg), 2),
            "offset_meters": round(float(target_offset), 4) if valid else 0.0,
            "path_width_meters": round(float(width_m), 4),
            "confidence": round(float(chosen_conf), 2) if valid else 0.0,
            "left_boundary_visible": nearest_left is not None,
            "right_boundary_visible": nearest_right is not None,
            "centerline": [],
            "nearest_edge_m": edge_forward_m,
            "nearest_edge_side": use if valid else None,
            "nearest_edge_clearance_m": None,
            "nearest_edge_type": "boundary" if valid else None,
            "left_edge_clearance_m": None,
            "right_edge_clearance_m": None,
            "edge_left_m": round(float(left_k["m"]), 4) if left_ok else None,
            "edge_left_conf": round(float(left_k["confidence"]), 2) if left_ok else 0.0,
            "edge_left_x_m": round(float(left_k["x_distance_m"]), 4) if left_ok else None,
            "edge_left_y_m": round(float(left_k["y_distance_m"]), 3) if left_ok else None,
            "edge_left_known": bool(left_ok),
            "edge_left_known_age_ms": round(float(left_age_ms), 1) if left_age_ms is not None else None,
            "edge_right_m": round(float(right_k["m"]), 4) if right_ok else None,
            "edge_right_conf": round(float(right_k["confidence"]), 2) if right_ok else 0.0,
            "edge_right_x_m": round(float(right_k["x_distance_m"]), 4) if right_ok else None,
            "edge_right_y_m": round(float(right_k["y_distance_m"]), 3) if right_ok else None,
            "edge_right_known": bool(right_ok),
            "edge_right_known_age_ms": round(float(right_age_ms), 1) if right_age_ms is not None else None,
            "edge_used": use,
            "edge_target_offset_m": round(float(target_offset), 4) if valid else None,
            "edge_forward_m": round(float(edge_forward_m), 3) if edge_forward_m is not None else None,
            "edge_guidance_valid": bool(valid),
            "edge_mask_source": None,  # _detect_path_from_lines doesn't distinguish a mask/hough source
            "ground_grid_removed_frac": self._last_ground_removed_frac,
            "nearest_seen_left_edge": left_k if left_ok else {"seen": False, "x_distance_m": None, "y_distance_m": None, "confidence": 0.0},
            "nearest_seen_right_edge": right_k if right_ok else {"seen": False, "x_distance_m": None, "y_distance_m": None, "confidence": 0.0},
            "status": "tracking" if valid else "low_confidence",
        }

    def _predict_and_score(self, side, obs):
        # Ground-truth check: a real, physical edge is a fixed point in the world, so
        # rotating last tick's accepted point by exactly how much Noah's heading has
        # changed since predicts exactly where it must reappear now. Only evaluated
        # when heading has genuinely changed enough to matter (a steering correction,
        # a gate turn, or a deliberate verification yaw) -- with near-zero heading
        # change the rotation-only model can't also account for forward travel, so
        # it stays inert rather than penalizing a real edge just for Noah driving
        # straight toward it. (x_m = right-positive, y_m = forward-positive, matching
        # line_to_obs's own convention.)
        prev = self._edge_residual_prev.get(side)
        heading = self.current_heading_deg
        if obs is None or heading is None:
            self._edge_residual_prev[side] = None
            return obs
        scored = obs
        if prev is not None:
            max_age_s = float(self.config.get("edge_residual_max_age_s", 1.0))
            age_s = float(obs.get("ts", time.time())) - float(prev.get("ts", 0.0))
            dtheta_deg = ((heading - prev["heading_deg"] + 180.0) % 360.0) - 180.0
            min_dtheta_deg = float(self.config.get("edge_residual_min_dtheta_deg", 3.0))
            if 0 < age_s <= max_age_s and abs(dtheta_deg) >= min_dtheta_deg:
                theta = math.radians(dtheta_deg)
                cos_t, sin_t = math.cos(theta), math.sin(theta)
                px, py = float(prev["x_m"]), float(prev["y_m"])
                pred_x = cos_t * px - sin_t * py
                pred_y = sin_t * px + cos_t * py
                residual_m = math.hypot(float(obs["x_m"]) - pred_x, float(obs["y_m"]) - pred_y)
                scale_m = float(self.config.get("edge_residual_scale_m", 0.35))
                # Fail-safe by construction: this can only ever REDUCE confidence,
                # never raise it above what the detector's own fit quality produced,
                # and never below a floor -- a wrong sign or a noisy heading tick
                # degrades toward "trust it less," not "discard it outright."
                mult = max(0.4, 1.0 - residual_m / scale_m) if scale_m > 0 else 1.0
                scored = dict(obs)
                scored["confidence"] = round(float(obs["confidence"]) * min(1.0, mult), 3)
        self._edge_residual_prev[side] = {
            "x_m": float(obs["x_m"]), "y_m": float(obs["y_m"]),
            "heading_deg": heading, "ts": float(obs.get("ts", time.time())),
        }
        return scored

    def _assemble_edge_result(self, nearest_left, nearest_right,
                               left_bands=None, right_bands=None, centerline=None, edge_source=None):
        # Shared output contract for the edge detectors: per-side TTL cache, known()
        # state, edge selection, target offset, steering angle. Identical dict shape to
        # _detect_path_from_lines so the LCD / message handler / steering are unchanged.
        now_ts = time.time()
        ttl_ms = float(self.config.get("edge_known_ttl_ms", 5000))
        min_lat_m = float(self.config.get("edge_min_lateral_m", 0.4))
        if nearest_left is not None and abs(float(nearest_left.get("x_distance_m", 0.0))) < min_lat_m:
            nearest_left = None
        if nearest_right is not None and abs(float(nearest_right.get("x_distance_m", 0.0))) < min_lat_m:
            nearest_right = None
        # Left edge must be to the left of camera center (negative x), right must be positive.
        if nearest_left is not None and float(nearest_left.get("x_distance_m", 0.0)) > 0:
            nearest_left = None
        if nearest_right is not None and float(nearest_right.get("x_distance_m", 0.0)) < 0:
            nearest_right = None
        nearest_left  = self._predict_and_score("left",  nearest_left)
        nearest_right = self._predict_and_score("right", nearest_right)
        if nearest_left is not None:
            nearest_left = self._smooth_obs("left", nearest_left)
            self.last_edge_obs["left"] = nearest_left
        if nearest_right is not None:
            nearest_right = self._smooth_obs("right", nearest_right)
            self.last_edge_obs["right"] = nearest_right

        def known(side, cur):
            if cur is not None:
                return cur, 0.0, True
            prev = self.last_edge_obs.get(side)
            if prev is None:
                return None, None, False
            age_ms = (now_ts - float(prev.get("ts", now_ts))) * 1000.0
            if age_ms > ttl_ms:
                return None, None, False
            return prev, age_ms, True

        left_k, left_age_ms, left_ok = known("left", nearest_left)
        right_k, right_age_ms, right_ok = known("right", nearest_right)
        if not left_ok and nearest_left is None:
            self._edge_smooth["left"] = None
        if not right_ok and nearest_right is None:
            self._edge_smooth["right"] = None

        # This is the live decision (detect_path -> _detect_edges_hough -> here, per
        # setup.json's edge_hough_detector: true). Hysteresis via _apply_edge_use_hysteresis
        # stops "use" from mode-flipping between center/left/right every time a borderline
        # edge's confidence jitters a few percent frame to frame -- see that method's
        # docstring. natural_use is what this tick's raw detections alone would pick;
        # _apply_edge_use_hysteresis is what actually decides whether to switch to it.
        #
        # Single-edge offset: hold HALF THE ACTUAL SIDEWALK WIDTH off the one visible
        # edge, not a fixed generic distance -- last_path_width_meters is the width
        # measured the last time both edges were seen together (or the 0.9m startup
        # default before that's ever happened), so this tracks whatever width THIS
        # sidewalk actually runs instead of assuming every sidewalk is edge_side_offset_m
        # x2 wide. Same idea as mowing along one edge once you know the strip's width.
        side_offset_m = self.last_path_width_meters / 2.0
        left_m    = nearest_left["m"]    if nearest_left  is not None else None
        left_conf = nearest_left["confidence"] if nearest_left  is not None else 0.0
        right_m    = nearest_right["m"]    if nearest_right is not None else None
        right_conf = nearest_right["confidence"] if nearest_right is not None else 0.0

        if left_m is not None and right_m is not None:
            natural_use = "center"
        elif left_m is not None:
            natural_use = "left"
        elif right_m is not None:
            natural_use = "right"
        else:
            natural_use = "none"

        use = (self._apply_edge_use_hysteresis(natural_use, left_m, left_conf, right_m, right_conf)
               if natural_use != "none" else "none")

        valid = use in ("left", "right", "center")
        target_offset = 0.0
        chosen_conf = 0.0
        edge_forward_m = None
        if use == "center":
            target_offset = (nearest_left["m"] + nearest_right["m"]) / 2.0
            edge_forward_m = (nearest_left["y_distance_m"] + nearest_right["y_distance_m"]) / 2.0
            chosen_conf = (nearest_left["confidence"] + nearest_right["confidence"]) / 2.0
        elif valid:
            chosen = nearest_left if use == "left" else nearest_right
            target_offset = chosen["m"] - side_offset_m if use == "left" else chosen["m"] + side_offset_m
            edge_forward_m = chosen["y_distance_m"]
            chosen_conf = chosen["confidence"]

        x_angle_deg = math.degrees(math.atan2(-target_offset, max(0.1, edge_forward_m))) if valid else 0.0
        width_m = self.last_path_width_meters
        if nearest_left is not None and nearest_right is not None:
            current_width = abs(nearest_left["m"] - nearest_right["m"])
            if 0.4 <= current_width <= 2.0:
                width_m = current_width
                self.last_path_width_meters = current_width

        return {
            "x_angle_deg": round(float(x_angle_deg), 2),
            "offset_meters": round(float(target_offset), 4) if valid else 0.0,
            "path_width_meters": round(float(width_m), 4),
            "confidence": round(float(chosen_conf), 2) if valid else 0.0,
            "left_boundary_visible": nearest_left is not None,
            "right_boundary_visible": nearest_right is not None,
            "centerline": centerline if centerline is not None else [],
            "edge_left_bands": left_bands if left_bands is not None else [],
            "edge_right_bands": right_bands if right_bands is not None else [],
            "nearest_edge_m": edge_forward_m,
            "nearest_edge_side": use if valid else None,
            "nearest_edge_clearance_m": None,
            "nearest_edge_type": "boundary" if valid else None,
            "left_edge_clearance_m": None,
            "right_edge_clearance_m": None,
            "edge_left_m": round(float(left_k["m"]), 4) if left_ok else None,
            "edge_left_conf": round(float(left_k["confidence"]), 2) if left_ok else 0.0,
            "edge_left_x_m": round(float(left_k["x_distance_m"]), 4) if left_ok else None,
            "edge_left_y_m": round(float(left_k["y_distance_m"]), 3) if left_ok else None,
            "edge_left_known": bool(left_ok),
            "edge_left_known_age_ms": round(float(left_age_ms), 1) if left_age_ms is not None else None,
            "edge_right_m": round(float(right_k["m"]), 4) if right_ok else None,
            "edge_right_conf": round(float(right_k["confidence"]), 2) if right_ok else 0.0,
            "edge_right_x_m": round(float(right_k["x_distance_m"]), 4) if right_ok else None,
            "edge_right_y_m": round(float(right_k["y_distance_m"]), 3) if right_ok else None,
            "edge_right_known": bool(right_ok),
            "edge_right_known_age_ms": round(float(right_age_ms), 1) if right_age_ms is not None else None,
            "edge_used": use,
            "edge_target_offset_m": round(float(target_offset), 4) if valid else None,
            "edge_forward_m": round(float(edge_forward_m), 3) if edge_forward_m is not None else None,
            "edge_guidance_valid": bool(valid),
            # "mask" | "hough" | None -- which candidate-generation path actually ran
            # this tick in _detect_edges_hough (None from _detect_path_from_lines,
            # which doesn't distinguish). Exists so a session can be audited
            # tick-by-tick afterward instead of inferring it from how the display
            # overlay looks (the mask-vs-corridor green fill is a good visual cue,
            # not a substitute for the real value).
            "edge_mask_source": edge_source,
            "ground_grid_removed_frac": self._last_ground_removed_frac,
            "nearest_seen_left_edge": left_k if left_ok else {"seen": False, "x_distance_m": None, "y_distance_m": None, "confidence": 0.0},
            "nearest_seen_right_edge": right_k if right_ok else {"seen": False, "x_distance_m": None, "y_distance_m": None, "confidence": 0.0},
            "status": "tracking" if valid else "low_confidence",
        }

    def _detect_edges_hough(self, color_image, depth_image, intrinsics):
        # Independent left/right edge detection, lane-departure style. Canny + color-class
        # boundary + depth drop-off -> HoughLinesP -> fit ONE line per side, each on its
        # own. Losing one edge can never affect the other (no shared blob / run). Emits the
        # same edge_* contract as _detect_path_from_lines via _assemble_edge_result.
        cfg = self.config
        height, width = depth_image.shape[:2]
        row_start = int(height * float(cfg.get("edge_roi_top_frac", 0.40)))
        row_end = int(height * float(cfg.get("edge_roi_bottom_frac", 0.95)))
        row_start = int(np.clip(row_start, 0, height - 2))
        row_end = int(np.clip(max(row_start + 2, row_end), row_start + 2, height))

        roi_color = color_image[row_start:row_end, :]
        roi_depth = depth_image[row_start:row_end, :].astype(np.float32) * 0.001
        roi_depth[roi_depth <= 0] = np.nan
        h, w = roi_color.shape[:2]
        center_x = w * 0.5

        blur_k = int(cfg.get("edge_line_blur_k", 5)) | 1   # force odd kernel
        canny_low = int(cfg.get("edge_line_canny_low", 45))
        canny_high = int(cfg.get("edge_line_canny_high", 130))
        hough_thr = int(cfg.get("edge_line_hough_threshold", 30))
        min_len = int(cfg.get("edge_line_min_len_px", 30))
        max_gap = int(cfg.get("edge_line_max_gap_px", 20))
        min_slope = float(cfg.get("edge_line_min_abs_slope", 0.25))
        depth_jump_m = float(cfg.get("dropoff_min_depth_jump_m", 0.15))

        # --- 1. Primary edge source: the color-mask blob's own boundary.
        # _build_simple_ground_mask already separates concrete (bright, low-saturation)
        # from mulch/grass/near-black by hue, and _select_center_component (used
        # elsewhere, e.g. _detect_path_from_lines) already isolates the single connected
        # blob nearest image-center -- the actual patch of sidewalk the rover is
        # standing on. This detector used to skip both and run a global Hough line
        # search over the whole ROI, sorting whatever segments came back into left/right
        # purely by which side of image-center they fell on, with no rule tying a
        # candidate back to the walkable blob under the rover. A long, clean transition
        # far in the background (a driveway line, the curb across the street) could
        # out-compete the real, near, one-color sidewalk edge just by being a
        # longer/straighter Hough segment (confirmed 2026-07-09,
        # logger/2026-07-09/3/rc_edge_capture_3/frame_1783617414730.jpg: left edge
        # reported 2.9m left / 4.6m ahead -- the far curb across the street -- while the
        # real edge sat inches from the wheels). Reading the selected blob's own
        # leftmost/rightmost column per row can never pick a boundary that isn't part
        # of that blob.
        edge_img = np.zeros((h, w), dtype=np.uint8)
        walkable_mask = None
        non_walkable_mask = None
        center_mask = None
        try:
            walkable_mask, _gm, non_walkable_mask = self._build_simple_ground_mask(roi_color)
            # Depth-based sanity check: mulch beds are rarely perfectly coplanar with
            # the sidewalk, so this drops appearance false-positives
            # (screenshots/Screenshot 2026-07-07 at 2.27.13 PM.png, 2.45.15 PM.png) at
            # zero added latency.
            walkable_mask = self._apply_ground_grid_filter(walkable_mask, roi_depth, intrinsics, row_start)
            center_mask = self._select_center_component(walkable_mask)
            if self.display_enabled:
                self._last_display_row_start = row_start
                self._last_display_row_end = row_end
        except Exception:
            pass

        mask_min_row_w = int(cfg.get("edge_mask_min_row_width_px", 8))
        mask_min_rows = int(cfg.get("edge_mask_min_rows", 6))
        mask_boundary_enabled = bool(cfg.get("edge_mask_boundary_enabled", True))
        # fit_side (below) feeds every (y, x) pair through _sample_depth_at, a per-point
        # depth median -- fine for a couple dozen Hough segment endpoints, too much for
        # every one of ~300-400 ROI rows at a 250ms tick budget. Scan every row for the
        # boundary itself (cheap: one np.nonzero per row) but cap how many rows actually
        # go on to depth sampling, spread evenly top-to-bottom so the near-field window
        # inside fit_side still has real far-side context to anchor against.
        mask_max_fit_points = int(cfg.get("edge_mask_max_fit_points", 80))
        sides = {"left": {"ys": [], "xs": [], "wts": [], "len": 0.0},
                 "right": {"ys": [], "xs": [], "wts": [], "len": 0.0}}
        if mask_boundary_enabled and center_mask is not None and cv2.countNonZero(center_mask) > 0:
            row_ys, row_left, row_right = [], [], []
            for y in range(h):
                cols = np.nonzero(center_mask[y])[0]
                if cols.size == 0:
                    continue
                x_left_px, x_right_px = float(cols[0]), float(cols[-1])
                if (x_right_px - x_left_px) < mask_min_row_w:
                    continue                        # too thin a slice at this row to trust as the real width
                row_ys.append(float(y)); row_left.append(x_left_px); row_right.append(x_right_px)
            if len(row_ys) > mask_max_fit_points:
                keep_idx = np.linspace(0, len(row_ys) - 1, mask_max_fit_points).round().astype(int)
                row_ys = [row_ys[i] for i in keep_idx]
                row_left = [row_left[i] for i in keep_idx]
                row_right = [row_right[i] for i in keep_idx]
            sides["left"]["ys"] = list(row_ys); sides["left"]["xs"] = list(row_left)
            sides["left"]["wts"] = [1.0] * len(row_ys); sides["left"]["len"] = float(len(row_ys))
            sides["right"]["ys"] = list(row_ys); sides["right"]["xs"] = list(row_right)
            sides["right"]["wts"] = [1.0] * len(row_ys); sides["right"]["len"] = float(len(row_ys))

        use_mask_source = (len(sides["left"]["ys"]) >= mask_min_rows and
                            len(sides["right"]["ys"]) >= mask_min_rows)
        if self.display_enabled:
            # Shown by _render_display as the green overlay -- exactly the blob this
            # tick's edges were actually read from, not a separately-computed corridor.
            self._last_display_center_mask = center_mask if use_mask_source else None

        if not use_mask_source:
            # Fallback only: the color mask under the rover was too broken to trace
            # (glare, deep shadow, wet concrete splitting the blob) -- run the previous
            # color-boundary-gradient + depth-dropoff + Hough fit instead.
            sides = {"left": {"ys": [], "xs": [], "wts": [], "len": 0.0},
                     "right": {"ys": [], "xs": [], "wts": [], "len": 0.0}}
            if non_walkable_mask is not None:
                # mask_grad traces non_walkable_mask's boundary (grass/mulch/near-black hue
                # classes) rather than walkable_mask's -- walkable_mask also carries a
                # brightness-relative "bright enough to be concrete" test, and a shadow
                # boundary IS a brightness discontinuity with no hue change at all, so its
                # boundary shows up in walkable_mask's gradient exactly like a real edge
                # (confirmed 2026-07-08 field test, rc_edge_capture_2: both edge lines
                # locked onto a tree-canopy shadow outline crossing the sidewalk). A
                # boundary in non_walkable_mask means a real material actually changed
                # (concrete->grass, concrete->mulch, concrete->near-black) -- a shadow
                # alone, staying within the same low-saturation/non-green/non-mulch hue
                # class the whole way through, never crosses it.
                mask_grad = cv2.morphologyEx(non_walkable_mask, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
                edge_img = cv2.bitwise_or(edge_img, mask_grad)

            # depth drop-off (curb / grass step): a big horizontal depth jump is an edge pixel
            valid_d = ~np.isnan(roi_depth)
            d_filled = np.where(valid_d, roi_depth, 0.0).astype(np.float32)
            dd = np.abs(np.diff(d_filled, axis=1))
            depth_mask = np.zeros((h, w), dtype=np.uint8)
            depth_mask[:, 1:][dd > depth_jump_m] = 255
            depth_mask[~valid_d] = 0
            edge_img = cv2.bitwise_or(edge_img, depth_mask)

            # --- 2. Hough line segments
            segments = cv2.HoughLinesP(edge_img, 1, math.pi / 180.0, hough_thr,
                                       minLineLength=min_len, maxLineGap=max_gap)
            if segments is None or len(segments) == 0:
                return self._assemble_edge_result(None, None, edge_source="hough")

            # --- 3. Fit ONE line per side, independently (x = a*y + b, weighted by length)
            for seg in segments:
                x1, y1, x2, y2 = (float(v) for v in seg[0])
                dx = x2 - x1
                dy = y2 - y1
                seg_len = math.hypot(dx, dy)
                steep = abs(dy) / max(abs(dx), 1e-6)   # vertical -> large, horizontal -> ~0
                if steep < min_slope:
                    continue                           # drop near-horizontal clutter (horizon, cracks)
                # The nearest (largest-y) endpoint decides the side: a left edge sits left of
                # image center at the bottom of the ROI, a right edge to the right.
                x_bottom = x1 if y1 >= y2 else x2
                side = "left" if x_bottom < center_x else "right"
                s = sides[side]
                s["ys"].extend([y1, y2])
                s["xs"].extend([x1, x2])
                s["wts"].extend([seg_len, seg_len])
                s["len"] += seg_len

        # Needed inside fit_side below to turn pixel points into real-world forward
        # distance, so the near-field cluster window is a real distance (inches),
        # not a pixel-row count that covers a few inches up close but many feet far away.
        ppx, ppy = intrinsics.ppx, intrinsics.ppy
        fx, fy = intrinsics.fx, intrinsics.fy
        pitch = float(self.current_pitch_rad)
        roll = float(self.current_roll_rad)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll), math.sin(roll)
        near_field_window_m = float(cfg.get("edge_line_near_field_window_m", 0.3048))  # 12 in

        def fit_side(s):
            # Anchor at the REAL nearest detected point (smallest actual forward
            # distance), not an assumed frame corner -- forcing a line through a point
            # that isn't real (the sidewalk usually doesn't span the full camera width)
            # requires an extreme slope to also hit the real data a few rows away,
            # which is what produced both the triangle and, worse, a slope so steep it
            # shoots off-frame within the ROI (confirmed: forcing the corner measured
            # a=-23.4, landing at x=3814 by row 100). The angle itself is fit only from
            # the near-field cluster around that anchor (within near_field_window_m),
            # not blended with far-away points. For display, this line is simply drawn
            # down to the bottom row wherever the real geometry puts it -- not forced.
            if len(s["ys"]) < 2 or s["len"] <= 0:
                return None
            try:
                ys_arr = np.asarray(s["ys"])
                xs_arr = np.asarray(s["xs"])
                wts_arr = np.asarray(s["wts"])
                forward_m = np.full(ys_arr.shape, np.nan)
                for i in range(ys_arr.size):
                    d = self._sample_depth_at(roi_depth, int(round(xs_arr[i])), int(round(ys_arr[i])))
                    if not d or np.isnan(d):
                        continue
                    full_y = row_start + ys_arr[i]
                    cam_X = (xs_arr[i] - ppx) * d / fx
                    cam_Y = (full_y - ppy) * d / fy
                    rolled_Y = sr * cam_X + cr * cam_Y
                    forward_m[i] = sp * rolled_Y + cp * d
                valid = ~np.isnan(forward_m)
                if not np.any(valid):
                    return None
                valid_idx = np.where(valid)[0]
                anchor_i = int(valid_idx[np.argmin(forward_m[valid_idx])])
                anchor_y = float(ys_arr[anchor_i])
                anchor_x = float(xs_arr[anchor_i])
                nearest_m = float(forward_m[anchor_i])
                keep = valid & (forward_m <= nearest_m + near_field_window_m)
                if np.count_nonzero(keep) >= 2:
                    ys_arr, xs_arr, wts_arr = ys_arr[keep], xs_arr[keep], wts_arr[keep]
                dy = ys_arr - anchor_y
                dx = xs_arr - anchor_x
                denom = float(np.sum(wts_arr * dy * dy))
                if denom <= 1e-6:
                    return None
                a = float(np.sum(wts_arr * dy * dx) / denom)
                b = anchor_x - a * anchor_y
                residual_std = float(np.std(xs_arr - (a * ys_arr + b)))
            except Exception:
                return None
            return (a, b, float(s["len"]), residual_std)

        left_fit = fit_side(sides["left"])
        right_fit = fit_side(sides["right"])
        # The two edges of a sidewalk are always parallel (constant width), even where
        # both bend together around a turn -- so when only one is actually detected,
        # mirror ITS angle onto the missing side. There's no real data for that side at
        # all, so the anchor is where Noah actually is -- bottom-CENTER of the frame
        # (his own position projected down), not the frame corner. A corner anchor
        # forces an extreme, physically meaningless slope to reach real data a few
        # rows away (confirmed: it produced a=-23.4, landing at x=3814 by row 100).
        # This feeds the real steering values (x_angle_deg/el_x/er_x), not just the
        # display -- a confirmed single-edge sighting now implies BOTH edges.
        if left_fit is None and right_fit is not None:
            ra, rb, r_support, r_resid = right_fit
            left_fit = (ra, center_x - ra * float(h - 1), r_support, r_resid)
        elif right_fit is None and left_fit is not None:
            la, lb, l_support, l_resid = left_fit
            right_fit = (la, center_x - la * float(h - 1), l_support, l_resid)
        # --- 4. Per side, take the CLOSEST edge point. Scan from the BOTTOM of the ROI
        # upward (nearest ground first) and use the first row where the fitted line is
        # in-frame with valid depth. This emits exactly the two points we care about —
        # closest-left x/y and closest-right x/y — instead of a fixed lookahead sample.
        # (The line is still FIT over the whole ROI, so it stays stable; only the reported
        # point is the nearest one.) ppx/ppy/fx/fy/cp/sp/cr/sr were already set up above,
        # before fit_side, for the near-field-window real-distance filtering.

        # Distance weighting of confidence: a closer edge is geometrically more reliable,
        # so weight it up and far ones down. edge_distance_conf_weight = how much (0 = off).
        near_full_m = float(cfg.get("edge_distance_full_conf_m", 1.0))
        far_zero_m = max(near_full_m + 0.1, float(cfg.get("edge_distance_zero_conf_m", 3.0)))
        dist_weight = float(cfg.get("edge_distance_conf_weight", 0.3))

        # The bottom of each fitted line is a FIXED anchor (x=0 / x=w-1), not a
        # measurement -- reporting el_x/er_x there would just report that constant,
        # never the line's actual angle. Skip forward until we're far enough out that
        # the fitted angle has had room to diverge from the anchor into a real reading.
        min_report_forward_m = float(cfg.get("edge_lookahead_m", 0.6096))
        # Far bound of the multi-point trace below -- edge_lookahead_m..edge_max_lookahead_m
        # is the real window multi_point_edge scans for independent points.
        max_report_forward_m = max(min_report_forward_m + 0.1, float(cfg.get("edge_max_lookahead_m", 2.5)))
        trace_points_per_side = max(2, int(cfg.get("edge_trace_points_per_side", 10)))
        multi_point_enabled = bool(cfg.get("edge_multi_point_fit_enabled", True))

        # Two real sidewalk edges only meet at the vanishing point, which should sit
        # beyond what we're analyzing here -- if the two fitted lines cross INSIDE the
        # ROI, at least one fit has gone bad (same failure the display's crossing check
        # and the fill's width check guard against). Stop trusting either line at/past
        # that row so a bad fit can't report a point from the wrong side of the sidewalk.
        crossing_y_px = None
        if left_fit is not None and right_fit is not None:
            la, lb, _, _ = left_fit
            ra, rb, _, _ = right_fit
            if la != ra:
                y_cross = (rb - lb) / (la - ra)
                if 0 <= y_cross <= (h - 1):
                    crossing_y_px = y_cross

        def sample_row(fit, y_px):
            # Projects one caller-picked row of a fitted line into real-world (x_m,
            # forward_m) -- lets one fitted line yield several independent points (a
            # trace), not just a single pick.
            if fit is None:
                return None
            a, b, support, residual_std = fit
            x_px = a * float(y_px) + b
            if x_px < 0 or x_px > (w - 1):
                return None
            depth_m = self._sample_depth_at(roi_depth, int(round(x_px)), int(y_px))
            if not depth_m or np.isnan(depth_m) or depth_m < 0.15 or depth_m > 8.0:
                return None
            # Real per-point confidence: how consistent the depth reads right around
            # THIS pixel, not the fit's own overall support/residual_std (which is the
            # same number for every row on a side and can't tell a clean read from a
            # noisy one). A flat sidewalk surface reads within a couple cm of local
            # scatter; a stereo dropout/occlusion right at a real edge -- common,
            # since an edge is exactly where the two IR views stop agreeing -- spikes
            # local_std_m well past that. A patch that's mostly NaN (sparse coverage)
            # means there wasn't much real depth here to trust either way. Both pull
            # this point's own confidence down independently of every other point.
            patch_radius = 3
            xi, yi = int(round(x_px)), int(y_px)
            y0, y1 = max(0, yi - patch_radius), min(roi_depth.shape[0], yi + patch_radius + 1)
            x0, x1 = max(0, xi - patch_radius), min(roi_depth.shape[1], xi + patch_radius + 1)
            patch = roi_depth[y0:y1, x0:x1]
            valid_patch = patch[np.isfinite(patch) & (patch > 0)]
            if valid_patch.size < 3:
                return None
            coverage = valid_patch.size / float(patch.size)
            local_std_m = float(np.std(valid_patch))
            local_quality = max(0.0, 1.0 - local_std_m / 0.05)   # ~5cm local scatter -> floor
            confidence = float(max(0.0, min(0.99, local_quality * coverage)))
            full_y = row_start + y_px
            cam_X = (x_px - ppx) * depth_m / fx
            cam_Y = (full_y - ppy) * depth_m / fy
            rolled_X = cr * cam_X - sr * cam_Y
            rolled_Y = sr * cam_X + cr * cam_Y
            forward_m = sp * rolled_Y + cp * depth_m
            if forward_m < 0.1 or forward_m > 8.0:
                return None
            return {
                "m": round(float(-rolled_X), 4),
                "x_m": round(float(rolled_X), 4),
                "y_m": round(float(forward_m), 3),
                "conf": confidence,
                "ts": time.time(),
            }

        def line_to_obs(fit):
            if fit is None:
                return None
            a, b, support, residual_std = fit
            chosen = None
            for y_px in range(h - 1, -1, -1):          # bottom (closest) -> top
                if crossing_y_px is not None and y_px <= crossing_y_px:
                    break                              # past the crossing -- rest of the scan is worse
                x_px = a * float(y_px) + b
                if x_px < 0 or x_px > (w - 1):
                    continue                           # line off-frame at this row
                depth_m = self._sample_depth_at(roi_depth, int(round(x_px)), int(y_px))
                if not depth_m or np.isnan(depth_m) or depth_m < 0.15 or depth_m > 8.0:
                    continue
                full_y = row_start + y_px
                cam_X = (x_px - ppx) * depth_m / fx
                cam_Y = (full_y - ppy) * depth_m / fy
                rolled_X = cr * cam_X - sr * cam_Y
                rolled_Y = sr * cam_X + cr * cam_Y
                forward_m = sp * rolled_Y + cp * depth_m
                if forward_m < min_report_forward_m or forward_m > 8.0:
                    continue                           # too close -- still just the anchor
                chosen = (x_px, depth_m, forward_m, rolled_X)
                break
            if chosen is None:
                return None                            # edge never lands on valid ground far enough out -> not seen
            x_px, depth_m, forward_m, rolled_X = chosen
            # support_conf: one full-height edge line (support ≈ h) → ~0.5; saturates at 2×h
            support_conf = min(1.0, float(support) / max(1.0, float(h) * 2.0))
            # fit_quality: tight line (residual_std < 5 px) → ~1.0; scattered (> 40 px) → 0.0
            fit_quality = max(0.0, 1.0 - residual_std / 40.0)
            confidence = 0.45 + 0.5 * support_conf * fit_quality
            # Distance weight: 1.0 at/under near_full_m, fading to 0 at/over far_zero_m.
            if forward_m <= near_full_m:
                df = 1.0
            elif forward_m >= far_zero_m:
                df = 0.0
            else:
                df = (far_zero_m - forward_m) / (far_zero_m - near_full_m)
            confidence *= (1.0 - dist_weight) + dist_weight * df
            confidence = float(max(0.0, min(0.99, confidence)))
            return {
                "seen": True,
                "x_distance_m": round(float(rolled_X), 4),
                "y_distance_m": round(float(forward_m), 3),
                "confidence": round(float(confidence), 2),
                "m": round(float(-rolled_X), 4),
                "x_m": round(float(rolled_X), 4),
                "y_m": round(float(forward_m), 3),
                "ts": time.time(),
            }

        def multi_point_edge(fit):
            # 1. Gather every independent point between edge_lookahead_m and
            # edge_max_lookahead_m -- each is its own depth read (sample_row), with
            # its own real per-point confidence, not just a fixed lookahead sample.
            # edge_trace_scan_rows is the SCAN pool (how many pixel-rows across the
            # whole ROI get examined at all) -- it must be well above
            # edge_trace_points_per_side (the KEEP count below), since the window
            # filter right after this already throws most scanned rows away (only
            # rows whose real-world y_m lands inside edge_lookahead_m..
            # edge_max_lookahead_m survive) before ranking ever sees them.
            if fit is None:
                return None
            scan_rows = max(10, int(cfg.get("edge_trace_scan_rows", 60)))
            candidates = []
            for y_px in np.linspace(h - 1, 0, scan_rows):
                if crossing_y_px is not None and y_px <= crossing_y_px:
                    break
                obs = sample_row(fit, y_px)
                if obs is None:
                    continue
                if obs["y_m"] < min_report_forward_m or obs["y_m"] > max_report_forward_m:
                    continue
                candidates.append(obs)
            if len(candidates) < 3:
                return None                            # not enough independent reads to trust a trace

            # 2. Trust the cleanest reads, not an even spread of rows regardless of
            # how noisy each one was -- keep only the highest-confidence points.
            candidates.sort(key=lambda p: p["conf"], reverse=True)
            trusted = candidates[:trace_points_per_side]
            if len(trusted) < 3:
                return None
            trusted.sort(key=lambda p: p["y_m"])       # back to near->far for the checks below

            # 3. Residual-based rejection that allows a real BEND (the sidewalk
            # curving as it recedes) but not a WAVE (noise making the edge zigzag
            # row to row -- no real edge reverses direction over ~1m of forward
            # distance). Net direction is nearest-trusted-point to farthest; a step
            # that runs opposite that direction by more than the tolerance is a
            # reversal, not a bend, and gets dropped.
            reject_tol_m = float(cfg.get("edge_wave_reject_tol_m", 0.05))
            xs0 = [p["x_m"] for p in trusted]
            net_dx = xs0[-1] - xs0[0]
            trend_sign = 1.0 if net_dx > 0 else (-1.0 if net_dx < 0 else 0.0)
            inliers = [trusted[0]]
            for i in range(1, len(trusted)):
                step = trusted[i]["x_m"] - inliers[-1]["x_m"]
                if trend_sign != 0.0 and (step * trend_sign) < -reject_tol_m:
                    continue                           # reversal against the established trend -- wave, not bend
                inliers.append(trusted[i])
            if len(inliers) < 2:
                return None

            # 4. Robust center through the survivors: Theil-Sen (median of all
            # pairwise slopes, then median intercept) instead of a mean-based fit --
            # a leftover noisy point can't drag a median the way it drags a mean.
            ys = np.array([p["y_m"] for p in inliers])
            xs = np.array([p["x_m"] for p in inliers])
            n = len(inliers)
            slopes = []
            for i in range(n):
                for j in range(i + 1, n):
                    dy = ys[j] - ys[i]
                    if abs(dy) > 1e-6:
                        slopes.append((xs[j] - xs[i]) / dy)
            slope = float(np.median(slopes)) if slopes else 0.0
            intercept = float(np.median(xs - slope * ys))
            x_at_near = slope * min_report_forward_m + intercept

            mean_conf = float(np.mean([p["conf"] for p in inliers]))
            agreement = len(inliers) / float(len(trusted))
            confidence = mean_conf * (0.5 + 0.5 * agreement)
            if min_report_forward_m <= near_full_m:
                df = 1.0
            elif min_report_forward_m >= far_zero_m:
                df = 0.0
            else:
                df = (far_zero_m - min_report_forward_m) / (far_zero_m - near_full_m)
            confidence *= (1.0 - dist_weight) + dist_weight * df
            confidence = float(max(0.0, min(0.99, confidence)))
            return {
                "seen": True,
                "x_distance_m": round(float(x_at_near), 4),
                "y_distance_m": round(float(min_report_forward_m), 3),
                "confidence": round(confidence, 2),
                "m": round(float(-x_at_near), 4),
                "x_m": round(float(x_at_near), 4),
                "y_m": round(float(min_report_forward_m), 3),
                "ts": time.time(),
                "trace_points": len(inliers),
            }

        if multi_point_enabled:
            nearest_left = multi_point_edge(left_fit) or line_to_obs(left_fit)
            nearest_right = multi_point_edge(right_fit) or line_to_obs(right_fit)
        else:
            nearest_left = line_to_obs(left_fit)
            nearest_right = line_to_obs(right_fit)
        # Both edges seen at a plausible sidewalk width is the strongest, most stable
        # detection — that's the centered-on-the-sidewalk case. Corroborate their
        # confidence so driving down the middle isn't flagged low just because each
        # single edge line is short, far, or a bit scattered.
        if nearest_left is not None and nearest_right is not None:
            width_seen = abs(nearest_left["m"] - nearest_right["m"])
            if 0.4 <= width_seen <= 2.5:
                boost = float(cfg.get("edge_both_seen_conf_boost", 0.25))
                for obs in (nearest_left, nearest_right):
                    obs["confidence"] = round(min(0.98, max(obs["confidence"], 0.6) + boost), 2)

        # Turn-anticipation trace: sample each fitted line at several rows (near to far),
        # not just the closest point line_to_obs already picked. Feeds path_map (the
        # fallback carrot.js reaches for when edge_guidance_valid is false, e.g. right at
        # a corner where the closest-point pick alone loses the edge) with real data
        # instead of the permanently-empty centerline this detector used to report.
        left_bands, right_bands, band_infos = [], [], []
        for y_px in np.linspace(0, h - 1, 6).astype(int):
            l_obs = sample_row(left_fit, int(y_px))
            r_obs = sample_row(right_fit, int(y_px))
            if l_obs is None and r_obs is None:
                continue
            if l_obs is not None:
                left_bands.append(l_obs)
            if r_obs is not None:
                right_bands.append(r_obs)
            band_infos.append({
                "forward_m": (l_obs["y_m"] + r_obs["y_m"]) / 2.0 if (l_obs and r_obs)
                             else (l_obs["y_m"] if l_obs else r_obs["y_m"]),
                "left_m": l_obs["m"] if l_obs is not None else None,
                "right_m": r_obs["m"] if r_obs is not None else None,
            })

        return self._assemble_edge_result(nearest_left, nearest_right,
                                           left_bands=self._trace_bands(left_bands),
                                           right_bands=self._trace_bands(right_bands),
                                           centerline=self._centerline_from_band_infos(band_infos),
                                           edge_source="mask" if use_mask_source else "hough")

    def detect_path(self, color_image, depth_image, intrinsics):
        # edge_hough_detector: true (the live default, setup.json + setup_example.json) ->
        # independent per-side Hough line fit. false -> _detect_path_from_lines, the prior
        # detector, kept intact as the documented A/B rollback (2026-06-17). A third,
        # doubly-gated blob/mask detector (_compute_edge_clearance + _compute_edge_guidance,
        # reachable only if BOTH this flag AND edge_lines_only were false) was removed
        # 2026-07-08 -- it predated both live detectors, was unreachable under any shipped
        # config, and its same-frame band-corroboration truth model (_corroborated_pick)
        # was superseded by the heading-compensated residual check in _assemble_edge_result.
        if bool(self.config.get("edge_hough_detector", True)):
            return self._detect_edges_hough(color_image, depth_image, intrinsics)
        return self._detect_path_from_lines(color_image, depth_image, intrinsics)

    def _apply_ground_grid_filter(self, walkable_mask, roi_depth, intrinsics, row_start):
        """
        TRON-grid ground-plane filter.

        Validates the appearance-based walkable_mask against real 3D geometry.
        Every ROI pixel under the mask is deprojected into a rover-horizontal
        frame (same pitch/roll-corrected math as detect_objects), then a grid of
        cell_m x cell_m cells is laid over the X/Z ground plane. A cell whose
        depth samples mostly sit OFF the ground plane (|height| >= tolerance) is
        "not ground" -- walls, raised beds, bushes, fences, parked cars, grass
        berms -- and its mask pixels are dropped. Flat ground at the expected
        camera height, and any cell we can't measure (sparse depth), are left
        untouched so a real sidewalk survives even with imperfect depth.

        This is a precision filter: it removes the appearance false-positives
        that aren't physically flat ground -- exactly what makes Noah chase
        sidewalks that aren't there and steer when it shouldn't.

        Returns a filtered 0/255 mask the same shape as walkable_mask.
        """
        self._last_ground_removed_frac = 0.0
        if not bool(self.config.get("ground_grid_filter_enabled", True)):
            return walkable_mask

        cam_h          = float(self.config.get("camera_height_m",            0.406))
        tol            = float(self.config.get("ground_height_tol_m",        0.10))
        cell_m         = float(self.config.get("ground_grid_cell_m",         0.25))
        min_samples    = int(  self.config.get("ground_grid_min_samples",    4))
        nonground_frac = float(self.config.get("ground_grid_nonground_ratio", 0.5))

        if cell_m <= 0:
            return walkable_mask

        mask_bool = walkable_mask > 0
        mask_count = int(np.count_nonzero(mask_bool))
        if mask_count == 0:
            return walkable_mask

        valid = mask_bool & np.isfinite(roi_depth) & (roi_depth > 0.2) & (roi_depth < 15.0)
        vy, vx = np.where(valid)
        if vy.size == 0:
            return walkable_mask

        # Deproject + un-roll/un-pitch into the rover-horizontal frame.
        # roi rows are offset from the full image by row_start.
        fx, fy   = intrinsics.fx, intrinsics.fy
        ppx, ppy = intrinsics.ppx, intrinsics.ppy
        pitch = float(self.current_pitch_rad)
        roll  = float(self.current_roll_rad)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll),  math.sin(roll)

        z = roi_depth[vy, vx].astype(np.float32)
        cam_X = (vx - ppx) * z / fx
        cam_Y = ((vy + row_start) - ppy) * z / fy
        rolled_X = cr * cam_X - sr * cam_Y
        rolled_Y = sr * cam_X + cr * cam_Y
        horizontal_down    = cp * rolled_Y - sp * z
        horizontal_forward = sp * rolled_Y + cp * z
        world_Y = cam_h - horizontal_down        # 0 = ground plane, + = above ground
        world_X = rolled_X                        # + = right
        world_Z = horizontal_forward             # + = forward

        finite = np.isfinite(world_X) & np.isfinite(world_Z) & np.isfinite(world_Y)
        if not np.any(finite):
            return walkable_mask
        vy, vx = vy[finite], vx[finite]
        world_X, world_Z, world_Y = world_X[finite], world_Z[finite], world_Y[finite]

        off_ground = (np.abs(world_Y) >= tol).astype(np.float32)

        # Lay the world-space grid and flatten (X, Z) cell indices to ids.
        ix = np.floor(world_X / cell_m).astype(np.int64)
        iz = np.floor(world_Z / cell_m).astype(np.int64)
        ix -= ix.min()
        iz -= iz.min()
        ncols = int(ix.max()) + 1
        cell_id = iz * ncols + ix
        ncells = int(cell_id.max()) + 1

        total  = np.bincount(cell_id, minlength=ncells).astype(np.float32)
        offcnt = np.bincount(cell_id, weights=off_ground, minlength=ncells)
        # A cell is "not ground" only when it has enough samples AND most of them
        # are off the plane. Sparse/unmeasured cells stay (benefit of the doubt).
        cell_nonground = (total >= min_samples) & ((offcnt / np.maximum(total, 1.0)) >= nonground_frac)

        remove = cell_nonground[cell_id]
        filtered = walkable_mask.copy()
        filtered[vy[remove], vx[remove]] = 0

        # Knit the surviving ground region back together.
        filtered = cv2.morphologyEx(filtered, cv2.MORPH_OPEN,  np.ones((3, 3), np.uint8))
        filtered = cv2.morphologyEx(filtered, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

        self._last_ground_removed_frac = round(int(np.count_nonzero(remove)) / float(max(1, mask_count)), 3)
        return filtered

    def _validate_perspective_narrowing(self, walkable_mask, green_mask_roi, roi_depth):
        # A real sidewalk of ~constant real-world width projects to a pixel
        # width that scales as fx/depth, so the detected band-by-band pixel
        # width must shrink with distance. A flat wall ahead or a misclassified
        # blob (sky, building face) won't narrow with depth. If the trend fails,
        # reject the frame.
        #
        # Only bands inside perspective_check_max_distance_m are considered so
        # curves at long range don't trip the check.
        max_depth_m = float(self.config.get("perspective_check_max_distance_m", 2.0))
        min_ratio   = float(self.config.get("perspective_min_narrowing_ratio", 1.05))

        N_BANDS = 6
        h, _ = walkable_mask.shape
        band_h = max(1, h // N_BANDS)

        img_w = walkable_mask.shape[1]
        border = int(self.config.get("edge_border_margin_px", 2))
        measurements = []  # (depth_m, pixel_width)
        for i in range(N_BANDS):
            r0 = i * band_h
            r1 = min(h, r0 + band_h) if i < N_BANDS - 1 else h
            if r1 - r0 < 4:
                continue

            band_walkable = walkable_mask[r0:r1, :]
            band_depth = roi_depth[r0:r1, :]
            band_col_scores = band_walkable.mean(axis=0) / 255.0
            band_green_col = (green_mask_roi[r0:r1, :].mean(axis=0) / 255.0
                              if green_mask_roi is not None else None)

            color_left, color_right = self.find_mask_boundaries(band_col_scores, band_green_col)
            depth_left, depth_right = self.find_depth_boundaries(band_depth)
            left_px = self.merge_boundary(color_left, depth_left)
            right_px = self.merge_boundary(color_right, depth_right)
            if left_px is None or right_px is None or right_px <= left_px:
                continue
            # Skip bands where either boundary is pinned to the image border —
            # that means the edge is off-screen and the width measurement is
            # unreliable (includes invisible space beyond the frame).
            if left_px <= border or right_px >= img_w - 1 - border:
                continue

            center_px = (left_px + right_px) / 2.0
            center_depth = self.sample_depth_meters(band_depth, center_px)
            if not center_depth or np.isnan(center_depth) or center_depth <= 0.2 or center_depth > max_depth_m:
                continue
            measurements.append((float(center_depth), float(right_px - left_px)))

        # Not enough measurements within range to draw a conclusion — accept.
        if len(measurements) < 2:
            return True

        measurements.sort(key=lambda m: m[0])
        near_depth, near_width = measurements[0]
        far_depth,  far_width  = measurements[-1]

        # Bands too close in depth to distinguish noise from real perspective.
        if far_depth - near_depth < 0.3:
            return True

        return near_width >= far_width * min_ratio

    def _trace_bands(self, band_obs_list, max_bands=6):
        # Near-to-far trace of every band's observation on one side (el1..el6 /
        # er1..er6 in the steer log), not just the single "closest" one -- lets a
        # turn approach be read directly: a real bend shows up as x_m drifting
        # across the trace instead of jumping between two unrelated bands.
        ordered = sorted(band_obs_list, key=lambda o: o["y_m"])[:max_bands]
        return [{"x_m": o["x_m"], "y_m": o["y_m"], "conf": o["conf"]} for o in ordered]

    def _centerline_from_band_infos(self, band_infos):
        # Feeds path_map (the turn-anticipation fallback carrot.js reaches for when
        # edge_guidance_valid is false). Reuses the SAME per-band left_m/right_m this
        # function's caller already computed -- rather than the separate, weaker
        # _compute_centerline detector -- so the map gets fed on every frame the live
        # edge signal itself trusts, not just frames where a second, stricter detector
        # also happens to agree.
        points = []
        for b in band_infos:
            left_m, right_m = b["left_m"], b["right_m"]
            if left_m is not None and right_m is not None:
                lateral_offset_m = (left_m + right_m) / 2.0
                width_m = abs(left_m - right_m)
                if 0.4 <= width_m <= 2.0:
                    self.last_path_width_meters = width_m
            elif left_m is not None:
                lateral_offset_m = left_m - (self.last_path_width_meters / 2.0)
            else:
                lateral_offset_m = right_m + (self.last_path_width_meters / 2.0)
            points.append({
                "forward_m": round(float(b["forward_m"]), 3),
                "lateral_offset_m": round(float(lateral_offset_m), 4),
            })
        points.sort(key=lambda p: p["forward_m"])
        return points

    def find_mask_boundaries(self, column_scores, green_col_scores=None):
        # Prefer green-border approach: scan inward from center to find the inner
        # edge of the turf on each side. This is robust against asphalt contamination
        # because the gray parking lot beyond the turf is never mistaken for the path.
        if green_col_scores is not None and len(green_col_scores) > 0:
            green_threshold = 0.15
            width = len(green_col_scores)
            center = width // 2

            # Scan left from center — first green column found is the left path boundary
            left_boundary = None
            for col in range(center - 1, -1, -1):
                if green_col_scores[col] > green_threshold:
                    left_boundary = col + 1
                    break

            # Scan right from center — first green column found is the right path boundary
            right_boundary = None
            for col in range(center, width):
                if green_col_scores[col] > green_threshold:
                    right_boundary = col - 1
                    break

            if left_boundary is not None and right_boundary is not None and right_boundary > left_boundary:
                return left_boundary, right_boundary

        # Fallback: outermost concrete pixels (works when no turf border is present)
        threshold = 0.28
        indices = np.where(column_scores > threshold)[0]
        if indices.size == 0:
            return None, None
        return int(indices[0]), int(indices[-1])

    def find_nearest_mask_edges(self, column_scores, threshold=0.18, min_run_px=6):
        # Robust nearest-edge extraction from the walkable mask profile.
        # Instead of depending on a single transition pattern, find contiguous
        # walkable segments and choose the one nearest the image center.
        if column_scores is None or len(column_scores) < 4:
            return None, None

        scores = np.asarray(column_scores, dtype=np.float32)
        if scores.size < 4:
            return None, None

        # Build segments at the configured threshold; if none survive, retry at a
        # softer threshold to avoid edge dropouts from minor confidence dips.
        thresholds = [float(threshold), max(0.08, float(threshold) * 0.6)]
        center = int(scores.size // 2)
        selected = None

        for thr in thresholds:
            walkable = scores >= thr
            if not np.any(walkable):
                continue

            padded = np.concatenate(([False], walkable, [False])).astype(np.int8)
            changes = np.diff(padded)
            starts = np.where(changes == 1)[0]
            ends = np.where(changes == -1)[0] - 1
            if starts.size == 0 or ends.size == 0:
                continue

            runs = []
            for s, e in zip(starts, ends):
                run_len = int(e - s + 1)
                if run_len >= int(min_run_px):
                    # Distance from center to segment (0 if center lies inside)
                    if center < s:
                        dist = s - center
                    elif center > e:
                        dist = center - e
                    else:
                        dist = 0
                    runs.append((dist, -run_len, int(s), int(e)))

            # If no run meets min length, use the largest run at this threshold.
            if not runs:
                run_lengths = ends - starts + 1
                idx = int(np.argmax(run_lengths))
                selected = (int(starts[idx]), int(ends[idx]))
                break

            runs.sort()
            selected = (runs[0][2], runs[0][3])
            break

        if selected is None:
            return None, None
        left_edge, right_edge = selected
        if right_edge <= left_edge:
            return None, None
        return int(left_edge), int(right_edge)

    def find_independent_edges(self, column_scores, threshold=0.18, min_run_px=6, border_px=2):
        # Genuinely independent per-side edge extraction.
        #
        # Previous approach: find the central walkable run, then check its endpoints
        # against the image border. If the run detection fails (band too sparse, or
        # the run is entirely in one corner), BOTH sides return None together — the
        # original coupling bug.
        #
        # This version anchors to the nearest walkable column from the image center,
        # then scans outward in each direction independently. Neither side's result
        # depends on the other: losing the left edge (off-screen or mask dropout)
        # can never null the right edge, and vice-versa.
        #
        # A side returns None when:
        #   - No walkable column is found at all in this band.
        #   - The walkable region extends all the way to the image border on that
        #     side (the edge is out of camera view).
        if column_scores is None:
            return None, None
        scores = np.asarray(column_scores, dtype=np.float32)
        n = int(scores.size)
        if n < 4:
            return None, None

        center = int(n // 2)
        for thr in (float(threshold), max(0.06, float(threshold) * 0.6)):
            walkable = scores >= thr
            walkable_cols = np.where(walkable)[0]
            if walkable_cols.size < int(min_run_px):
                continue

            # Anchor: nearest walkable column to the image center.
            # Picks the walkable region the rover is most likely on (bore-sight).
            nearest = int(walkable_cols[int(np.argmin(np.abs(walkable_cols - center)))])

            # LEFT edge: scan leftward from anchor until a non-walkable column.
            # If we reach col 0 still walkable → edge is off-screen → None.
            left_px = None
            for c in range(nearest, -1, -1):
                if not walkable[c]:
                    candidate = c + 1
                    left_px = candidate if candidate > int(border_px) else None
                    break
            # (for-loop exhausted without break = col 0 is walkable = edge off-screen)

            # RIGHT edge: scan rightward from anchor until a non-walkable column.
            # If we reach col n-1 still walkable → edge is off-screen → None.
            right_px = None
            for c in range(nearest, n):
                if not walkable[c]:
                    candidate = c - 1
                    right_px = candidate if candidate < (n - 1 - int(border_px)) else None
                    break
            # (for-loop exhausted without break = last col is walkable = edge off-screen)

            if left_px is not None or right_px is not None:
                return left_px, right_px

        return None, None

    def find_depth_boundaries(self, roi_depth):
        depth_band = roi_depth[int(roi_depth.shape[0] * 0.35):int(roi_depth.shape[0] * 0.75), :]
        if depth_band.size == 0:
            return None, None

        if np.all(np.isnan(depth_band)):
            return None, None
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            depth_profile = np.nanmedian(depth_band, axis=0)
        if np.all(np.isnan(depth_profile)):
            return None, None

        valid_depth = np.copy(depth_profile)
        nan_mask = np.isnan(valid_depth)
        if np.any(~nan_mask):
            valid_depth[nan_mask] = np.nanmedian(valid_depth[~nan_mask])
        valid_depth = cv2.GaussianBlur(valid_depth.reshape(1, -1), (9, 1), 0).reshape(-1)
        gradient = np.abs(np.diff(valid_depth))
        edge_threshold = 0.08
        edge_indices = np.where(gradient > edge_threshold)[0]
        if edge_indices.size == 0:
            return None, None

        left_edge = None
        right_edge = None
        for index in edge_indices:
            if index < int(len(valid_depth) * 0.45):
                left_edge = int(index)
                break
        for index in edge_indices[::-1]:
            if index > int(len(valid_depth) * 0.55):
                right_edge = int(index)
                break

        return left_edge, right_edge

    def merge_boundary(self, color_boundary, depth_boundary):
        boundaries = [value for value in [color_boundary, depth_boundary] if value is not None]
        if not boundaries:
            return None
        return float(sum(boundaries) / len(boundaries))

    def sample_depth_meters(self, roi_depth, center_px):
        center_px = int(np.clip(center_px, 0, roi_depth.shape[1] - 1))
        left = max(0, center_px - 6)
        right = min(roi_depth.shape[1], center_px + 7)
        # Sample only the bottom 40% of the ROI (nearest ground, where boundaries are measured)
        near_start = int(roi_depth.shape[0] * 0.6)
        depth_slice = roi_depth[near_start:, left:right]
        if depth_slice.size == 0 or np.all(np.isnan(depth_slice)):
            depth_slice = roi_depth[:, left:right]
        if depth_slice.size == 0 or np.all(np.isnan(depth_slice)):
            return float("nan")
        return float(np.nanmedian(depth_slice))

    def pixel_span_to_meters(self, pixel_span, depth_meters, fx):
        if not depth_meters or np.isnan(depth_meters) or fx <= 0:
            return self.last_path_width_meters
        return (float(pixel_span) * float(depth_meters)) / float(fx)

    def meters_to_pixel_span(self, meters, depth_meters, fx):
        if not depth_meters or np.isnan(depth_meters) or fx <= 0:
            return 0
        return (float(meters) * float(fx)) / float(depth_meters)

    # ------------------------------------------------------------------
    # Object detection
    # ------------------------------------------------------------------

    @staticmethod
    def _clock_str(clock_decimal):
        hour = int(round(clock_decimal))
        hour = max(1, min(12, hour))
        return "{} o'clock".format(hour)

    def detect_objects(self, depth_image, intrinsics):
        """
        Back-project the depth frame to world coordinates and cluster
        pixels that are above the ground but below a person's height.
        Reports each cluster as an object with clock-face bearing,
        distance, height-from-ground, and rover-path threat level.
        """
        camera_height_m  = float(self.config.get("camera_height_m",  0.406))   # 16 in
        rover_width_m    = float(self.config.get("rover_width_m",    0.432))   # 17 in
        rover_length_m   = float(self.config.get("rover_length_m",   0.686))   # 27 in
        max_dist_m       = float(self.config.get("object_max_distance_m", 4.0))
        min_height_m     = float(self.config.get("object_min_height_m",  0.127))  # 5 inches
        min_area_px      = int(  self.config.get("object_min_area_px",   200))

        # Downsample 4× to keep CPU load low; scale intrinsics accordingly
        ds = 4
        h, w = depth_image.shape[:2]
        small = cv2.resize(depth_image, (w // ds, h // ds),
                           interpolation=cv2.INTER_NEAREST)
        sh, sw = small.shape[:2]
        fx = intrinsics.fx / ds
        fy = intrinsics.fy / ds
        cx = intrinsics.ppx / ds
        cy = intrinsics.ppy / ds

        depth_m = small.astype(np.float32) * 0.001

        # Back-project every pixel ----------------------------------------
        rows, cols = np.mgrid[0:sh, 0:sw]
        valid = (depth_m > 0.2) & (depth_m < max_dist_m)

        # Pitch- and roll-corrected back-projection. Rotate raw camera coords to a
        # rover-horizontal frame by un-rolling around Z first, then un-pitching around X.
        # (For the small angles we see on a rover, the order matters little.)
        #   pitch positive = nose up      → un-pitch by rotating (Y, Z) by -pitch around X
        #   roll  positive = right side down → un-roll  by rotating (X, Y) by -roll  around Z
        pitch = float(self.current_pitch_rad)
        roll  = float(self.current_roll_rad)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll),  math.sin(roll)

        cam_X_raw = np.where(valid, (cols - cx) * depth_m / fx, np.nan)  # +right in camera
        cam_Y_raw = np.where(valid, (rows - cy) * depth_m / fy, np.nan)  # +down  in camera
        cam_Z_raw = np.where(valid, depth_m,                    np.nan)  # along optical axis

        # Un-roll (rotate around Z)
        rolled_X = cr * cam_X_raw - sr * cam_Y_raw
        rolled_Y = sr * cam_X_raw + cr * cam_Y_raw

        # Un-pitch (rotate around X)
        horizontal_down    = cp * rolled_Y - sp * cam_Z_raw
        horizontal_forward = sp * rolled_Y + cp * cam_Z_raw

        world_Y = np.where(valid, camera_height_m - horizontal_down, np.nan)
        world_Z = np.where(valid, horizontal_forward,                np.nan)
        world_X = np.where(valid, rolled_X,                          np.nan)

        # Obstacle mask: above the ground, below max object height ----------
        obstacle_mask = (
            valid &
            (world_Y > min_height_m) &
            (world_Y < 2.5)
        ).astype(np.uint8)

        kernel = np.ones((3, 3), np.uint8)
        obstacle_mask = cv2.morphologyEx(obstacle_mask, cv2.MORPH_CLOSE, kernel)
        obstacle_mask = cv2.morphologyEx(obstacle_mask, cv2.MORPH_OPEN,  kernel)

        # Connected components ---------------------------------------------
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(obstacle_mask)

        # Minimum area scales down by ds²; guard a sensible floor
        min_area_ds = max(8, min_area_px // (ds * ds))

        objects = []
        for label in range(1, num_labels):
            if stats[label, cv2.CC_STAT_AREA] < min_area_ds:
                continue

            mask = labels == label
            cZ = world_Z[mask]
            cX = world_X[mask]
            cY = world_Y[mask]

            ok = ~np.isnan(cZ) & ~np.isnan(cX) & ~np.isnan(cY)
            if not np.any(ok):
                continue
            cZ, cX, cY = cZ[ok], cX[ok], cY[ok]

            # Use the 20th-percentile depth so we report the near edge
            z_near      = float(np.percentile(cZ, 20))
            x_center    = float(np.mean(cX))
            y_bottom    = float(np.percentile(cY, 10))
            y_top       = float(np.percentile(cY, 90))
            x_span      = float(np.percentile(cX, 90) - np.percentile(cX, 10))

            # Clock bearing (12 = straight ahead, 3 = right, 9 = left)
            bearing_deg   = math.degrees(math.atan2(x_center, z_near))
            clock_decimal = ((12.0 + bearing_deg / 30.0 - 1.0) % 12.0) + 1.0

            # Rover path threat
            half_rover_w = rover_width_m / 2.0
            in_path = abs(x_center) < half_rover_w
            if in_path and z_near < rover_length_m * 1.5:
                threat = "high"
            elif in_path or z_near < rover_length_m:
                threat = "medium"
            else:
                threat = "low"

            # Confidence proxy: larger area → more confident
            raw_area   = int(stats[label, cv2.CC_STAT_AREA])
            confidence = round(min(1.0, raw_area / (500.0 / (ds * ds))), 2)

            # Reject depth-noise clusters: no measurable height or width, or very low confidence
            if confidence < 0.3 or (round(max(0.0, y_top - y_bottom), 2) == 0.0 and round(max(0.0, x_span), 2) == 0.0):
                continue

            objects.append({
                "clock_direction":      round(clock_decimal, 1),
                "clock_direction_str":  self._clock_str(clock_decimal),
                "bearing_deg":          round(bearing_deg, 1),
                "distance_m":           round(z_near, 2),
                "distance_inches":      round(z_near * 39.3701, 1),
                "lateral_offset_m":     round(x_center, 3),
                "height_from_ground_m": round(max(0.0, y_bottom), 2),
                "max_height_m":         round(y_top, 2),
                "object_height_m":      round(max(0.0, y_top - y_bottom), 2),
                "width_m":              round(max(0.0, x_span), 2),
                "in_rover_path":        bool(in_path),
                "threat_level":         threat,
                "pixel_area":           raw_area * ds * ds,
                "confidence":           confidence
            })

        # Sort: closest first
        objects.sort(key=lambda o: o["distance_m"])
        return objects


def stdin_listener(vision):
    for raw_line in sys.stdin:
        if not raw_line:
            continue
        try:
            payload = json.loads(raw_line.strip())
        except Exception:
            continue
        msg = payload.get("message")
        if msg == "shutdown":
            vision.stop()
            break
        elif msg == "pitch":
            try:
                val = float(payload.get("value", 0.0))
                if math.isfinite(val):           # reject NaN/inf so it can't poison the
                    # rover body pitch (nose-up +) plus the static camera mount tilt
                    # (forward/nose-down, so subtracted) = camera pitch vs the ground.
                    vision.current_pitch_rad = val - vision.mount_pitch_rad
            except (TypeError, ValueError):
                pass
        elif msg == "roll":
            try:
                val = float(payload.get("value", 0.0))
                if math.isfinite(val):
                    vision.current_roll_rad = val
            except (TypeError, ValueError):
                pass
        elif msg == "heading":
            try:
                val = float(payload.get("value", 0.0))
                if math.isfinite(val):
                    vision.current_heading_deg = val % 360.0
            except (TypeError, ValueError):
                pass
        elif msg == "capture_session":
            # Sent on every arm (active=True, dir=<session folder>) and disarm
            # (active=False) -- see pixhawk_message_handler.js. Forcing
            # _last_capture_ts back to 0 makes the very next tick save a frame
            # immediately, so the session folder isn't empty for a full
            # display_capture_interval_s after arming.
            active = bool(payload.get("active", True))
            dir_val = payload.get("dir")
            vision._session_capture_active = active
            vision._session_capture_dir = str(dir_val) if (active and dir_val) else None
            if active:
                vision._last_capture_ts = 0.0

    # The for-loop ends only when stdin hits EOF — the parent (Node) closed the pipe,
    # i.e. it exited or crashed. Stop so run() unwinds and releases the camera instead
    # of orphaning this process and holding the RealSense open.
    vision.stop()


def main():
    config = parse_config()
    vision = RealsenseVision(config)
    listener = threading.Thread(target=stdin_listener, args=(vision,), daemon=True)
    listener.start()
    vision.run()


if __name__ == "__main__":
    main()