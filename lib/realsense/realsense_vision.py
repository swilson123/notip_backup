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
        self.current_pitch_rad = 0.0
        self.current_roll_rad  = 0.0
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
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)

    def stop(self, *_args):
        self.running = False

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
            "edge_used": result.get("edge_used", "none"),
            "edge_target_offset_m": result.get("edge_target_offset_m"),
            "edge_forward_m": result.get("edge_forward_m"),
            "edge_guidance_valid": result.get("edge_guidance_valid", False),
            "cpu_percent": round(cpu_percent, 1),
            "fps_current": round(self.measured_fps, 1),
            "fps_target": self.current_fps_target,
            "status": result["status"],
            "source": "realsense_vision",
            "timestamp": int(time.time() * 1000),
            "objects": objects
        }

    def _build_simple_ground_mask(self, roi_color):
        hsv = cv2.cvtColor(roi_color, cv2.COLOR_BGR2HSV)
        sat_limit = int(self.config.get("simple_edge_saturation_limit", 100))
        val_min = int(self.config.get("simple_edge_value_min", 55))
        light_min = int(self.config.get("simple_edge_light_min", 55))
        min_area = int(self.config.get("simple_edge_component_min_area", 250))

        mean_val = int(np.mean(hsv[:, :, 2]))
        val_floor = max(light_min, max(val_min, int(mean_val * 0.45)))

        concrete_mask = cv2.inRange(hsv, (0, 0, val_floor), (179, sat_limit, 255))
        green_mask_roi = cv2.inRange(hsv, (35, 40, 25), (95, 255, 255))
        mulch_mask = cv2.inRange(hsv, (8, 40, 20), (32, 255, 160))

        non_walkable = cv2.bitwise_or(green_mask_roi, mulch_mask)
        walkable = cv2.bitwise_and(concrete_mask, cv2.bitwise_not(non_walkable))
        walkable = cv2.medianBlur(walkable, 5)
        walkable = cv2.morphologyEx(walkable, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        walkable = cv2.morphologyEx(walkable, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))

        if min_area > 0 and cv2.countNonZero(walkable) > 0:
            n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(walkable, connectivity=8)
            clean = np.zeros_like(walkable)
            for lbl in range(1, n_labels):
                if stats[lbl, cv2.CC_STAT_AREA] >= min_area:
                    clean[labels == lbl] = 255
            walkable = clean

        return walkable, green_mask_roi

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

        walkable_mask, green_mask_roi = self._build_simple_ground_mask(roi_color)
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
            # the live detector (detect_path -> edge_lines_only defaults True).
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

        # Update per-side cached values with the newest seen edges.
        now_ts = time.time()
        ttl_ms = float(self.config.get("edge_known_ttl_ms", 5000))
        if nearest_left is not None:
            self.last_edge_obs["left"] = nearest_left
        if nearest_right is not None:
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

        side_offset_m = float(self.config.get("edge_side_offset_m", 0.4572))
        use = "none"
        if nearest_left is not None and nearest_right is not None:
            use = "left" if nearest_left["confidence"] >= nearest_right["confidence"] else "right"
        elif nearest_left is not None:
            use = "left"
        elif nearest_right is not None:
            use = "right"

        valid = use in ("left", "right")
        target_offset = 0.0
        chosen_conf = 0.0
        edge_forward_m = None
        if valid:
            chosen = nearest_left if use == "left" else nearest_right
            if use == "left":
                target_offset = chosen["m"] - side_offset_m
            else:
                target_offset = chosen["m"] + side_offset_m
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
            "ground_grid_removed_frac": self._last_ground_removed_frac,
            "nearest_seen_left_edge": left_k if left_ok else {"seen": False, "x_distance_m": None, "y_distance_m": None, "confidence": 0.0},
            "nearest_seen_right_edge": right_k if right_ok else {"seen": False, "x_distance_m": None, "y_distance_m": None, "confidence": 0.0},
            "status": "tracking" if valid else "low_confidence",
        }

    def _assemble_edge_result(self, nearest_left, nearest_right):
        # Shared output contract for the edge detectors: per-side TTL cache, known()
        # state, edge selection, target offset, steering angle. Identical dict shape to
        # _detect_path_from_lines so the LCD / message handler / steering are unchanged.
        now_ts = time.time()
        ttl_ms = float(self.config.get("edge_known_ttl_ms", 5000))
        if nearest_left is not None:
            self.last_edge_obs["left"] = nearest_left
        if nearest_right is not None:
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

        side_offset_m = float(self.config.get("edge_side_offset_m", 0.4572))
        use = "none"
        if nearest_left is not None and nearest_right is not None:
            use = "left" if nearest_left["confidence"] >= nearest_right["confidence"] else "right"
        elif nearest_left is not None:
            use = "left"
        elif nearest_right is not None:
            use = "right"

        valid = use in ("left", "right")
        target_offset = 0.0
        chosen_conf = 0.0
        edge_forward_m = None
        if valid:
            chosen = nearest_left if use == "left" else nearest_right
            if use == "left":
                target_offset = chosen["m"] - side_offset_m
            else:
                target_offset = chosen["m"] + side_offset_m
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
        lookahead_frac = float(cfg.get("edge_line_lookahead_frac", 0.82))
        depth_jump_m = float(cfg.get("dropoff_min_depth_jump_m", 0.15))

        # --- 1. Candidate edge pixels: color (Canny) | color-class boundary | depth drop-off
        try:
            gray = cv2.cvtColor(roi_color, cv2.COLOR_BGR2GRAY)
            gray = cv2.GaussianBlur(gray, (blur_k, blur_k), 0)
            edge_img = cv2.Canny(gray, canny_low, canny_high)
        except Exception:
            return self._assemble_edge_result(None, None)

        try:
            walkable_mask, _gm = self._build_simple_ground_mask(roi_color)
            mask_grad = cv2.morphologyEx(walkable_mask, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
            edge_img = cv2.bitwise_or(edge_img, mask_grad)
        except Exception:
            pass

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
            return self._assemble_edge_result(None, None)

        # --- 3. Fit ONE line per side, independently (x = a*y + b, weighted by length)
        sides = {"left": {"ys": [], "xs": [], "wts": [], "len": 0.0},
                 "right": {"ys": [], "xs": [], "wts": [], "len": 0.0}}
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

        def fit_side(s):
            if len(s["ys"]) < 2 or s["len"] <= 0:
                return None
            try:
                ys_arr = np.asarray(s["ys"])
                xs_arr = np.asarray(s["xs"])
                a, b = np.polyfit(ys_arr, xs_arr, 1, w=np.asarray(s["wts"]))
                residual_std = float(np.std(xs_arr - (a * ys_arr + b)))
            except Exception:
                return None
            return (float(a), float(b), float(s["len"]), residual_std)

        left_fit = fit_side(sides["left"])
        right_fit = fit_side(sides["right"])

        # --- 4. Evaluate each line at the lookahead row -> a per-side 3D observation
        y_look = int(np.clip(h * lookahead_frac, 0, h - 1))
        ppx, ppy = intrinsics.ppx, intrinsics.ppy
        fx, fy = intrinsics.fx, intrinsics.fy
        pitch = float(self.current_pitch_rad)
        roll = float(self.current_roll_rad)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll), math.sin(roll)

        def line_to_obs(fit):
            if fit is None:
                return None
            a, b, support, residual_std = fit
            x_px = a * float(y_look) + b
            if x_px < 0 or x_px > (w - 1):
                return None                        # edge line runs off the frame -> not seen
            depth_m = self._sample_depth_at(roi_depth, int(round(x_px)), int(y_look))
            if not depth_m or np.isnan(depth_m) or depth_m < 0.15 or depth_m > 8.0:
                return None
            full_y = row_start + y_look
            cam_X = (x_px - ppx) * depth_m / fx
            cam_Y = (full_y - ppy) * depth_m / fy
            rolled_X = cr * cam_X - sr * cam_Y
            rolled_Y = sr * cam_X + cr * cam_Y
            forward_m = sp * rolled_Y + cp * depth_m
            if forward_m < 0.1 or forward_m > 8.0:
                return None
            # support_conf: one full-height edge line (support ≈ h) → ~0.5; saturates at 2×h
            support_conf = min(1.0, float(support) / max(1.0, float(h) * 2.0))
            # fit_quality: tight line (residual_std < 5 px) → ~1.0; scattered (> 40 px) → 0.0
            fit_quality = max(0.0, 1.0 - residual_std / 40.0)
            confidence = 0.45 + 0.5 * support_conf * fit_quality
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

        nearest_left = line_to_obs(left_fit)
        nearest_right = line_to_obs(right_fit)
        return self._assemble_edge_result(nearest_left, nearest_right)

    def detect_path(self, color_image, depth_image, intrinsics):
        if bool(self.config.get("edge_hough_detector", True)):
            return self._detect_edges_hough(color_image, depth_image, intrinsics)
        if bool(self.config.get("edge_lines_only", True)):
            return self._detect_path_from_lines(color_image, depth_image, intrinsics)

        height, width = depth_image.shape[:2]
        row_start = int(height * 0.35)
        row_end = int(height * 0.90)
        roi_color = color_image[row_start:row_end, :]
        roi_depth = depth_image[row_start:row_end, :].astype(np.float32) * 0.001
        roi_depth[roi_depth <= 0] = np.nan

        combined_mask = None

        # Indoor-friendly concrete strip fallback (e.g. light concrete over dark carpet).
        hsv = cv2.cvtColor(roi_color, cv2.COLOR_BGR2HSV)
        sat_limit = int(self.config.get("concrete_mask_saturation_limit", 95))
        min_value = max(30, int(np.mean(hsv[:, :, 2]) * 0.45))
        concrete_mask = cv2.inRange(hsv, (0, 0, min_value), (179, sat_limit, 255))
        green_mask_roi = cv2.inRange(hsv, (35, 40, 25), (95, 255, 255))
        # Mulch/bark/brown soil: hue 8-32, meaningful saturation, not too bright
        mulch_mask = cv2.inRange(hsv, (8, 40, 20), (32, 255, 160))
        non_walkable = cv2.bitwise_or(green_mask_roi, mulch_mask)
        fallback_mask = cv2.bitwise_and(concrete_mask, cv2.bitwise_not(non_walkable))
        fallback_mask = cv2.medianBlur(fallback_mask, 5)
        fallback_mask = cv2.morphologyEx(fallback_mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        fallback_mask = cv2.morphologyEx(fallback_mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))

        def anchor_frac(mask):
            mh, mw = mask.shape[:2]
            r0 = int(mh * 0.72)
            c0 = int(mw * 0.38)
            c1 = int(mw * 0.62)
            patch = mask[r0:, c0:c1]
            if patch.size == 0:
                return 0.0
            return float(cv2.countNonZero(patch)) / float(patch.size)

        if combined_mask is not None:
            roi_seg = combined_mask[row_start:row_end, :]
            walkable_mask = cv2.medianBlur(roi_seg, 5)
            walkable_mask = cv2.morphologyEx(walkable_mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
            combined_anchor = anchor_frac(walkable_mask)
            fallback_anchor = anchor_frac(fallback_mask)
            anchor_min = float(self.config.get("fallback_anchor_min_frac", 0.06))
            anchor_margin = float(self.config.get("fallback_anchor_margin_frac", 0.03))
            if combined_anchor < anchor_min and fallback_anchor > (combined_anchor + anchor_margin):
                walkable_mask = fallback_mask
            green_col_scores = green_mask_roi.mean(axis=0) / 255.0
        else:
            walkable_mask = fallback_mask
            green_col_scores = green_mask_roi.mean(axis=0) / 255.0

        # TRON-grid ground-plane filter: drop appearance pixels that aren't
        # physically flat ground at the expected camera height (walls, raised
        # beds, bushes, parked cars, grass berms). This is what stops Noah from
        # locking onto surfaces that merely look like sidewalk.
        walkable_mask = self._apply_ground_grid_filter(walkable_mask, roi_depth, intrinsics, row_start)

        if not self._validate_perspective_narrowing(walkable_mask, green_mask_roi, roi_depth):
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
                "status": "perspective_invalid"
            }

        centerline = self._compute_centerline(walkable_mask, green_mask_roi, roi_depth, intrinsics, row_start)
        edge_info = self._compute_edge_clearance(walkable_mask, green_mask_roi, roi_depth, intrinsics, row_start)
        # Edge guidance is the guiding key: a single near-field band ~2 ft ahead drives
        # steering. The centerline/offset math below is still computed for the path map
        # and edge-clearance safety, but the emitted steering signal comes from edges.
        edge_guidance = self._compute_edge_guidance(walkable_mask, green_mask_roi, roi_depth, intrinsics, row_start)

        column_scores = walkable_mask.mean(axis=0) / 255.0
        color_left, color_right = self.find_mask_boundaries(column_scores, green_col_scores)
        depth_left, depth_right = self.find_depth_boundaries(roi_depth)

        left_px = self.merge_boundary(color_left, depth_left)
        right_px = self.merge_boundary(color_right, depth_right)

        left_visible = left_px is not None
        right_visible = right_px is not None

        if left_visible and right_visible and right_px > left_px:
            center_px = (left_px + right_px) / 2.0
            center_depth = self.sample_depth_meters(roi_depth, center_px)
            path_width_meters = self.pixel_span_to_meters(right_px - left_px, center_depth, intrinsics.fx)
            if 0.5 <= path_width_meters <= 3.5:
                self.last_path_width_meters = path_width_meters
            else:
                path_width_meters = self.last_path_width_meters
        elif left_visible:
            center_depth = self.sample_depth_meters(roi_depth, left_px)
            half_width_px = self.meters_to_pixel_span(self.last_path_width_meters / 2.0, center_depth, intrinsics.fx)
            center_px = left_px + half_width_px
            path_width_meters = self.last_path_width_meters
        elif right_visible:
            center_depth = self.sample_depth_meters(roi_depth, right_px)
            half_width_px = self.meters_to_pixel_span(self.last_path_width_meters / 2.0, center_depth, intrinsics.fx)
            center_px = right_px - half_width_px
            path_width_meters = self.last_path_width_meters
        else:
            # The coarse whole-ROI centerline lost both boundaries, but edge_guidance
            # tracks each side independently (per-side TTL). Emit its fields so a single
            # edge that's still tracked keeps its own known/conf/x/y — otherwise omitting
            # them makes the handler read BOTH edge_*_known as false in lockstep, so the
            # LCD flips EL and ER to N together when only one edge is actually gone. A
            # valid edge-guidance steering signal is also preserved here, not discarded.
            return {
                "x_angle_deg": round(float(edge_guidance["x_angle_deg"]), 2) if edge_guidance["valid"] else 0.0,
                "offset_meters": round(float(edge_guidance["offset_m"]), 4) if edge_guidance["valid"] else 0,
                "path_width_meters": self.last_path_width_meters,
                "confidence": float(edge_guidance["confidence"]) if edge_guidance["valid"] else 0,
                "left_boundary_visible": edge_guidance["left_m"] is not None,
                "right_boundary_visible": edge_guidance["right_m"] is not None,
                "centerline": [],
                "nearest_edge_m": edge_info["nearest_edge_m"],
                "nearest_edge_side": edge_info["nearest_edge_side"],
                "nearest_edge_clearance_m": edge_info["nearest_edge_clearance_m"],
                "nearest_edge_type": edge_info["nearest_edge_type"],
                "left_edge_clearance_m": edge_info.get("left_edge_clearance_m"),
                "right_edge_clearance_m": edge_info.get("right_edge_clearance_m"),
                "edge_left_m": edge_guidance["left_m"],
                "edge_left_conf": edge_guidance["left_conf"],
                "edge_left_x_m": edge_guidance["left_x_m"],
                "edge_left_y_m": edge_guidance["left_y_m"],
                "edge_left_known": edge_guidance["left_known"],
                "edge_left_known_age_ms": edge_guidance["left_known_age_ms"],
                "edge_right_m": edge_guidance["right_m"],
                "edge_right_conf": edge_guidance["right_conf"],
                "edge_right_x_m": edge_guidance["right_x_m"],
                "edge_right_y_m": edge_guidance["right_y_m"],
                "edge_right_known": edge_guidance["right_known"],
                "edge_right_known_age_ms": edge_guidance["right_known_age_ms"],
                "edge_used": edge_guidance["used"],
                "edge_target_offset_m": edge_guidance["offset_m"] if edge_guidance["valid"] else None,
                "edge_forward_m": edge_guidance["forward_m"],
                "edge_guidance_valid": edge_guidance["valid"],
                "status": "path_lost"
            }

        center_px = float(np.clip(center_px, 0, width - 1))
        center_depth = max(0.2, min(center_depth, 5.0))
        path_center_x_m = ((center_px - intrinsics.ppx) / intrinsics.fx) * center_depth
        offset_meters = -path_center_x_m

        # X-axis angle to the sidewalk center — the one signal the rover steers on.
        #   x_angle_deg > 0  -> sidewalk center is to the RIGHT -> steer right
        #   x_angle_deg < 0  -> sidewalk center is to the LEFT  -> steer left
        x_angle_deg = math.degrees(math.atan2(path_center_x_m, center_depth)) if center_depth and center_depth > 0 else 0.0

        confidence = 0.0
        if left_visible and right_visible:
            confidence = 0.85
            if color_left is not None and depth_left is not None and color_right is not None and depth_right is not None:
                confidence = 0.92
        else:
            # One boundary visible — confidence reduced but above threshold so corrections still fire
            confidence = 0.65

        if np.isnan(center_depth):
            confidence = min(confidence, 0.35)
            offset_meters = 0

        confidence = float(max(0.0, min(1.0, confidence)))

        # Track where the path centered in this frame so the next frame's
        # appearance-based flood-fill can seed adaptively (otherwise we'd
        # always seed at bottom-center and lose the path the moment the
        # rover drifts laterally). Skip on weak detections so we don't lock
        # the seed onto noise.
        if confidence >= 0.5:
            self.last_seed_x = float(center_px)
            self.last_seed_x_ts = time.time()

        # Emit edge-guidance as the steering signal. When edges are visible we steer off
        # them; when they're not, we suppress the vision nudge (low confidence) and the
        # Node.js side latches/fades the last good correction.
        if edge_guidance["valid"]:
            out_x_angle = edge_guidance["x_angle_deg"]
            out_offset  = edge_guidance["offset_m"]
            out_conf    = edge_guidance["confidence"]
            out_left_vis  = edge_guidance["left_m"] is not None
            out_right_vis = edge_guidance["right_m"] is not None
        else:
            out_x_angle = 0.0
            out_offset  = round(float(offset_meters), 4)
            out_conf    = min(confidence, 0.3)
            out_left_vis  = left_visible
            out_right_vis = right_visible

        return {
            "x_angle_deg": round(float(out_x_angle), 2),
            "offset_meters": round(float(out_offset), 4),
            "path_width_meters": round(float(path_width_meters), 4),
            "confidence": float(out_conf),
            "left_boundary_visible": out_left_vis,
            "right_boundary_visible": out_right_vis,
            "centerline": centerline,
            "nearest_edge_m": edge_info["nearest_edge_m"],
            "nearest_edge_side": edge_info["nearest_edge_side"],
            "nearest_edge_clearance_m": edge_info["nearest_edge_clearance_m"],
            "nearest_edge_type": edge_info["nearest_edge_type"],
            "left_edge_clearance_m": edge_info.get("left_edge_clearance_m"),
            "right_edge_clearance_m": edge_info.get("right_edge_clearance_m"),
            "edge_left_m": edge_guidance["left_m"],
            "edge_left_conf": edge_guidance["left_conf"],
            "edge_left_x_m": edge_guidance["left_x_m"],
            "edge_left_y_m": edge_guidance["left_y_m"],
            "edge_left_known": edge_guidance["left_known"],
            "edge_left_known_age_ms": edge_guidance["left_known_age_ms"],
            "edge_right_m": edge_guidance["right_m"],
            "edge_right_conf": edge_guidance["right_conf"],
            "edge_right_x_m": edge_guidance["right_x_m"],
            "edge_right_y_m": edge_guidance["right_y_m"],
            "edge_right_known": edge_guidance["right_known"],
            "edge_right_known_age_ms": edge_guidance["right_known_age_ms"],
            "edge_used": edge_guidance["used"],
            "edge_target_offset_m": edge_guidance["offset_m"] if edge_guidance["valid"] else None,
            "edge_forward_m": edge_guidance["forward_m"],
            "edge_guidance_valid": edge_guidance["valid"],
            "ground_grid_removed_frac": self._last_ground_removed_frac,
            "status": "tracking" if out_conf >= 0.6 else "low_confidence"
        }

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

    def _compute_centerline(self, walkable_mask, green_mask_roi, roi_depth, intrinsics, roi_row_start):
        # Split the ROI into N horizontal bands. For each band, find the sidewalk
        # center pixel and convert to (forward_m, lateral_offset_m). Result is a
        # list of points along the sidewalk centerline, ordered near→far. This is
        # what the carrot-projection uses so it tracks curves instead of cutting
        # the chord between rover and waypoint.
        # Sign convention matches offset_meters: positive lateral_offset_m = sidewalk
        # center is to the LEFT of the camera bore at that forward distance.
        # forward_m is corrected for current rover pitch so that bumps/potholes don't
        # squash or stretch the per-band depth.
        N_BANDS = 6
        h, w = walkable_mask.shape
        band_h = max(1, h // N_BANDS)
        ppx = intrinsics.ppx
        ppy = intrinsics.ppy
        fx = intrinsics.fx
        fy = intrinsics.fy
        pitch = float(self.current_pitch_rad)
        roll  = float(self.current_roll_rad)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll),  math.sin(roll)

        points = []
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

            if left_px is None and right_px is None:
                continue

            # Estimate a center depth first using whichever boundary we have, then
            # use it to scale a half-width assumption when only one boundary is visible.
            ref_px = left_px if left_px is not None else right_px
            ref_depth = self.sample_depth_meters(band_depth, ref_px)
            if not ref_depth or np.isnan(ref_depth):
                continue

            if left_px is not None and right_px is not None and right_px > left_px:
                center_px = (left_px + right_px) / 2.0
            elif left_px is not None:
                half_w = self.meters_to_pixel_span(self.last_path_width_meters / 2.0, ref_depth, fx)
                center_px = left_px + half_w
            else:
                half_w = self.meters_to_pixel_span(self.last_path_width_meters / 2.0, ref_depth, fx)
                center_px = right_px - half_w

            center_px = float(np.clip(center_px, 0, w - 1))
            center_depth = self.sample_depth_meters(band_depth, center_px)
            if not center_depth or np.isnan(center_depth) or center_depth < 0.2 or center_depth > 8.0:
                continue

            # Roll- and pitch-correct the band's center point.
            # Use the band's middle row (full-image coords) as the representative row.
            band_mid_row_full = roi_row_start + (r0 + r1) / 2.0
            cam_X = (center_px - ppx) * center_depth / fx
            cam_Y = (band_mid_row_full - ppy) * center_depth / fy
            # Un-roll: (cam_X, cam_Y) → (rolled_X, rolled_Y)
            rolled_X = cr * cam_X - sr * cam_Y
            rolled_Y = sr * cam_X + cr * cam_Y
            # Un-pitch on the rolled Y/Z → recover horizontal forward
            horizontal_forward = sp * rolled_Y + cp * center_depth
            if horizontal_forward < 0.2 or horizontal_forward > 8.0:
                continue

            lateral_offset_m = -rolled_X
            points.append({
                "forward_m": round(float(horizontal_forward), 3),
                "lateral_offset_m": round(float(lateral_offset_m), 4),
            })

        points.sort(key=lambda p: p["forward_m"])
        return points

    def _compute_edge_clearance(self, walkable_mask, green_mask_roi, roi_depth, intrinsics, roi_row_start):
        # For each near-field band, compute the lateral clearance from the rover's
        # track edges to the nearest sidewalk boundary. Negative clearance = the
        # rover's wheel would be off the sidewalk at that forward distance.
        # Also detect drop-offs (signed depth jumps) which require tighter clearance.
        # Returns the worst-case (smallest clearance) across all bands within range.
        no_edge = {
            "nearest_edge_m": None,
            "nearest_edge_side": None,
            "nearest_edge_clearance_m": None,
            "nearest_edge_type": None,
            "left_edge_clearance_m": None,
            "right_edge_clearance_m": None,
        }
        rover_width_m = float(self.config.get("rover_width_m", 0.432))
        half_rover_w  = rover_width_m / 2.0
        max_lookahead_m = float(self.config.get("edge_max_lookahead_m", 2.5))
        dropoff_jump_m = float(self.config.get("dropoff_min_depth_jump_m", 0.15))

        N_BANDS = 6
        h, w = walkable_mask.shape
        band_h = max(1, h // N_BANDS)
        ppx = intrinsics.ppx
        ppy = intrinsics.ppy
        fx = intrinsics.fx
        fy = intrinsics.fy
        pitch = float(self.current_pitch_rad)
        roll  = float(self.current_roll_rad)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll),  math.sin(roll)

        worst = None        # (clearance_m, forward_m, side, edge_type)
        worst_left = None   # (clearance_m, forward_m, edge_type)
        worst_right = None  # (clearance_m, forward_m, edge_type)

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

            # Signed depth gradient — positive jump = surface farther than expected = drop-off
            # Negative jump = surface closer than expected = obstacle / curb wall
            signed_left, signed_right = self._find_signed_depth_edges(band_depth, dropoff_jump_m)

            # Determine each side's boundary pixel, preferring drop-off (more dangerous)
            left_px  = signed_left  if signed_left  is not None else color_left
            right_px = signed_right if signed_right is not None else color_right
            left_is_dropoff  = signed_left  is not None
            right_is_dropoff = signed_right is not None

            if left_px is None and right_px is None:
                continue

            # Need a depth to convert pixel offsets to lateral meters.
            ref_px = left_px if left_px is not None else right_px
            depth_at_ref = self.sample_depth_meters(band_depth, ref_px)
            if not depth_at_ref or np.isnan(depth_at_ref):
                continue

            band_mid_row_full = roi_row_start + (r0 + r1) / 2.0
            # Forward distance to this band (pitch- and roll-corrected, same convention as centerline)
            cam_Y_mid = (band_mid_row_full - ppy) * depth_at_ref / fy
            cam_X_mid = 0.0  # representative col at center for forward distance
            rolled_Y_mid = sr * cam_X_mid + cr * cam_Y_mid
            forward_m = sp * rolled_Y_mid + cp * depth_at_ref
            if forward_m < 0.2 or forward_m > max_lookahead_m:
                continue

            # Per-side lateral clearance from rover track edge to boundary.
            # Sign convention: lateral_m > 0 = LEFT of camera bore (matches offset_meters).
            for side_label, bx, is_dropoff in (
                ("left",  left_px,  left_is_dropoff),
                ("right", right_px, right_is_dropoff),
            ):
                if bx is None:
                    continue
                cam_X_b = (bx - ppx) * depth_at_ref / fx        # +right
                cam_Y_b = (band_mid_row_full - ppy) * depth_at_ref / fy
                rolled_X_b = cr * cam_X_b - sr * cam_Y_b
                boundary_lateral_m = -rolled_X_b  # +left convention

                if side_label == "left":
                    # Rover's left edge is at +half_rover_w (left of bore). Clearance is
                    # how far the boundary is OUTSIDE the rover's left edge.
                    clearance = boundary_lateral_m - half_rover_w
                else:
                    # Rover's right edge is at -half_rover_w. Clearance = how far the
                    # boundary is OUTSIDE the rover's right edge (boundary more negative).
                    clearance = -half_rover_w - boundary_lateral_m

                edge_type = "dropoff" if is_dropoff else "boundary"
                if worst is None or clearance < worst[0]:
                    worst = (clearance, forward_m, side_label, edge_type)
                if side_label == "left":
                    if worst_left is None or clearance < worst_left[0]:
                        worst_left = (clearance, forward_m, edge_type)
                else:
                    if worst_right is None or clearance < worst_right[0]:
                        worst_right = (clearance, forward_m, edge_type)

        if worst is None:
            return no_edge
        return {
            "nearest_edge_m":           round(float(worst[1]), 3),
            "nearest_edge_side":        worst[2],
            "nearest_edge_clearance_m": round(float(worst[0]), 4),
            "nearest_edge_type":        worst[3],
            "left_edge_clearance_m":    round(float(worst_left[0]), 3) if worst_left is not None else None,
            "right_edge_clearance_m":   round(float(worst_right[0]), 3) if worst_right is not None else None,
        }

    def _build_rover_bev_mask(self, walkable_mask, roi_depth, intrinsics, roi_row_start):
        # Project the walkable mask into a rover-horizontal occupancy map.
        # In this view, forward distance is the row axis and left/right offset is
        # the column axis, which makes path edges much easier to reason about.
        cam_h = float(self.config.get("camera_height_m", 0.406))
        ground_tol = float(self.config.get("ground_height_tol_m", 0.10))
        max_forward_m = max(float(self.config.get("edge_max_lookahead_m", 2.5)) + 0.75, 2.0)
        half_width_m = max(
            1.5,
            float(self.config.get("rover_width_m", 0.432)) * 2.5,
            float(self.config.get("edge_side_offset_m", 0.4572)) * 2.0 + 0.8,
        )
        cell_m = 0.05
        bev_w = max(3, int(math.ceil((2.0 * half_width_m) / cell_m)) + 1)
        bev_h = max(3, int(math.ceil(max_forward_m / cell_m)) + 1)
        bev = np.zeros((bev_h, bev_w), dtype=np.uint8)

        mask_bool = walkable_mask > 0
        valid = mask_bool & np.isfinite(roi_depth) & (roi_depth > 0.2) & (roi_depth < (max_forward_m + 2.0))
        vy, vx = np.where(valid)
        if vy.size == 0:
            return None

        fx, fy = intrinsics.fx, intrinsics.fy
        ppx, ppy = intrinsics.ppx, intrinsics.ppy
        pitch = float(self.current_pitch_rad)
        roll = float(self.current_roll_rad)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll), math.sin(roll)

        z = roi_depth[vy, vx].astype(np.float32)
        cam_X = (vx - ppx) * z / fx
        cam_Y = ((vy + roi_row_start) - ppy) * z / fy
        rolled_X = cr * cam_X - sr * cam_Y
        rolled_Y = sr * cam_X + cr * cam_Y
        horizontal_down = cp * rolled_Y - sp * z
        horizontal_forward = sp * rolled_Y + cp * z
        world_Y = cam_h - horizontal_down
        world_X = rolled_X
        world_Z = horizontal_forward

        finite = np.isfinite(world_X) & np.isfinite(world_Z) & np.isfinite(world_Y)
        if not np.any(finite):
            return None

        world_X = world_X[finite]
        world_Z = world_Z[finite]
        world_Y = world_Y[finite]

        keep = (
            (np.abs(world_Y) <= ground_tol)
            & (world_Z >= 0.0)
            & (world_Z <= max_forward_m)
            & (np.abs(world_X) <= half_width_m)
        )
        if not np.any(keep):
            return None

        world_X = world_X[keep]
        world_Z = world_Z[keep]

        xi = np.floor((world_X + half_width_m) / cell_m).astype(np.int64)
        zi = np.floor(world_Z / cell_m).astype(np.int64)
        xi = np.clip(xi, 0, bev_w - 1)
        zi = np.clip(zi, 0, bev_h - 1)
        bev[zi, xi] = 255

        bev = cv2.medianBlur(bev, 3)
        bev = cv2.morphologyEx(bev, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        bev = cv2.morphologyEx(bev, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        bev = self._select_center_component(bev)
        if np.count_nonzero(bev) == 0:
            return None

        return {
            "mask": bev,
            "cell_m": cell_m,
            "half_width_m": half_width_m,
            "max_forward_m": max_forward_m,
        }

    def _edge_guidance_default(self):
        return {
            "valid": False,
            "x_angle_deg": 0.0,
            "offset_m": 0.0,
            "left_m": None, "left_conf": 0.0,
            "right_m": None, "right_conf": 0.0,
            "left_x_m": None, "left_y_m": None,
            "right_x_m": None, "right_y_m": None,
            "left_known": False, "right_known": False,
            "left_known_age_ms": None, "right_known_age_ms": None,
            "used": "none",
            "forward_m": None,
            "confidence": 0.0,
        }

    def _compute_edge_guidance(self, walkable_mask, green_mask_roi, roi_depth, intrinsics, roi_row_start):
        # Edge-as-guiding-key: look at a single near-field band ~edge_lookahead_m ahead
        # (default 2 ft) and steer to hold the rover edge_side_offset_m (default 1.5 ft)
        # off the sidewalk edge. "I only want to see edge detection 2 feet ahead" — so
        # we ignore everything else and pick the one band closest to the lookahead that
        # actually has an edge in view (nearest visible band, robust to camera pitch).
        #
        # Per-side confidence comes from how many independent detectors agree on that
        # boundary (appearance/color, depth gradient, signed drop-off). When BOTH edges
        # are visible we steer off the higher-confidence one. When only one is visible
        # we steer off it. Sign convention matches offset_meters / x_angle_deg:
        #   lateral_m > 0 = LEFT of camera bore;  x_angle_deg > 0 = target to RIGHT.
        result = self._edge_guidance_default()
        bev = self._build_rover_bev_mask(walkable_mask, roi_depth, intrinsics, roi_row_start)
        if bev is not None:
            bev_mask = bev["mask"]
            cell_m = float(bev["cell_m"])
            half_width_m = float(bev["half_width_m"])
            max_forward_m = float(bev["max_forward_m"])
            lookahead_m = float(self.config.get("edge_lookahead_m", 0.6096))
            side_offset_m = float(self.config.get("edge_side_offset_m", 0.4572))
            known_ttl_ms = float(self.config.get("edge_known_ttl_ms", 5000))

            h, w = bev_mask.shape
            n_bands = max(1, int(self.config.get("edge_guidance_bands", 8)))
            band_span_m = min(
                max(0.35, lookahead_m * 0.75),
                max(0.35, max_forward_m - lookahead_m),
            )
            band_thickness_m = max(0.08, min(0.22, lookahead_m * 0.18))
            band_centers_m = np.linspace(
                max(0.2, lookahead_m - band_span_m),
                min(max_forward_m, lookahead_m + band_span_m),
                n_bands,
            )

            closest = {"left": None, "right": None}
            best = None

            def obs_from_bev(px, band_forward_m, band_width_px, side_label):
                x_right_m = (float(px) + 0.5) * cell_m - half_width_m
                left_m = -x_right_m
                confidence = 0.55 + min(0.3, (float(band_width_px) / max(1.0, float(w))) * 0.9)
                if 0.4 <= float(band_width_px) * cell_m <= 3.5:
                    confidence += 0.1
                if side_label == "left" and left_m >= 0.0:
                    confidence += 0.03
                if side_label == "right" and left_m <= 0.0:
                    confidence += 0.03
                confidence = float(max(0.0, min(0.98, confidence)))
                return {
                    "m": round(float(left_m), 4),
                    "x_m": round(float(x_right_m), 4),
                    "y_m": round(float(band_forward_m), 3),
                    "conf": confidence,
                    "ts": time.time(),
                }

            for band_center_m in band_centers_m:
                center_row = int(round(float(band_center_m) / cell_m))
                band_rows = max(2, int(round(band_thickness_m / cell_m)))
                r0 = max(0, center_row - band_rows // 2)
                r1 = min(h, r0 + band_rows)
                if r1 - r0 < 2:
                    continue

                band_mask = bev_mask[r0:r1, :]
                if np.count_nonzero(band_mask) == 0:
                    continue

                band_scores = band_mask.mean(axis=0) / 255.0
                left_px, right_px = self.find_independent_edges(
                    band_scores,
                    threshold=float(self.config.get("edge_mask_threshold", 0.18)),
                    min_run_px=int(self.config.get("edge_min_run_px", 6)),
                    border_px=int(self.config.get("edge_border_margin_px", 2)),
                )
                if left_px is None and right_px is None:
                    continue

                band_forward_m = ((r0 + r1) * 0.5) * cell_m
                if band_forward_m < 0.2 or band_forward_m > max_forward_m:
                    continue

                band_width_px = 0
                if left_px is not None and right_px is not None and right_px > left_px:
                    band_width_px = int(right_px - left_px + 1)

                if left_px is not None:
                    left_obs = obs_from_bev(left_px, band_forward_m, band_width_px or 1, "left")
                    if closest["left"] is None or left_obs["y_m"] < closest["left"]["y_m"]:
                        closest["left"] = left_obs
                if right_px is not None:
                    right_obs = obs_from_bev(right_px, band_forward_m, band_width_px or 1, "right")
                    if closest["right"] is None or right_obs["y_m"] < closest["right"]["y_m"]:
                        closest["right"] = right_obs

                if left_px is None and right_px is not None:
                    band_info = {
                        "forward_m": float(band_forward_m),
                        "left_m": None,
                        "left_conf": 0.0,
                        "right_m": right_obs["m"],
                        "right_conf": right_obs["conf"],
                        "left_x_m": None,
                        "right_x_m": right_obs["x_m"],
                    }
                elif right_px is None and left_px is not None:
                    band_info = {
                        "forward_m": float(band_forward_m),
                        "left_m": left_obs["m"],
                        "left_conf": left_obs["conf"],
                        "right_m": None,
                        "right_conf": 0.0,
                        "left_x_m": left_obs["x_m"],
                        "right_x_m": None,
                    }
                else:
                    band_info = {
                        "forward_m": float(band_forward_m),
                        "left_m": left_obs["m"],
                        "left_conf": left_obs["conf"],
                        "right_m": right_obs["m"],
                        "right_conf": right_obs["conf"],
                        "left_x_m": left_obs["x_m"],
                        "right_x_m": right_obs["x_m"],
                    }

                if best is None or abs(float(band_forward_m) - lookahead_m) < abs(best["forward_m"] - lookahead_m):
                    best = band_info

            now_ts = time.time()
            for side in ("left", "right"):
                if closest[side] is not None:
                    self.last_edge_obs[side] = closest[side]

            def known_edge(side):
                cur = closest[side]
                if cur is not None:
                    return cur, 0.0, True
                last = self.last_edge_obs.get(side)
                if last is None:
                    return None, None, False
                age_ms = (now_ts - float(last.get("ts", now_ts))) * 1000.0
                if age_ms > known_ttl_ms:
                    return None, None, False
                return last, age_ms, True

            left_known, left_age_ms, left_known_ok = known_edge("left")
            right_known, right_age_ms, right_known_ok = known_edge("right")

            result.update({
                "left_m": round(float(left_known["m"]), 4) if left_known_ok else None,
                "left_conf": round(float(left_known["conf"]), 2) if left_known_ok else 0.0,
                "left_x_m": round(float(left_known["x_m"]), 4) if left_known_ok else None,
                "left_y_m": round(float(left_known["y_m"]), 3) if left_known_ok else None,
                "right_m": round(float(right_known["m"]), 4) if right_known_ok else None,
                "right_conf": round(float(right_known["conf"]), 2) if right_known_ok else 0.0,
                "right_x_m": round(float(right_known["x_m"]), 4) if right_known_ok else None,
                "right_y_m": round(float(right_known["y_m"]), 3) if right_known_ok else None,
                "left_known": bool(left_known_ok),
                "right_known": bool(right_known_ok),
                "left_known_age_ms": round(float(left_age_ms), 1) if left_age_ms is not None else None,
                "right_known_age_ms": round(float(right_age_ms), 1) if right_age_ms is not None else None,
            })

            if best is not None:
                left_m = best["left_m"]
                left_conf = best["left_conf"]
                right_m = best["right_m"]
                right_conf = best["right_conf"]
                forward_m = best["forward_m"]

                present = {"left": left_m is not None, "right": right_m is not None}
                conf = {"left": left_conf, "right": right_conf}

                if self.last_edge_used is not None and (time.time() - self.last_edge_used_ts) * 1000.0 > float(self.config.get("edge_hysteresis_ttl_ms", 3000)):
                    self.last_edge_used = None

                prev = self.last_edge_used
                other = "right" if prev == "left" else "left"
                if prev is not None and present.get(prev) and conf[prev] >= float(self.config.get("edge_hysteresis_keep_conf", 0.6)):
                    if present.get(other) and (conf[other] - conf[prev]) >= float(self.config.get("edge_hysteresis_switch_margin", 0.2)):
                        use = other
                    else:
                        use = prev
                elif left_m is not None and right_m is not None:
                    use = "left" if left_conf >= right_conf else "right"
                elif left_m is not None:
                    use = "left"
                elif right_m is not None:
                    use = "right"
                else:
                    use = None

                if use is not None:
                    self.last_edge_used = use
                    self.last_edge_used_ts = time.time()

                    if use == "left":
                        u_target = left_m - side_offset_m
                        chosen_conf = left_conf
                    else:
                        u_target = right_m + side_offset_m
                        chosen_conf = right_conf

                    x_angle_deg = math.degrees(math.atan2(-u_target, forward_m)) if forward_m > 0 else 0.0
                    result.update({
                        "valid": True,
                        "x_angle_deg": round(float(x_angle_deg), 2),
                        "offset_m": round(float(u_target), 4),
                        "used": use,
                        "forward_m": round(float(forward_m), 3),
                        "confidence": round(float(chosen_conf), 2),
                    })
                    return result

        lookahead_m   = float(self.config.get("edge_lookahead_m",   0.6096))  # 2 ft
        side_offset_m = float(self.config.get("edge_side_offset_m", 0.4572))  # 1.5 ft
        max_forward_m = float(self.config.get("edge_max_lookahead_m", 2.5))
        dropoff_jump_m = float(self.config.get("dropoff_min_depth_jump_m", 0.15))
        known_ttl_ms = float(self.config.get("edge_known_ttl_ms", 5000))
        ground_only = bool(self.config.get("edge_ground_only", True))
        ground_source = str(self.config.get("edge_ground_source", "mask_only")).lower()

        N_BANDS = int(self.config.get("edge_guidance_bands", 8))
        h, w = walkable_mask.shape
        band_h = max(1, h // N_BANDS)
        ppx, ppy = intrinsics.ppx, intrinsics.ppy
        fx, fy   = intrinsics.fx, intrinsics.fy
        pitch = float(self.current_pitch_rad)
        roll  = float(self.current_roll_rad)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll),  math.sin(roll)

        def side_edge(color_px, depth_px, signed_px, mask_px):
            # Merge the detectors that fired on this side; confidence rises with agreement.
            if ground_only:
                # Ground-plane sidewalk guidance: use XY walkable mask edges only when
                # edge_ground_source is "mask_only". This avoids vertical Z-edge cues.
                if ground_source == "mask_only":
                    dets = [p for p in (mask_px,) if p is not None]
                else:
                    dets = [p for p in (color_px, mask_px) if p is not None]
            else:
                dets = [p for p in (color_px, depth_px, signed_px, mask_px) if p is not None]
            if not dets:
                return None, 0.0
            px = float(np.mean(dets))
            if len(dets) >= 2:
                conf = 0.9 if (max(dets) - min(dets)) <= 15 else 0.7
            else:
                conf = 0.6
            if (not ground_only) and signed_px is not None:
                conf = min(1.0, conf + 0.05)  # a real drop-off is a strong physical cue
            return px, conf

        best = None  # band closest to the lookahead with at least one usable edge
        closest = {"left": None, "right": None}  # nearest currently visible edge per side
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
            # Independent per-side mask edges so losing one edge never nulls the other.
            # (find_nearest_mask_edges returns the two ends of one run together — the
            # source of the "both edges disappear at once" coupling.) In the live config
            # (edge_ground_source="mask_only") side_edge uses ONLY these mask edges.
            mask_left, mask_right = self.find_independent_edges(
                band_col_scores,
                threshold=float(self.config.get("edge_mask_threshold", 0.18)),
                min_run_px=int(self.config.get("edge_min_run_px", 6)),
                border_px=int(self.config.get("edge_border_margin_px", 2)),
            )
            depth_left, depth_right = self.find_depth_boundaries(band_depth)
            signed_left, signed_right = self._find_signed_depth_edges(band_depth, dropoff_jump_m)
            if ground_only:
                signed_left, signed_right = None, None

            if ground_only:
                all_px = [p for p in (color_left, color_right, mask_left, mask_right) if p is not None]
            else:
                all_px = [p for p in (color_left, color_right, depth_left, depth_right,
                                      signed_left, signed_right, mask_left, mask_right) if p is not None]
            if not all_px:
                continue
            ref_depth = self.sample_depth_meters(band_depth, float(np.mean(all_px)))
            if not ref_depth or np.isnan(ref_depth):
                continue

            band_mid_row_full = roi_row_start + (r0 + r1) / 2.0
            cam_Y_mid = (band_mid_row_full - ppy) * ref_depth / fy
            rolled_Y_mid = cr * cam_Y_mid                       # cam_X_mid = 0 at center
            forward_m = sp * rolled_Y_mid + cp * ref_depth
            if forward_m < 0.2 or forward_m > max_forward_m:
                continue

            left_px,  left_conf  = side_edge(color_left,  depth_left,  signed_left,  mask_left)
            right_px, right_conf = side_edge(color_right, depth_right, signed_right, mask_right)
            if left_px is None and right_px is None:
                continue

            def lateral_of(bx):
                cam_X_b = (bx - ppx) * ref_depth / fx
                cam_Y_b = (band_mid_row_full - ppy) * ref_depth / fy
                rolled_X_b = cr * cam_X_b - sr * cam_Y_b
                return -rolled_X_b                              # +left convention

            def x_right_of(bx):
                cam_X_b = (bx - ppx) * ref_depth / fx
                cam_Y_b = (band_mid_row_full - ppy) * ref_depth / fy
                return cr * cam_X_b - sr * cam_Y_b             # +right convention

            band_info = {
                "forward_m": float(forward_m),
                "left_m":  lateral_of(left_px)  if left_px  is not None else None,
                "left_conf":  left_conf  if left_px  is not None else 0.0,
                "right_m": lateral_of(right_px) if right_px is not None else None,
                "right_conf": right_conf if right_px is not None else 0.0,
                "left_x_m": x_right_of(left_px) if left_px is not None else None,
                "right_x_m": x_right_of(right_px) if right_px is not None else None,
            }

            if left_px is not None:
                left_obs = {
                    "m": float(band_info["left_m"]),
                    "x_m": float(band_info["left_x_m"]),
                    "y_m": float(forward_m),
                    "conf": float(left_conf),
                    "ts": time.time(),
                }
                if closest["left"] is None or left_obs["y_m"] < closest["left"]["y_m"]:
                    closest["left"] = left_obs
            if right_px is not None:
                right_obs = {
                    "m": float(band_info["right_m"]),
                    "x_m": float(band_info["right_x_m"]),
                    "y_m": float(forward_m),
                    "conf": float(right_conf),
                    "ts": time.time(),
                }
                if closest["right"] is None or right_obs["y_m"] < closest["right"]["y_m"]:
                    closest["right"] = right_obs

            if best is None or abs(forward_m - lookahead_m) < abs(best["forward_m"] - lookahead_m):
                best = band_info

        # Refresh last-known per-side observations from the nearest currently visible edges.
        now_ts = time.time()
        for side in ("left", "right"):
            if closest[side] is not None:
                self.last_edge_obs[side] = closest[side]

        # Read the freshest known edge for each side (current frame preferred, then cache).
        def known_edge(side):
            cur = closest[side]
            if cur is not None:
                return cur, 0.0, True
            last = self.last_edge_obs.get(side)
            if last is None:
                return None, None, False
            age_ms = (now_ts - float(last.get("ts", now_ts))) * 1000.0
            if age_ms > known_ttl_ms:
                return None, None, False
            return last, age_ms, True

        left_known, left_age_ms, left_known_ok = known_edge("left")
        right_known, right_age_ms, right_known_ok = known_edge("right")

        result.update({
            "left_m": round(float(left_known["m"]), 4) if left_known_ok else None,
            "left_conf": round(float(left_known["conf"]), 2) if left_known_ok else 0.0,
            "left_x_m": round(float(left_known["x_m"]), 4) if left_known_ok else None,
            "left_y_m": round(float(left_known["y_m"]), 3) if left_known_ok else None,
            "right_m": round(float(right_known["m"]), 4) if right_known_ok else None,
            "right_conf": round(float(right_known["conf"]), 2) if right_known_ok else 0.0,
            "right_x_m": round(float(right_known["x_m"]), 4) if right_known_ok else None,
            "right_y_m": round(float(right_known["y_m"]), 3) if right_known_ok else None,
            "left_known": bool(left_known_ok),
            "right_known": bool(right_known_ok),
            "left_known_age_ms": round(float(left_age_ms), 1) if left_age_ms is not None else None,
            "right_known_age_ms": round(float(right_age_ms), 1) if right_age_ms is not None else None,
        })

        if best is None:
            return result

        left_m,  left_conf  = best["left_m"],  best["left_conf"]
        right_m, right_conf = best["right_m"], best["right_conf"]
        forward_m = best["forward_m"]

        # Hysteresis: stick with the previously chosen edge while it stays confident.
        keep_conf     = float(self.config.get("edge_hysteresis_keep_conf",     0.6))
        switch_margin = float(self.config.get("edge_hysteresis_switch_margin", 0.2))
        ttl_ms        = float(self.config.get("edge_hysteresis_ttl_ms",        3000))

        present = {"left": left_m is not None, "right": right_m is not None}
        conf    = {"left": left_conf, "right": right_conf}

        # Forget a stale choice so a fresh pick can be made after a gap in tracking.
        if self.last_edge_used is not None and (time.time() - self.last_edge_used_ts) * 1000.0 > ttl_ms:
            self.last_edge_used = None

        prev = self.last_edge_used
        other = "right" if prev == "left" else "left"
        if prev is not None and present.get(prev) and conf[prev] >= keep_conf:
            # Keep the current edge unless the other one is substantially more confident.
            if present.get(other) and (conf[other] - conf[prev]) >= switch_margin:
                use = other
            else:
                use = prev
        elif left_m is not None and right_m is not None:
            use = "left" if left_conf >= right_conf else "right"
        elif left_m is not None:
            use = "left"
        elif right_m is not None:
            use = "right"
        else:
            return result

        self.last_edge_used = use
        self.last_edge_used_ts = time.time()

        if use == "left":
            u_target = left_m - side_offset_m   # hold 1.5 ft RIGHT of the left edge
            chosen_conf = left_conf
        else:
            u_target = right_m + side_offset_m  # hold 1.5 ft LEFT of the right edge
            chosen_conf = right_conf

        # Angle to the desired track position. +right target → x_angle_deg > 0 → steer right.
        x_angle_deg = math.degrees(math.atan2(-u_target, forward_m)) if forward_m > 0 else 0.0

        result.update({
            "valid": True,
            "x_angle_deg": round(float(x_angle_deg), 2),
            "offset_m": round(float(u_target), 4),
            "used": use,
            "forward_m": round(float(forward_m), 3),
            "confidence": round(float(chosen_conf), 2),
        })
        return result

    def _find_signed_depth_edges(self, depth_band, dropoff_jump_m):
        # Like find_depth_boundaries but uses SIGNED gradients so we can tell
        # drop-offs (positive jump: surface suddenly farther) apart from obstacles.
        # Returns (left_dropoff_px, right_dropoff_px) — pixel cols where a drop-off
        # edge appears on the left/right half of the band, or None on each side.
        if depth_band.size == 0 or np.all(np.isnan(depth_band)):
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
        n = len(valid_depth)
        center = n // 2

        left_dropoff = None
        right_dropoff = None
        # Left side: scanning from center leftward, a drop-off appears as a NEGATIVE
        # gradient (depth decreasing as col index increases past the cliff into solid ground
        # would be POSITIVE; depth increasing toward the cliff as we move left means
        # gradient[col] negative when col goes left-to-right across the cliff). Simpler:
        # scan left from center, first column where depth jumps up significantly = edge.
        for col in range(center - 1, 0, -1):
            if depth_profile[col] - depth_profile[col + 1] > dropoff_jump_m:
                left_dropoff = col + 1
                break
        for col in range(center + 1, n - 1):
            if depth_profile[col] - depth_profile[col - 1] > dropoff_jump_m:
                right_dropoff = col - 1
                break
        return left_dropoff, right_dropoff

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
                    vision.current_pitch_rad = val   # roll/pitch rotation math downstream
            except (TypeError, ValueError):
                pass
        elif msg == "roll":
            try:
                val = float(payload.get("value", 0.0))
                if math.isfinite(val):
                    vision.current_roll_rad = val
            except (TypeError, ValueError):
                pass

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