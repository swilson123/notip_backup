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


def _x_display_available():
    display = os.environ.get("DISPLAY")
    if not display:
        return False
    # DISPLAY=":N" or "host:N" -> the server's Unix socket is /tmp/.X11-unix/XN
    socket_num = display.rsplit(":", 1)[-1].split(".")[0]
    return os.path.exists("/tmp/.X11-unix/X" + socket_num)


class SidewalkVision:
    WINDOW_NAME = "Noah Vision"

    def __init__(self, config):
        self.config = config or {}
        self.running = True
        self.pipeline = None
        self.pipeline_started = False
        self.align = None

        self.fps_target = int(self.config.get("fps_normal", 6))
        self.last_processed_at = 0.0

        # ConcreteEdgeDetector's confidence is a fresh per-frame material-segmentation
        # score with no temporal smoothing of its own (unlike carrot x, which already
        # gets CarrotVision's EMA + hold). A single bad frame -- e.g. one frame of
        # shadow across the sidewalk -- swings it from ~0.9 to 0.0 and back the very
        # next frame, and follow_the_yellow_brick_road.js feeds confidence straight
        # into motor_speed_cmd, so that one-frame dip became a full-stop motor spike.
        # Same EMA treatment as carrot_ema_alpha, applied here since confidence has no
        # other smoothing owner.
        self.confidence_ema_alpha = float(self.config.get("confidence_ema_alpha", 0.25))
        self._confidence_smooth = None

        # Static camera mount tilt -- positive config value means the camera is
        # pitched forward/nose-down, the opposite sign of the nose-up-positive
        # body-pitch convention, so it's subtracted the same way the old
        # realsense_vision.py did.
        self.mount_pitch_rad = math.radians(float(self.config.get("camera_mount_pitch_deg", 0.0)))
        self.current_pitch_rad = -self.mount_pitch_rad
        self.current_roll_rad = 0.0
        self.current_heading_deg = None

        # cv2.imshow's Qt/xcb backend calls qFatal() and aborts the whole process
        # (not a catchable Python exception) when no X display is reachable --
        # under systemd at boot there's no DISPLAY, so this crashed the vision
        # subprocess on every frame attempt, forever (5s respawn loop in
        # connect_to_realsense.js), and it never stabilized until someone
        # manually ran the script from an X-enabled SSH/desktop session.
        # Checking the DISPLAY env var alone isn't enough once notip.service sets
        # it explicitly (see notip.service) -- if the desktop session (lightdm/
        # labwc + XWayland) hasn't come up yet when this subprocess spawns, the
        # var would be set but nothing would be listening, and cv2.imshow would
        # still qFatal(). Confirm the X11 socket itself exists first.
        self.display_enabled = bool(self.config.get("display_enabled", False)) and _x_display_available()
        # window chrome is drawn by hand (see _draw_window_controls) because a
        # fullscreen cv2/Qt HighGUI window has no title bar of its own to put
        # close/minimize/resize buttons on.
        self._window_ready = False
        self._window_state = "fullscreen"
        self._btn_rects = {}
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

        raw_confidence = edges.get("confidence", 0.0) if result["path_valid"] else 0.0
        if self._confidence_smooth is None:
            self._confidence_smooth = raw_confidence
        else:
            self._confidence_smooth = (
                self.confidence_ema_alpha * raw_confidence
                + (1.0 - self.confidence_ema_alpha) * self._confidence_smooth
            )
        confidence = self._confidence_smooth

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
                self._ensure_window(cv2)
                display_frame = annotated.copy() if self.display_capture_enabled else annotated
                self._draw_window_controls(cv2, display_frame)
                cv2.imshow(self.WINDOW_NAME, display_frame)
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

    def _ensure_window(self, cv2):
        if self._window_ready:
            return
        cv2.namedWindow(self.WINDOW_NAME, cv2.WINDOW_NORMAL)
        cv2.setWindowProperty(self.WINDOW_NAME, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)
        cv2.setMouseCallback(self.WINDOW_NAME, self._on_mouse)
        self._window_state = "fullscreen"
        self._window_ready = True

    # Fullscreen strips the window manager's own title bar, so there is nowhere
    # to put real close/minimize/resize buttons -- draw them into the corner of
    # the frame itself and hit-test clicks against the same rects in _on_mouse.
    def _draw_window_controls(self, cv2, frame):
        h, w = frame.shape[:2]
        margin, size, gap = 10, 32, 8
        y1, y2 = margin, margin + size
        close_x1, close_x2 = w - margin - size, w - margin
        resize_x1, resize_x2 = close_x1 - gap - size, close_x1 - gap
        min_x1, min_x2 = resize_x1 - gap - size, resize_x1 - gap

        self._btn_rects = {
            "minimize": (min_x1, y1, min_x2, y2),
            "resize":   (resize_x1, y1, resize_x2, y2),
            "close":    (close_x1, y1, close_x2, y2),
        }

        for name, (x1, ry1, x2, ry2) in self._btn_rects.items():
            cv2.rectangle(frame, (x1, ry1), (x2, ry2), (50, 50, 50), -1)
            cv2.rectangle(frame, (x1, ry1), (x2, ry2), (180, 180, 180), 1)
            if name == "close":
                cv2.line(frame, (x1 + 8, ry1 + 8), (x2 - 8, ry2 - 8), (220, 220, 220), 2)
                cv2.line(frame, (x2 - 8, ry1 + 8), (x1 + 8, ry2 - 8), (220, 220, 220), 2)
            elif name == "resize":
                cv2.rectangle(frame, (x1 + 7, ry1 + 7), (x2 - 7, ry2 - 7), (220, 220, 220), 2)
            elif name == "minimize":
                cv2.line(frame, (x1 + 7, ry2 - 9), (x2 - 7, ry2 - 9), (220, 220, 220), 2)

    def _on_mouse(self, event, x, y, flags, param):
        import cv2
        if event != cv2.EVENT_LBUTTONDOWN:
            return
        for name, (x1, ry1, x2, ry2) in self._btn_rects.items():
            if x1 <= x <= x2 and ry1 <= y <= ry2:
                self._handle_window_button(cv2, name)
                return

    def _handle_window_button(self, cv2, name):
        if name == "close":
            try:
                cv2.destroyWindow(self.WINDOW_NAME)
            except Exception:
                pass
            self.display_enabled = False
            self._window_ready = False
        elif name == "minimize":
            cv2.setWindowProperty(self.WINDOW_NAME, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_NORMAL)
            cv2.resizeWindow(self.WINDOW_NAME, 240, 135)
            self._window_state = "minimized"
        elif name == "resize":
            if self._window_state == "fullscreen":
                cv2.setWindowProperty(self.WINDOW_NAME, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_NORMAL)
                cv2.resizeWindow(self.WINDOW_NAME, 960, 540)
                self._window_state = "normal"
            else:
                cv2.setWindowProperty(self.WINDOW_NAME, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)
                self._window_state = "fullscreen"

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
