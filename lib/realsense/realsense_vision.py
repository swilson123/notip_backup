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
        self.frame_counter = 0
        self.last_fps_sample_at = time.time()
        self.last_fps_counter = 0
        self.measured_fps = 0
        self.seg_session = None
        self.seg_input_name = None
        self.seg_h = 256
        self.seg_w = 512
        self._SEG_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        self._SEG_STD  = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        # Latest rover pitch and roll in radians, updated via stdin messages from the
        # Node.js parent. Used to rotate camera-frame depth into a rover-horizontal frame
        # so potholes / bumps / off-camber surfaces don't corrupt object heights, lateral
        # positions, or centerline forward distances.
        #   pitch positive = nose up
        #   roll  positive = right side down
        self.current_pitch_rad = 0.0
        self.current_roll_rad  = 0.0
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)

    def stop(self, *_args):
        self.running = False

    def start(self):
        width = int(self.config.get("width", 640))
        height = int(self.config.get("height", 480))
        fps = int(self.config.get("fps_normal", 15))

        self.pipeline = rs.pipeline()
        rs_config = rs.config()
        rs_config.enable_stream(rs.stream.depth, width, height, rs.format.z16, fps)
        rs_config.enable_stream(rs.stream.color, width, height, rs.format.bgr8, fps)
        try:
            rs_config.enable_stream(rs.stream.infrared, 1, width, height, rs.format.y8, fps)
        except Exception:
            pass
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
        self._load_seg_model()

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
            while self.running:
                frames = self.pipeline.wait_for_frames(1000)
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

        try:
            ir_frame = frames.get_infrared_frame(1)
            ir_image = np.asanyarray(ir_frame.get_data()) if ir_frame else None
        except Exception:
            ir_image = None
        result = self.detect_path(color_image, depth_image, intrinsics, ir_image)
        objects = self.detect_objects(depth_image, intrinsics)
        self.update_measured_fps()

        return {
            "message_type": "path_detection",
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
            "cpu_percent": round(cpu_percent, 1),
            "fps_current": round(self.measured_fps, 1),
            "fps_target": self.current_fps_target,
            "status": result["status"],
            "source": "realsense_vision",
            "timestamp": int(time.time() * 1000),
            "objects": objects
        }

    def _load_seg_model(self):
        model_path = self.config.get("segmentation_model_path") or ""
        if not model_path or not os.path.isfile(model_path):
            return
        try:
            import onnxruntime as ort
            opts = ort.SessionOptions()
            opts.inter_op_num_threads = 2
            opts.intra_op_num_threads = 2
            self.seg_session = ort.InferenceSession(
                model_path, sess_options=opts, providers=["CPUExecutionProvider"]
            )
            self.seg_input_name = self.seg_session.get_inputs()[0].name
            self.seg_h = int(self.config.get("segmentation_input_height", 256))
            self.seg_w = int(self.config.get("segmentation_input_width", 512))
            emit({"message_type": "status", "status": "seg_model_loaded",
                  "input_size": [self.seg_w, self.seg_h],
                  "timestamp": int(time.time() * 1000)})
        except Exception as exc:
            emit({"message_type": "status", "status": "seg_model_failed",
                  "error": str(exc), "timestamp": int(time.time() * 1000)})
            self.seg_session = None

    def _get_sidewalk_mask(self, color_image):
        if self.seg_session is None:
            return None
        try:
            img = cv2.resize(color_image, (self.seg_w, self.seg_h))
            img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
            img = (img - self._SEG_MEAN) / self._SEG_STD
            inp = np.transpose(img, (2, 0, 1))[np.newaxis]
            logits = self.seg_session.run(None, {self.seg_input_name: inp})[0]  # (1,19,H/4,W/4)
            pred = np.argmax(logits[0], axis=0).astype(np.uint8)
            h, w = color_image.shape[:2]
            pred_full = cv2.resize(pred, (w, h), interpolation=cv2.INTER_NEAREST)
            return ((pred_full == 1) * 255).astype(np.uint8)  # Cityscapes class 1 = sidewalk
        except Exception:
            return None

    def detect_path(self, color_image, depth_image, intrinsics, ir_image=None):
        height, width = depth_image.shape[:2]
        row_start = int(height * 0.35)
        row_end = int(height * 0.90)
        roi_color = color_image[row_start:row_end, :]
        roi_depth = depth_image[row_start:row_end, :].astype(np.float32) * 0.001
        roi_depth[roi_depth <= 0] = np.nan
        roi_ir = ir_image[row_start:row_end, :] if ir_image is not None else None

        seg_mask = self._get_sidewalk_mask(color_image)
        if seg_mask is not None:
            roi_seg = seg_mask[row_start:row_end, :]
            walkable_mask = cv2.medianBlur(roi_seg, 5)
            walkable_mask = cv2.morphologyEx(walkable_mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
            green_mask_roi = None
            green_col_scores = None
        else:
            hsv = cv2.cvtColor(roi_color, cv2.COLOR_BGR2HSV)
            saturation_limit = 80
            min_value = max(45, int(np.mean(hsv[:, :, 2]) * 0.55))
            concrete_mask = cv2.inRange(hsv, (0, 0, min_value), (179, saturation_limit, 255))
            green_mask_roi = cv2.inRange(hsv, (35, 40, 25), (95, 255, 255))
            # Mulch/bark/brown soil: hue 8-32, meaningful saturation, not too bright
            mulch_mask = cv2.inRange(hsv, (8, 40, 20), (32, 255, 160))
            non_walkable = cv2.bitwise_or(green_mask_roi, mulch_mask)
            walkable_mask = cv2.bitwise_and(concrete_mask, cv2.bitwise_not(non_walkable))
            walkable_mask = cv2.medianBlur(walkable_mask, 5)
            kernel = np.ones((5, 5), np.uint8)
            walkable_mask = cv2.morphologyEx(walkable_mask, cv2.MORPH_CLOSE, kernel)
            green_col_scores = green_mask_roi.mean(axis=0) / 255.0

        centerline = self._compute_centerline(walkable_mask, green_mask_roi, roi_depth, intrinsics, row_start)
        edge_info = self._compute_edge_clearance(walkable_mask, green_mask_roi, roi_depth, intrinsics, row_start)

        column_scores = walkable_mask.mean(axis=0) / 255.0
        color_left, color_right = self.find_mask_boundaries(column_scores, green_col_scores)
        depth_left, depth_right = self.find_depth_boundaries(roi_depth)
        ir_left, ir_right = self._ir_boundaries(roi_ir)

        left_px = self.merge_boundary(color_left, depth_left, ir_left)
        right_px = self.merge_boundary(color_right, depth_right, ir_right)

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
                "status": "path_lost"
            }

        center_px = float(np.clip(center_px, 0, width - 1))
        center_depth = max(0.2, min(center_depth, 5.0))
        path_center_x_m = ((center_px - intrinsics.ppx) / intrinsics.fx) * center_depth
        offset_meters = -path_center_x_m

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

        return {
            "offset_meters": round(float(offset_meters), 4),
            "path_width_meters": round(float(path_width_meters), 4),
            "confidence": confidence,
            "left_boundary_visible": left_visible,
            "right_boundary_visible": right_visible,
            "centerline": centerline,
            "nearest_edge_m": edge_info["nearest_edge_m"],
            "nearest_edge_side": edge_info["nearest_edge_side"],
            "nearest_edge_clearance_m": edge_info["nearest_edge_clearance_m"],
            "nearest_edge_type": edge_info["nearest_edge_type"],
            "status": "tracking" if confidence >= 0.6 else "low_confidence"
        }

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

        worst = None  # (clearance_m, forward_m, side, edge_type)

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

        if worst is None:
            return no_edge
        return {
            "nearest_edge_m":           round(float(worst[1]), 3),
            "nearest_edge_side":        worst[2],
            "nearest_edge_clearance_m": round(float(worst[0]), 4),
            "nearest_edge_type":        worst[3],
        }

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
        # Positive diff = depth INCREASING column-to-column = drop-off as you scan right.
        # We want the inner edge — for the left side scan from center outward.
        gradient = np.diff(valid_depth)
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

    def _ir_boundaries(self, roi_ir):
        """Find path-edge candidates from the IR brightness gradient.

        Turf and concrete have different near-IR reflectances, so the transition
        shows as a brightness step in the IR image even when color detection fails
        (e.g. low light or washed-out concrete).  Color is still primary; IR fills
        in only for sides where color found nothing (via merge_boundary averaging).
        """
        if roi_ir is None or roi_ir.size == 0:
            return None, None

        # Average rows then smooth horizontally to suppress the IR dot pattern
        profile = cv2.GaussianBlur(roi_ir.astype(np.float32), (1, 5), 0).mean(axis=0)
        profile = cv2.GaussianBlur(
            profile.reshape(1, -1).astype(np.float32), (15, 1), 0
        ).reshape(-1)

        gradient = np.abs(np.diff(profile))
        if gradient.max() < 4:          # no meaningful brightness transition
            return None, None

        threshold = max(4.0, float(gradient.max()) * 0.35)
        n = len(gradient)
        center = n // 2

        # Left boundary: rightmost strong edge in the left half (inner turf edge)
        left_candidates = np.where(gradient[:center] > threshold)[0]
        ir_left = int(left_candidates[-1]) + 1 if left_candidates.size else None

        # Right boundary: leftmost strong edge in the right half
        right_candidates = np.where(gradient[center:] > threshold)[0]
        ir_right = center + int(right_candidates[0]) if right_candidates.size else None

        if ir_left is not None and ir_right is not None and ir_right <= ir_left:
            return None, None

        return ir_left, ir_right

    def merge_boundary(self, *boundaries):
        valid = [v for v in boundaries if v is not None]
        if not valid:
            return None
        return float(sum(valid) / len(valid))

    def sample_depth_meters(self, roi_depth, center_px):
        center_px = int(np.clip(center_px, 0, roi_depth.shape[1] - 1))
        left = max(0, center_px - 6)
        right = min(roi_depth.shape[1], center_px + 7)
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
                vision.current_pitch_rad = float(payload.get("value", 0.0))
            except (TypeError, ValueError):
                pass
        elif msg == "roll":
            try:
                vision.current_roll_rad = float(payload.get("value", 0.0))
            except (TypeError, ValueError):
                pass


def main():
    config = parse_config()
    vision = RealsenseVision(config)
    listener = threading.Thread(target=stdin_listener, args=(vision,), daemon=True)
    listener.start()
    vision.run()


if __name__ == "__main__":
    main()