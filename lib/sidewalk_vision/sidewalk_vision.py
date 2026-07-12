#!/usr/bin/env python3
"""
sidewalk_vision.py -- RealSense camera connection + Noah's proven sidewalk-vision
pipeline (FastSCNN segmentation -> ConcreteEdgeDetector -> CarrotVision).

Replaces the old lib/realsense/realsense_vision.py as the process connect_to_realsense.js
spawns. Same stdio protocol:
  - config arrives once as JSON in sys.argv[1] (the realsense_vision section of setup.json)
  - Node streams {"message": "pitch"|"roll"|"heading", "value": ...} lines on stdin
  - this process emits one JSON line per processed frame on stdout

Deliberately minimal per-frame output: the only steering signal Noah's JS
navigation layer (carrot.js) reads is x_angle_deg.
"""

import json
import math
import os
import sys
import threading
import time

try:
    import numpy as np
    import pyrealsense2 as rs
except Exception as exc:
    sys.stdout.write(json.dumps({
        "message_type": "status",
        "status": "error",
        "error": "dependency_import_failed",
        "detail": str(exc),
    }) + "\n")
    sys.stdout.flush()
    raise

sys.path.insert(0, os.path.dirname(__file__))
from concrete_edge_detector import ConcreteEdgeDetector
from carrot_vision import CarrotVision


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


class SidewalkVision:
    def __init__(self, config):
        self.config = config or {}
        self.running = True
        self.pipeline = None
        self.pipeline_started = False
        self.align = None

        self.fps_target = int(self.config.get("fps_normal", 6))
        self.last_processed_at = 0.0

        # Static camera mount tilt -- positive config value means the camera is
        # pitched forward/nose-down, the opposite sign of the nose-up-positive
        # body-pitch convention, so it's subtracted the same way the old
        # realsense_vision.py did.
        self.mount_pitch_rad = math.radians(float(self.config.get("camera_mount_pitch_deg", 0.0)))
        self.current_pitch_rad = -self.mount_pitch_rad
        self.current_roll_rad = 0.0
        self.current_heading_deg = None

        self.display_enabled = bool(self.config.get("display_enabled", False))
        self.display_capture_enabled = bool(self.config.get("display_capture_enabled", False))
        self.display_capture_interval_s = float(self.config.get("display_capture_interval_s", 1))
        self.display_capture_dir = self.config.get("display_capture_dir", "./screenshots/auto_capture")
        self.display_capture_max_frames = int(self.config.get("display_capture_max_frames", 200))
        self._last_capture_ts = 0.0

        # Both modules are the proven pipeline documented in INTEGRATION.md --
        # ConcreteEdgeDetector creates its own internal FastSCNNDetector, which
        # otherwise resolves models/fastscnn_sidewalk.onnx relative to its own
        # directory regardless of config -- pass segmentation_model_path through
        # explicitly so setup.json's path is actually the one used.
        self.edge_detector = ConcreteEdgeDetector(
            camera_height_m=float(self.config.get("camera_height_m", 0.406)),
            segmentation_model_path=self.config.get("segmentation_model_path") or None
        )
        self.carrot = CarrotVision()

    def stop(self):
        self.running = False

    def _reset_camera(self):
        try:
            ctx = rs.context()
            if len(ctx.query_devices()) == 0:
                return
            ctx.query_devices()[0].hardware_reset()
            deadline = time.time() + 10
            while time.time() < deadline:
                time.sleep(0.5)
                if len(rs.context().query_devices()) > 0:
                    time.sleep(1.0)  # extra settle time
                    return
        except Exception:
            pass

    def start(self):
        self._reset_camera()

        width  = int(self.config.get("screen_width", 1280))
        height = int(self.config.get("screen_height", 720))
        fps    = int(self.config.get("fps_normal", 6))

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

        emit({"message_type": "status", "status": "ready", "timestamp": int(time.time() * 1000)})

    def should_process_frame(self):
        if self.fps_target <= 0:
            return True
        now = time.time()
        if now - self.last_processed_at < 1.0 / float(self.fps_target):
            return False
        self.last_processed_at = now
        return True

    def process_frames(self, frames):
        aligned_frames = self.align.process(frames)
        depth_frame = aligned_frames.get_depth_frame()
        color_frame = aligned_frames.get_color_frame()
        if not depth_frame or not color_frame:
            return None

        depth_z16 = np.asanyarray(depth_frame.get_data())
        color_bgr = np.asanyarray(color_frame.get_data())
        color_rgb = color_bgr[:, :, ::-1]
        intrinsics = color_frame.profile.as_video_stream_profile().intrinsics

        edges = self.edge_detector.detect(
            color_rgb, depth_z16, intrinsics,
            pitch_rad=self.current_pitch_rad, roll_rad=self.current_roll_rad
        )
        result = self.carrot.compute(
            left_edge=edges.get("left_edge"),
            right_edge=edges.get("right_edge"),
            frame_shape=color_rgb.shape,
            intrinsics=intrinsics,
        )

        # confidence is ConcreteEdgeDetector's own edge-detection quality score
        # (0.0-1.0, from ANCHOR/RANSAC fit quality) -- zeroed out when CarrotVision
        # couldn't turn the edges into a valid steering angle this frame.
        x_angle_deg = result["carrot_angle_deg"] if result["path_valid"] else 0.0
        confidence = edges.get("confidence", 0.0) if result["path_valid"] else 0.0

        self._maybe_capture(color_bgr, edges, result)

        return {
            "message_type": "path_detection",
            "x_angle_deg": round(x_angle_deg, 2),
            "confidence": round(confidence, 3),
            "timestamp": int(time.time() * 1000),
        }

    def _maybe_capture(self, color_bgr, edges, result):
        if not (self.display_enabled or self.display_capture_enabled):
            return
        try:
            import cv2
        except Exception:
            return

        # component_map is ConcreteEdgeDetector's own "selected sidewalk" overlay
        # (yellow, per follow_the_yellow_brick_road.js) -- draw CarrotVision's
        # centerline/arrow on top of that instead of the plain camera frame, so
        # one view shows both the detected sidewalk and the steering carrot.
        sidewalk_frame = (edges.get("debug") or {}).get("component_map", color_bgr)
        annotated = self.carrot.draw_debug(sidewalk_frame, result)

        if self.display_enabled:
            try:
                cv2.imshow("Noah Vision", annotated)
                cv2.waitKey(1)
            except Exception:
                self.display_enabled = False  # headless box -- stop retrying every frame

        if self.display_capture_enabled:
            now = time.time()
            if now - self._last_capture_ts >= self.display_capture_interval_s:
                self._last_capture_ts = now
                try:
                    os.makedirs(self.display_capture_dir, exist_ok=True)
                    frames = sorted(f for f in os.listdir(self.display_capture_dir) if f.endswith(".jpg"))
                    if len(frames) >= self.display_capture_max_frames:
                        os.remove(os.path.join(self.display_capture_dir, frames[0]))
                    cv2.imwrite(os.path.join(self.display_capture_dir, "frame_%d.jpg" % int(now * 1000)), annotated)
                except Exception:
                    pass

    def run(self):
        try:
            self.start()
            while self.running:
                frames = self.pipeline.wait_for_frames(8000)
                if not self.should_process_frame():
                    continue
                detection = self.process_frames(frames)
                if detection is not None:
                    emit(detection)
        finally:
            if self.pipeline is not None and self.pipeline_started:
                self.pipeline.stop()


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
                if math.isfinite(val):
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

    # stdin hit EOF -- the parent (Node) closed the pipe, i.e. it exited or
    # crashed. Stop so run() unwinds and releases the camera instead of
    # orphaning this process and holding the RealSense open.
    vision.stop()


def main():
    config = parse_config()
    vision = SidewalkVision(config)
    listener = threading.Thread(target=stdin_listener, args=(vision,), daemon=True)
    listener.start()
    vision.run()


if __name__ == "__main__":
    main()
