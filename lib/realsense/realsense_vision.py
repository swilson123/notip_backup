#!/usr/bin/env python3

import json
import math
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
        self.last_path_width_meters = 1.2
        self.frame_counter = 0
        self.last_fps_sample_at = time.time()
        self.last_fps_counter = 0
        self.measured_fps = 0
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

        result = self.detect_path(color_image, depth_image, intrinsics)
        objects = self.detect_objects(depth_image, intrinsics)
        self.update_measured_fps()

        return {
            "message_type": "path_detection",
            "offset_meters": result["offset_meters"],
            "path_width_meters": result["path_width_meters"],
            "confidence": result["confidence"],
            "left_boundary_visible": result["left_boundary_visible"],
            "right_boundary_visible": result["right_boundary_visible"],
            "cpu_percent": round(cpu_percent, 1),
            "fps_current": round(self.measured_fps, 1),
            "fps_target": self.current_fps_target,
            "status": result["status"],
            "source": "realsense_vision",
            "timestamp": int(time.time() * 1000),
            "objects": objects
        }

    def detect_path(self, color_image, depth_image, intrinsics):
        height, width = depth_image.shape[:2]
        row_start = int(height * 0.48)
        row_end = int(height * 0.88)
        roi_color = color_image[row_start:row_end, :]
        roi_depth = depth_image[row_start:row_end, :].astype(np.float32) * 0.001
        roi_depth[roi_depth <= 0] = np.nan

        hsv = cv2.cvtColor(roi_color, cv2.COLOR_BGR2HSV)
        saturation_limit = 80
        min_value = max(45, int(np.mean(hsv[:, :, 2]) * 0.55))
        concrete_mask = cv2.inRange(hsv, (0, 0, min_value), (179, saturation_limit, 255))
        green_mask = cv2.inRange(hsv, (28, 40, 25), (95, 255, 255))
        walkable_mask = cv2.bitwise_and(concrete_mask, cv2.bitwise_not(green_mask))
        walkable_mask = cv2.medianBlur(walkable_mask, 5)
        kernel = np.ones((5, 5), np.uint8)
        walkable_mask = cv2.morphologyEx(walkable_mask, cv2.MORPH_CLOSE, kernel)

        column_scores = walkable_mask.mean(axis=0) / 255.0
        color_left, color_right = self.find_mask_boundaries(column_scores)
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
            confidence = 0.55

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
            "status": "tracking" if confidence >= 0.6 else "low_confidence"
        }

    def find_mask_boundaries(self, column_scores):
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
        min_height_m     = float(self.config.get("object_min_height_m",  0.05))
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

        # Camera Y is positive-DOWN; world Y is positive-UP from ground
        cam_Y   = np.where(valid, (rows - cy) * depth_m / fy, np.nan)
        world_Y = np.where(valid, camera_height_m - cam_Y,     np.nan)
        world_X = np.where(valid, (cols - cx) * depth_m / fx,  np.nan)  # right +
        world_Z = np.where(valid, depth_m,                     np.nan)  # forward +

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
        if payload.get("message") == "shutdown":
            vision.stop()
            break


def main():
    config = parse_config()
    vision = RealsenseVision(config)
    listener = threading.Thread(target=stdin_listener, args=(vision,), daemon=True)
    listener.start()
    vision.run()


if __name__ == "__main__":
    main()