"""Minimal integration example for the vision-docking package.

This is the smallest realistic call into `vision_docking.pipeline.
VisionDockingPipeline` -- read one frame, get one `DockingResult`, print
the field your controller should consume. It issues **no motor/servo/
Pixhawk commands** -- see the "WHERE YOUR CONTROLLER GOES" comment below
for exactly where that would plug in, and `INTEGRATION.md` for why this
package deliberately stops short of that.

Two frame sources are supported, selected with --mode:

    --mode synthetic   (default) Feeds a single blank in-memory frame
                        through the pipeline once. No camera hardware,
                        no pyrealsense2, needed. This proves the
                        import/config/detector wiring is correct end to
                        end -- with no tags in a blank frame, the
                        expected, CORRECT result is `valid=False` with
                        an explicit reason, not a crash. Still requires
                        `pupil-apriltags` to be installed and working
                        (it is what `AprilTagDetector`/`TagPoseEstimator`
                        actually run against), since this example does
                        not fake or mock that dependency -- if it is not
                        installed, you'll see an actionable
                        `AprilTagUnavailableError`, not a silent skip.

    --mode realsense    Uses this package's own `vision_docking.camera.
                        RealSenseCamera` to open a physical Intel
                        RealSense D435i/D435iF and stream real frames.
                        Requires `pyrealsense2` installed and a camera
                        connected. Only relevant if you *don't* already
                        have your own RealSense integration -- see
                        "PATTERN A" vs "PATTERN B" below.

Usage::

    python examples/integration_example.py
    python examples/integration_example.py --mode realsense
    python examples/integration_example.py --config-dir /path/to/config
"""
from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path

import numpy as np

from vision_docking.models import CameraIntrinsics
from vision_docking.pipeline import DockingResult, VisionDockingPipeline

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DEFAULT_CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config-dir", type=Path, default=DEFAULT_CONFIG_DIR,
        help=f"Directory containing tags.yaml/staging.yaml/... (default: {DEFAULT_CONFIG_DIR})",
    )
    parser.add_argument(
        "--mode", choices=("synthetic", "realsense"), default="synthetic",
        help="Frame source: a single blank in-memory frame (no hardware needed), "
             "or this package's own RealSenseCamera (needs pyrealsense2 + hardware).",
    )
    parser.add_argument(
        "--frames", type=int, default=1,
        help="How many frames to process (default: 1). Only meaningful with "
             "--mode realsense, or to exercise the tag-tracking hold layer "
             "across repeated synthetic frames.",
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# PATTERN A -- the rover already owns RealSense acquisition
# ---------------------------------------------------------------------------
#
# This is almost certainly what you want. Nothing in this package needs to
# own the camera -- VisionDockingPipeline.process_frame() only needs a BGR
# frame and a CameraIntrinsics describing it. Wherever your existing camera
# code produces those two things, feed them straight in:
#
#     from vision_docking.models import CameraIntrinsics
#     from vision_docking.pipeline import VisionDockingPipeline
#
#     docking = VisionDockingPipeline.from_config_dir("path/to/vision_docking/config")
#
#     while running:
#         frame_bgr = your_rover_camera.read()          # however you already do this
#         rs_intrinsics = your_rover_camera.get_intrinsics()  # your camera's own object
#
#         # Map YOUR intrinsics object into this package's plain CameraIntrinsics.
#         # If you're also using pyrealsense2 directly, this is the same mapping
#         # vision_docking.camera.RealSenseCamera does internally -- see
#         # INTEGRATION.md, "Camera coordinate assumptions" for the exact fields.
#         intrinsics = CameraIntrinsics(
#             fx=rs_intrinsics.fx, fy=rs_intrinsics.fy,
#             cx=rs_intrinsics.ppx, cy=rs_intrinsics.ppy,
#             width=rs_intrinsics.width, height=rs_intrinsics.height,
#             distortion=tuple(rs_intrinsics.coeffs),
#         )
#
#         result = docking.process_frame(frame_bgr, intrinsics)
#         handle_result(result)  # see below -- never issues a command itself
#
# ---------------------------------------------------------------------------
# PATTERN B -- this package owns RealSense acquisition (only if you don't
# already have your own camera integration)
# ---------------------------------------------------------------------------


def read_synthetic_frame(intrinsics: CameraIntrinsics) -> tuple[np.ndarray, float]:
    """Return one blank BGR frame + a monotonic timestamp -- stands in for
    real hardware so this example (and your first smoke test of the
    package) runs with zero camera dependencies. A blank frame contains
    no AprilTags, so the CORRECT, expected `DockingResult` from it is
    `valid=False` with an explicit reason -- see `handle_result()`."""
    frame_bgr = np.zeros((intrinsics.height, intrinsics.width, 3), dtype=np.uint8)
    return frame_bgr, time.monotonic()


def build_realsense_camera() -> object:
    """Construct this package's own `RealSenseCamera` from `config/
    camera.yaml` -- only relevant if you are NOT already using the
    rover's existing RealSense integration (see "PATTERN A" above,
    which is almost certainly what you want instead)."""
    from vision_docking.camera import RealSenseCamera
    from vision_docking.config import load_camera_config

    camera_config = load_camera_config(DEFAULT_CONFIG_DIR / "camera.yaml")
    camera = RealSenseCamera(
        width=camera_config.width,
        height=camera_config.height,
        fps=camera_config.fps,
        serial_number=camera_config.serial_number,
        enable_depth=camera_config.enable_depth,
        auto_exposure=camera_config.auto_exposure,
        manual_exposure=camera_config.manual_exposure,
        frame_timeout_ms=camera_config.frame_timeout_ms,
    )
    camera.open()
    return camera


# ---------------------------------------------------------------------------
# The result -- this is everything the rest of your rover code needs to know
# ---------------------------------------------------------------------------


def handle_result(result: DockingResult) -> None:
    """Log the current `DockingResult` and show exactly where a real
    controller would take over. **Never issues a motor/servo/Pixhawk
    command** -- this package outputs perception/guidance information
    only; converting `desired_travel_direction_deg` into an actuation
    command is the rover repository's job, not this package's (see
    `INTEGRATION.md`, "What this package does NOT do")."""
    if not result.valid:
        logger.info("No usable guidance this frame: %s", result.reason)
        return

    logger.info(
        "quality=%s geometry=%s section=%s next=%s tags(live=%s held=%s lost=%s)",
        result.quality,
        result.geometry_quality,
        result.active_path_section,
        result.next_mandatory_waypoint,
        result.live_tag_ids,
        result.held_tag_ids,
        result.lost_tag_ids,
    )

    if result.desired_travel_direction_deg is not None:
        # ---------------------------------------------------------------
        # WHERE YOUR CONTROLLER GOES
        # ---------------------------------------------------------------
        # result.desired_travel_direction_deg is a signed horizontal
        # correction angle relative to the camera's own forward axis:
        #   0.0      -> already pointed the right way
        #   positive -> the path currently wants the rover to turn RIGHT
        #   negative -> the path currently wants the rover to turn LEFT
        # It is NOT a wheel angle, a PWM value, or a Pixhawk RC-override
        # command -- this package never performs that conversion (see
        # INTEGRATION.md). Your rover's steering/velocity controller
        # reads this number and decides what to actually do with it,
        # e.g.:
        #
        #     your_rover_controller.steer_toward(result.desired_travel_direction_deg)
        #
        # This example only prints it.
        print(f"DESIRED TRAVEL DIRECTION: {result.desired_travel_direction_deg:+.1f} deg")
    else:
        logger.info("Guidance is valid but no direction is available this frame.")


def main() -> None:
    args = parse_args()

    docking = VisionDockingPipeline.from_config_dir(args.config_dir)

    # A fixed example intrinsics, used only for --mode synthetic (where
    # there is no real camera to query). --mode realsense ignores this
    # entirely and uses the camera's own *active* stream intrinsics
    # instead -- see INTEGRATION.md, "Hardware assumptions", for why you
    # must never hard-code intrinsics for real operation.
    example_intrinsics = CameraIntrinsics(
        fx=920.0, fy=920.0, cx=640.0, cy=360.0, width=1280, height=720
    )

    camera = None
    try:
        if args.mode == "realsense":
            camera = build_realsense_camera()

        for i in range(args.frames):
            if args.mode == "realsense":
                assert camera is not None
                frame_bgr, timestamp = camera.read()
                intrinsics = camera.get_intrinsics()
            else:
                frame_bgr, timestamp = read_synthetic_frame(example_intrinsics)
                intrinsics = example_intrinsics

            result = docking.process_frame(frame_bgr, intrinsics, timestamp=timestamp)
            logger.info("frame %d/%d:", i + 1, args.frames)
            handle_result(result)
    finally:
        if camera is not None:
            camera.close()


if __name__ == "__main__":
    main()
