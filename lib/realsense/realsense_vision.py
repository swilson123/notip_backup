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
        # Adaptive seed for appearance-based / SAM ground segmentation.
        # Updated after each successful detection to track the previous
        # frame's near-band centerline pixel. None = no recent track, fall
        # back to bottom-center.
        self.last_seed_x = None
        self.last_seed_x_ts = 0.0
        # Edge-guidance hysteresis: once an edge is chosen as the steering reference,
        # stick with it as long as it stays confident — only switch sides when the
        # chosen edge degrades or the OTHER edge becomes substantially more confident.
        # Prevents the rover oscillating between left/right when the two edge
        # confidences are close and jitter by a few percent frame to frame.
        self.last_edge_used = None        # "left" / "right" / None
        self.last_edge_used_ts = 0.0
        # MobileSAM segmenter — loaded lazily in start(). When the ONNX
        # Cityscapes classifier returns a sparse mask, SAM is queried with
        # the adaptive seed point as a foreground prompt and its mask
        # becomes the walkable region. Class-agnostic, so it works on any
        # surface the rover is actually standing on.
        self.sam_segmenter = None
        self.sam_load_attempted = False
        self._funnel_cache_key = None
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
        self._load_sam_model()

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
            "edge_left_m": result.get("edge_left_m"),
            "edge_left_conf": result.get("edge_left_conf", 0),
            "edge_right_m": result.get("edge_right_m"),
            "edge_right_conf": result.get("edge_right_conf", 0),
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

    # Adaptive seed for appearance-based ground segmentation: pick a pixel
    # near the bottom of the frame that's likely on the surface the rover
    # is currently traversing. Use the previous frame's near-centerline x
    # (clipped to image bounds) if recent enough; otherwise bottom-center.
    def _pick_appearance_seed(self, color_image):
        h, w = color_image.shape[:2]
        seed_y_frac = float(self.config.get("appearance_seed_y_frac", 0.92))
        ttl_ms = float(self.config.get("appearance_seed_ttl_ms", 2000))
        y = int(np.clip(h * seed_y_frac, 0, h - 1))
        x = w // 2
        if self.last_seed_x is not None:
            age_ms = (time.time() - self.last_seed_x_ts) * 1000.0
            if age_ms <= ttl_ms:
                x = int(np.clip(self.last_seed_x, 0, w - 1))
        return (x, y)

    # MobileSAM ground segmentation. Class-agnostic ML segmenter: feed it an
    # image plus a foreground point (the adaptive seed — whatever surface
    # the rover is standing on), get back a high-quality mask of that
    # region. Replaces the older Photoshop-paint-bucket-style flood fill;
    # SAM understands shadows, two-tone surfaces, paint markings, and
    # perspective in ways pure color similarity cannot.
    def _load_sam_model(self):
        if self.sam_load_attempted:
            return
        self.sam_load_attempted = True
        if not bool(self.config.get("sam_enabled", True)):
            return
        encoder_path = self.config.get("sam_encoder_path") or "./lib/realsense/mobilesam/mobile_sam_encoder.onnx"
        decoder_path = self.config.get("sam_decoder_path") or "./lib/realsense/mobilesam/mobile_sam_decoder.onnx"
        try:
            from mobilesam.mobilesam import MobileSAMSegmenter
        except Exception:
            # Fall back to file-path import when the script isn't launched as a package.
            sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "mobilesam"))
            try:
                from mobilesam import MobileSAMSegmenter  # type: ignore
            except Exception as exc:
                emit({"message_type": "status", "status": "sam_load_failed",
                      "error": "import failed: " + str(exc),
                      "timestamp": int(time.time() * 1000)})
                return
        try:
            self.sam_segmenter = MobileSAMSegmenter(encoder_path, decoder_path)
            emit({"message_type": "status", "status": "sam_loaded",
                  "encoder": encoder_path, "decoder": decoder_path,
                  "timestamp": int(time.time() * 1000)})
        except Exception as exc:
            emit({"message_type": "status", "status": "sam_load_failed",
                  "error": str(exc), "timestamp": int(time.time() * 1000)})
            self.sam_segmenter = None

    def _get_funnel_maps(self, h, w):
        """
        Lazily build and cache forward + inverse remap tables for funnel vision.

        Forward map (fwd_x, fwd_y): used by cv2.remap to warp the color image so
        the center is magnified.  Each output pixel (dx, dy) samples from
            src = (fwd_x[dy,dx], fwd_y[dy,dx])
        using r_src = r_dst^gamma (gamma > 1 → center of output is magnified).

        Inverse map (inv_x, inv_y): used to un-warp the segmentation mask back to
        original image coordinates.  Each original pixel (ox, oy) looks up its
        value from the warped mask at (inv_x[oy,ox], inv_y[oy,ox]).
        """
        gamma = float(self.config.get("funnel_warp_gamma", 1.5))
        key = (h, w, gamma)
        if self._funnel_cache_key == key:
            return self._funnel_fwd_x, self._funnel_fwd_y, self._funnel_inv_x, self._funnel_inv_y

        cx = (w - 1) / 2.0
        cy_c = (h - 1) / 2.0
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
        xn = (xs - cx) / max(cx, 1.0)
        yn = (ys - cy_c) / max(cy_c, 1.0)
        r = np.sqrt(xn ** 2 + yn ** 2)
        r_safe = np.maximum(r, 1e-9)

        # Forward: output ← source.  r_src = r_dst^gamma → fwd_scale = r_dst^(gamma-1).
        # Near center r≈0: fwd_scale≈0 → many output pixels all pull from near the center
        # → center is magnified in the output.
        fwd_scale = r_safe ** (gamma - 1.0)
        self._funnel_fwd_x = (cx  + xn * fwd_scale * cx ).astype(np.float32)
        self._funnel_fwd_y = (cy_c + yn * fwd_scale * cy_c).astype(np.float32)

        # Inverse: original ← warped mask.  r_dst = r_src^(1/gamma) → inv_scale = r_src^(1/gamma-1).
        inv_scale = r_safe ** (1.0 / gamma - 1.0)
        self._funnel_inv_x = (cx  + xn * inv_scale * cx ).astype(np.float32)
        self._funnel_inv_y = (cy_c + yn * inv_scale * cy_c).astype(np.float32)

        self._funnel_cache_key = key
        return self._funnel_fwd_x, self._funnel_fwd_y, self._funnel_inv_x, self._funnel_inv_y

    def _get_sam_mask(self, color_image, seed_override=None):
        if self.sam_segmenter is None:
            return None
        try:
            seed = seed_override if seed_override is not None else self._pick_appearance_seed(color_image)
            if bool(self.config.get("sam_clahe_enabled", True)):
                clip  = float(self.config.get("sam_clahe_clip",      2.0))
                tile  = int(  self.config.get("sam_clahe_tile_size",  8))
                lab = cv2.cvtColor(color_image, cv2.COLOR_BGR2LAB)
                lab[:, :, 0] = cv2.createCLAHE(clipLimit=clip,
                                                tileGridSize=(tile, tile)).apply(lab[:, :, 0])
                color_image = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
            h, w = color_image.shape[:2]
            # Background points at 4 % and 96 % of image width, same row as the
            # seed: these columns are almost always outside the path, so they tell
            # SAM what NOT to include and prevent mask bleed into adjacent surfaces.
            bg_y = seed[1]
            bg_left  = (int(w * 0.04), bg_y)
            bg_right = (int(w * 0.96), bg_y)
            return self.sam_segmenter.infer(color_image, seed, background_points=[bg_left, bg_right])
        except Exception as exc:
            emit({"message_type": "status", "status": "sam_infer_failed",
                  "error": str(exc), "timestamp": int(time.time() * 1000)})
            return None

    def detect_path(self, color_image, depth_image, intrinsics):
        height, width = depth_image.shape[:2]
        row_start = int(height * 0.35)
        row_end = int(height * 0.90)
        roi_color = color_image[row_start:row_end, :]
        roi_depth = depth_image[row_start:row_end, :].astype(np.float32) * 0.001
        roi_depth[roi_depth <= 0] = np.nan

        # Mask source selection:
        #   "off"   — ONNX only (original behavior; SAM not consulted)
        #   "blend" — ONNX as a fast sanity check; SAM fills in when ONNX gives up
        #             (default). The threshold for "ONNX gave up" is whether
        #             its mask covers at least sam_onnx_min_area_frac of pixels.
        #   "only"  — SAM only (ONNX inference skipped entirely; slower but
        #             generalises off-sidewalk)
        # Either way we never OR ONNX and SAM — they were producing inflated
        # masks that shifted the boundary search. If both sources fail, the
        # HSV fallback below tries to do something.
        appearance_mode = str(self.config.get("appearance_mode", "blend")).lower()
        min_area_frac   = float(self.config.get("sam_onnx_min_area_frac", 0.02))

        # Funnel-vision warp: stretch the center of the color image before feeding it
        # to the seg models so the path occupies more pixels and is easier to classify.
        # The resulting mask is un-warped back to original coords before any depth or
        # intrinsics math touches it, so the rest of the pipeline is unaffected.
        funnel_enabled = bool(self.config.get("funnel_warp_enabled", False))
        if funnel_enabled:
            fwd_x, fwd_y, inv_x, inv_y = self._get_funnel_maps(height, width)
            color_for_seg = cv2.remap(color_image, fwd_x, fwd_y, cv2.INTER_LINEAR)
            # Transform the SAM seed from original coords into warped coords.
            orig_seed = self._pick_appearance_seed(color_image)
            sx = int(np.clip(orig_seed[0], 0, width - 1))
            sy = int(np.clip(orig_seed[1], 0, height - 1))
            sam_seed_override = (int(round(float(inv_x[sy, sx]))),
                                 int(round(float(inv_y[sy, sx]))))
        else:
            color_for_seg = color_image
            sam_seed_override = None

        seg_mask = None
        sam_mask = None
        if appearance_mode == "off":
            seg_mask = self._get_sidewalk_mask(color_for_seg)
            combined_mask = seg_mask
        elif appearance_mode == "only":
            sam_mask = self._get_sam_mask(color_for_seg, seed_override=sam_seed_override)
            combined_mask = sam_mask
        else:  # "blend"
            seg_mask = self._get_sidewalk_mask(color_for_seg)
            img_pixels = color_for_seg.shape[0] * color_for_seg.shape[1]
            onnx_confident = (seg_mask is not None and
                              cv2.countNonZero(seg_mask) >= int(min_area_frac * img_pixels))
            if onnx_confident:
                combined_mask = seg_mask
            else:
                sam_mask = self._get_sam_mask(color_for_seg, seed_override=sam_seed_override)
                combined_mask = sam_mask if sam_mask is not None else seg_mask

        # Un-warp the mask back to original image coordinates.
        if combined_mask is not None and funnel_enabled:
            combined_mask = cv2.remap(combined_mask, inv_x, inv_y, cv2.INTER_NEAREST)

        if combined_mask is not None:
            roi_seg = combined_mask[row_start:row_end, :]
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
            "edge_left_m": edge_guidance["left_m"],
            "edge_left_conf": edge_guidance["left_conf"],
            "edge_right_m": edge_guidance["right_m"],
            "edge_right_conf": edge_guidance["right_conf"],
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

    def _edge_guidance_default(self):
        return {
            "valid": False,
            "x_angle_deg": 0.0,
            "offset_m": 0.0,
            "left_m": None, "left_conf": 0.0,
            "right_m": None, "right_conf": 0.0,
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
        lookahead_m   = float(self.config.get("edge_lookahead_m",   0.6096))  # 2 ft
        side_offset_m = float(self.config.get("edge_side_offset_m", 0.4572))  # 1.5 ft
        max_forward_m = float(self.config.get("edge_max_lookahead_m", 2.5))
        dropoff_jump_m = float(self.config.get("dropoff_min_depth_jump_m", 0.15))

        N_BANDS = int(self.config.get("edge_guidance_bands", 8))
        h, w = walkable_mask.shape
        band_h = max(1, h // N_BANDS)
        ppx, ppy = intrinsics.ppx, intrinsics.ppy
        fx, fy   = intrinsics.fx, intrinsics.fy
        pitch = float(self.current_pitch_rad)
        roll  = float(self.current_roll_rad)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll),  math.sin(roll)

        def side_edge(color_px, depth_px, signed_px):
            # Merge the detectors that fired on this side; confidence rises with agreement.
            dets = [p for p in (color_px, depth_px, signed_px) if p is not None]
            if not dets:
                return None, 0.0
            px = float(np.mean(dets))
            if len(dets) >= 2:
                conf = 0.9 if (max(dets) - min(dets)) <= 15 else 0.7
            else:
                conf = 0.6
            if signed_px is not None:
                conf = min(1.0, conf + 0.05)  # a real drop-off is a strong physical cue
            return px, conf

        best = None  # band closest to the lookahead with at least one usable edge
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
            signed_left, signed_right = self._find_signed_depth_edges(band_depth, dropoff_jump_m)

            all_px = [p for p in (color_left, color_right, depth_left, depth_right,
                                  signed_left, signed_right) if p is not None]
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

            left_px,  left_conf  = side_edge(color_left,  depth_left,  signed_left)
            right_px, right_conf = side_edge(color_right, depth_right, signed_right)
            if left_px is None and right_px is None:
                continue

            def lateral_of(bx):
                cam_X_b = (bx - ppx) * ref_depth / fx
                cam_Y_b = (band_mid_row_full - ppy) * ref_depth / fy
                rolled_X_b = cr * cam_X_b - sr * cam_Y_b
                return -rolled_X_b                              # +left convention

            band_info = {
                "forward_m": float(forward_m),
                "left_m":  lateral_of(left_px)  if left_px  is not None else None,
                "left_conf":  left_conf  if left_px  is not None else 0.0,
                "right_m": lateral_of(right_px) if right_px is not None else None,
                "right_conf": right_conf if right_px is not None else 0.0,
            }
            if best is None or abs(forward_m - lookahead_m) < abs(best["forward_m"] - lookahead_m):
                best = band_info

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
            "left_m":  round(float(left_m), 4)  if left_m  is not None else None,
            "left_conf":  round(float(left_conf), 2),
            "right_m": round(float(right_m), 4) if right_m is not None else None,
            "right_conf": round(float(right_conf), 2),
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