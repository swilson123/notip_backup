"""Manual, hardware-in-the-loop viewer for the navigation path -- staging
point, ramp entrance, and ramp centerline up to the top center.

Intended usage::

    python scripts/test_ramp_geometry.py
    python scripts/test_ramp_geometry.py \\
        --camera-config config/camera.yaml --tags-config config/tags.yaml \\
        --ramp-config config/ramp_prototype.yaml --staging-config config/staging.yaml \\
        --approach-path-config config/approach_path.yaml

Controls::

    Q / ESC = quit
    D       = toggle detailed AprilTag/pose debug overlays (default: OFF)
    H       = toggle the compact navigation HUD/legend text (default: ON)

Runs the full camera -> detection -> per-tag pose pipeline (exactly like
`scripts/test_apriltag_pose.py`), then passes the resulting `TagPose`
list through `vision_docking.tag_tracking`'s temporal hold layer
(`TagPoseTracker`) before handing the *temporally-resolved* pose set to
two entirely independent consumers:

    * `vision_docking.tag_fusion`'s **three-tag centerline model**
      (`ThreeTagRampEstimator`) reconstructs the ramp's entrance center
      (tag 0), middle center (tag 1), and top center (tag 2), plus the
      centerline through them, deployed length, heading, and pitch.
    * `vision_docking.guidance`'s `GuidanceTargetGenerator` computes a
      virtual staging point -- `EXACT` from ids 0+2 directly, or
      `PROVISIONAL` from a two-tag or single-tag fallback when both
      aren't visible -- plus the raw, unfiltered `target_bearing_deg`
      from the camera/rover's current position to that point.

**Temporal tag-pose hold layer:** real detections sometimes flicker
frame-to-frame for a physically stationary tag (the middle/top tags
especially, being farther from the camera) -- without smoothing this
out, a 1-2 frame dropout looks identical to "the tag actually left
view" to both consumers above. `TagPoseTracker.update()` tracks each
configured ramp tag ID's own `LIVE`/`HELD`/`LOST` state every frame
(`config/tag_tracking.yaml`'s `hold_timeout_s`); `resolved_poses()`
turns that into the `LIVE`+`HELD` pose list actually passed to
`ThreeTagRampEstimator`/`GuidanceTargetGenerator` above, while the
frame's raw, unfiltered `poses` remains available separately for debug
rendering (`draw_tag_poses()`) exactly as before. See
`vision_docking.tag_tracking`'s module docstring for the full state
machine -- this layer never touches ramp/staging/pose geometry itself,
only *which poses* reach it each frame.

**Default (clean) view:** `vision_docking.visualization`'s
`build_navigation_path()` builds one `NavigationPath` per frame --
**the single authoritative source** for the rover/staging/entrance/top
points, the sampled ROVER -> STAGING approach curve, and the debug
lookahead point -- passed to every renderer below, none of which ever
recomputes a point of its own. `draw_navigation_path()` draws its
**three independently-owned segments**, in mandatory order: the
flexible rover approach (rover -> ... -> staging, a cubic Bezier curve,
dashed white -- the *only* segment that changes shape as the camera
moves), the fixed staging alignment (staging -> entrance, yellow), and
the fixed ramp centerline (entrance -> top, green) -- plus small
direction arrows on each, making the ROVER -> STAGING -> ENTRANCE -> TOP
order visually obvious; there is no direct rover -> entrance shortcut
anywhere. The flexible segment's own arrow is anchored exactly at the
rover and points exactly along `visualization.py`'s `desired_path_
direction()` -- the white curve's own tangent leaving the rover, the
single authoritative source for "which way should the rover currently
point" (never an independently-computed bearing to staging/entrance,
never `target_bearing_deg`/`approach_heading_deg`, never tag yaw/pitch)
-- so this arrow can never visually disagree with the curve it's drawn
on. `draw_navigation_landmarks()` marks ROVER/STAGING/LOOKAHEAD/
ENTRANCE/TOP. See `visualization.py`'s "Navigation HUD" section for
exactly which fields define each point, why the rover's position has
zero influence on the two fixed segments, and why STAGING is always the
mandatory first target. `draw_navigation_hud()` draws a compact, semi-
transparent top-left panel (target quality/source tags/confidence/
bearing/heading/staging-direction-source/active-path-section/approach-
curve/desired-travel-direction diagnostics) in place of the old, much
larger overlapping per-tag/ramp/guidance text blocks, `draw_navigation_
legend()` adds a small color key, and `draw_top_down_guidance_inset()`
adds a small schematic top-down corner view (same `NavigationPath`,
same curve, same rover-direction arrow). `draw_tag_detections()` still
draws every tag's outline/ID/margin -- lightweight, not "debug."

**Debug view (`D`):** adds `draw_tag_poses()` (full per-tag axis triad +
raw pose/translation/Euler/margin/error text), `draw_ramp_estimate()`
(the ramp's own diagnostic text block and landmark markers), and
`draw_guidance_target()` (the older, more verbose guidance overlay) --
exactly the detailed diagnostics this milestone moved out of the default
view, still available on demand. `draw_tag_tracking_status()` (per-tag
`LIVE`/`HELD`/`LOST` text + a solid/hollow marker at each tag's current
position) is drawn in **both** views, top-right, since it's small and
useful regardless of debug mode.

**RAMP mode:** once the rover has been confirmed to have driven past
the physical entrance tag (id 0) for several consecutive frames --
`vision_docking.visualization`'s `advance_path_progress()`, called once
per frame with a `PathProgressState` this script keeps alive across the
whole run -- `PathSection.RAMP` becomes (and, for the rest of this run,
stays) the active path section. From that point on, `desired_path_
direction()` (and therefore the rover-direction arrow, the top-down
inset's arrow, and the `DESIRED TRAVEL DIRECTION` HUD line) reads
`NavigationPath.ramp_travel_heading_deg` -- `GuidanceTarget.approach_
heading_deg`, i.e. the same ids-0+2/two-tag/single-tag-calibrated-
orientation hierarchy `guidance.py` already uses for staging, now also
serving as "which way does the ramp centerline point right now" once
staging is behind us -- **not** a recomputed entrance/top vector, and
**never** a bearing back toward staging or entrance. `draw_navigation_
path()`/`draw_top_down_guidance_inset()` stop drawing the white approach
curve and the yellow staging segment once RAMP is active (neither
represents where the rover is supposed to be heading anymore) and draw
the green ramp segment slightly thicker instead. See `PathSection`'s and
`advance_path_progress()`'s docstrings for the full debounce/stickiness
rationale (a single-frame id-0 dropout/flicker must never trigger this,
and once entered, losing id 0 entirely afterward -- expected, once the
rover has passed it -- must never undo it).

This script exists specifically to give a clear, immediate visual of
**the geometric path the rover would eventually follow** -- not to
validate ramp calibration numerically (that's what debug mode and the
unit tests are for) and not to steer anything: `target_bearing_deg` is
deliberately raw here -- no smoothing, no rate limiting, no PID/Pure-
Pursuit/Stanley, no wheel-angle conversion, no rover command of any
kind, in either view.

**Until `config/ramp_prototype.yaml`'s `nominal_entrance_to_top_
horizontal_m` is measured for your physical ramp, any fallback case
that needs it (tag 0 or tag 2 alone, tag 1 alone) simply won't produce
an estimate** -- see that file for the exact placeholder value
currently in use. Likewise, `config/staging.yaml`'s `camera_to_ground.camera_height_m`
starts at `null` -- until it's measured, every `GuidanceTarget` here
will report invalid, and the navigation path is correctly not drawn at
all (see `draw_navigation_path()`'s docstring: no path is fabricated).

Not part of the automated test suite -- see `tests/test_tag_fusion.py`,
`tests/test_guidance.py`, and `tests/test_visualization.py` for the
hardware-independent unit tests (synthetic transforms, no camera/pose
backend required) that run in CI.

Does not save recordings, snapshots, CSV export, or issue any rover
command; that is all future work.
"""
from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path

import cv2

from vision_docking.camera import CameraError, RealSenseCamera, RealSenseUnavailableError
from vision_docking.config import (
    ApproachPathConfig,
    RampPrototypeConfig,
    StagingConfig,
    TagTrackingConfig,
    load_approach_path_config,
    load_camera_config,
    load_ramp_prototype_config,
    load_staging_config,
    load_tag_tracking_config,
    load_tags_config,
)
from vision_docking.detector import AprilTagDetector, AprilTagUnavailableError, TagDetectorError
from vision_docking.guidance import (
    GroundPlane,
    GuidanceTargetGenerator,
    ProvisionalCalibration,
    RampTagMount,
    StagingCalibration,
)
from vision_docking.pose import PoseBackendUnavailableError, PoseEstimationError, TagPoseEstimator
from vision_docking.tag_fusion import RampGeometryError, ThreeTagRampConfig, ThreeTagRampEstimator
from vision_docking.tag_tracking import TagHoldConfig, TagPoseTracker, resolved_poses
from vision_docking.visualization import (
    ApproachPathParams,
    PathProgressState,
    advance_path_progress,
    build_navigation_path,
    draw_guidance_target,
    draw_navigation_hud,
    draw_navigation_landmarks,
    draw_navigation_legend,
    draw_navigation_path,
    draw_ramp_estimate,
    draw_tag_detections,
    draw_tag_poses,
    draw_tag_tracking_status,
    draw_target_bearing,
    draw_top_down_guidance_inset,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

WINDOW_NAME = "vision-docking: navigation path viewer"
KEY_ESCAPE = 27
KEYS_TOGGLE_DEBUG = (ord("d"), ord("D"))
KEYS_TOGGLE_HUD = (ord("h"), ord("H"))
UNKNOWN_TAG_COLOR_BGR = (0, 165, 255)
CONTROLS_TEXT_COLOR_BGR = (200, 200, 200)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Live dynamic ramp geometry + staging point viewer"
    )
    parser.add_argument(
        "--camera-config", type=Path, default=Path("config/camera.yaml"),
        help="Path to camera.yaml (default: config/camera.yaml)",
    )
    parser.add_argument(
        "--tags-config", type=Path, default=Path("config/tags.yaml"),
        help="Path to tags.yaml (default: config/tags.yaml)",
    )
    parser.add_argument(
        "--ramp-config", type=Path, default=Path("config/ramp_prototype.yaml"),
        help="Path to ramp_prototype.yaml (default: config/ramp_prototype.yaml)",
    )
    parser.add_argument(
        "--staging-config", type=Path, default=Path("config/staging.yaml"),
        help="Path to staging.yaml (default: config/staging.yaml)",
    )
    parser.add_argument(
        "--approach-path-config", type=Path, default=Path("config/approach_path.yaml"),
        help="Path to approach_path.yaml (default: config/approach_path.yaml)",
    )
    parser.add_argument(
        "--tag-tracking-config", type=Path, default=Path("config/tag_tracking.yaml"),
        help="Path to tag_tracking.yaml (default: config/tag_tracking.yaml)",
    )
    return parser.parse_args()


def build_three_tag_estimator(ramp_config: RampPrototypeConfig) -> ThreeTagRampEstimator:
    """Convert a loaded `RampPrototypeConfig` into `tag_fusion.py`'s own
    plain constructor arguments -- `ThreeTagRampEstimator` never imports
    `config.py` itself (no-sibling-imports rule), so this conversion is
    the caller's job, exactly like it already is for
    `AprilTagDetector`/`TagPoseEstimator`/`RealSenseCamera`/`TagFusion`."""
    config = ThreeTagRampConfig(
        ramp_width_m=ramp_config.ramp_width_m,
        entrance_offset_m=ramp_config.entrance_offset_m,
        top_offset_m=ramp_config.top_offset_m,
        nominal_entrance_to_top_horizontal_m=ramp_config.nominal_entrance_to_top_horizontal_m,
    )
    return ThreeTagRampEstimator(config)


def build_staging_calibration(staging_config: StagingConfig) -> StagingCalibration:
    """Convert a loaded `StagingConfig` into `guidance.py`'s own plain
    constructor arguments -- `StagingCalibration` never imports
    `config.py` itself (no-sibling-imports rule), so this conversion is
    the caller's job, exactly as above for the ramp models."""
    tags = {
        tag_id: RampTagMount(mount_heading_offset_deg=mount.mount_heading_offset_deg)
        for tag_id, mount in staging_config.tags.items()
    }
    return StagingCalibration(
        staging_distance_m=staging_config.staging_distance_m,
        tags=tags,
        ground_plane=GroundPlane(camera_height_m=staging_config.camera_to_ground.camera_height_m),
        provisional=ProvisionalCalibration(
            nominal_entrance_to_top_horizontal_m=(
                staging_config.provisional.nominal_entrance_to_top_horizontal_m
            )
        ),
    )


def build_tag_pose_tracker(
    tag_ids: tuple[int, ...], tag_tracking_config: TagTrackingConfig
) -> TagPoseTracker:
    """Convert a loaded `TagTrackingConfig` into `tag_tracking.py`'s own
    plain constructor arguments -- `TagPoseTracker` never imports
    `config.py` itself (no-sibling-imports rule), so this conversion is
    the caller's job, exactly as above for the ramp/staging models.
    *tag_ids* is the configured ramp-centerline tag IDs to track (see
    `config/tags.yaml`'s `known_tags`)."""
    return TagPoseTracker(
        tag_ids=tag_ids,
        config=TagHoldConfig(hold_timeout_s=tag_tracking_config.hold_timeout_s),
    )


def build_approach_path_params(approach_path_config: ApproachPathConfig) -> ApproachPathParams:
    """Convert a loaded `ApproachPathConfig` into `visualization.py`'s
    own plain constructor arguments -- `ApproachPathParams` never
    imports `config.py` itself (no-sibling-imports rule), so this
    conversion is the caller's job, exactly as above for the ramp/
    staging models."""
    return ApproachPathParams(
        handle_fraction=approach_path_config.handle_fraction,
        min_handle_m=approach_path_config.min_handle_m,
        max_handle_m=approach_path_config.max_handle_m,
        sample_count=approach_path_config.sample_count,
        lookahead_m=approach_path_config.lookahead_m,
    )


def main() -> None:
    args = parse_args()

    try:
        camera_config = load_camera_config(args.camera_config)
        tags_config = load_tags_config(args.tags_config)
        ramp_config = load_ramp_prototype_config(args.ramp_config)
        staging_config = load_staging_config(args.staging_config)
        approach_path_config = load_approach_path_config(args.approach_path_config)
        tag_tracking_config = load_tag_tracking_config(args.tag_tracking_config)
    except (OSError, ValueError) as exc:
        logger.error("Invalid configuration: %s", exc)
        return

    roles = {kt.tag_id: kt.role for kt in tags_config.known_tags}
    tag_sizes_m = {kt.tag_id: kt.pose_tag_size_m for kt in tags_config.known_tags}
    estimator = build_three_tag_estimator(ramp_config)
    guidance_generator = GuidanceTargetGenerator(build_staging_calibration(staging_config))
    approach_path_params = build_approach_path_params(approach_path_config)
    tag_tracker = build_tag_pose_tracker(
        tuple(kt.tag_id for kt in tags_config.known_tags), tag_tracking_config
    )

    camera = RealSenseCamera(
        width=camera_config.width,
        height=camera_config.height,
        fps=camera_config.fps,
        serial_number=camera_config.serial_number,
        enable_depth=camera_config.enable_depth,
        auto_exposure=camera_config.auto_exposure,
        manual_exposure=camera_config.manual_exposure,
        intrinsics_file=camera_config.intrinsics_file,
        frame_timeout_ms=camera_config.frame_timeout_ms,
    )
    detector = AprilTagDetector(
        family=tags_config.family,
        quad_decimate=tags_config.detector.quad_decimate,
        quad_sigma=tags_config.detector.quad_sigma,
        nthreads=tags_config.detector.nthreads,
        min_decision_margin=tags_config.detector.min_decision_margin,
        refine_edges=tags_config.detector.refine_edges,
        decode_sharpening=tags_config.detector.decode_sharpening,
        debug=tags_config.detector.debug,
    )
    pose_estimator = TagPoseEstimator(
        family=tags_config.family,
        tag_sizes_m=tag_sizes_m,
        quad_decimate=tags_config.detector.quad_decimate,
        quad_sigma=tags_config.detector.quad_sigma,
        nthreads=tags_config.detector.nthreads,
        refine_edges=tags_config.detector.refine_edges,
        decode_sharpening=tags_config.detector.decode_sharpening,
        debug=tags_config.detector.debug,
    )

    try:
        camera.open()
    except RealSenseUnavailableError as exc:
        logger.error("pyrealsense2 is not installed: %s", exc)
        return
    except CameraError as exc:
        logger.error("Could not start the RealSense camera: %s", exc)
        return

    try:
        intrinsics = camera.get_intrinsics()
        logger.info(
            "Active intrinsics: fx=%.2f fy=%.2f cx=%.2f cy=%.2f (%dx%d)",
            intrinsics.fx, intrinsics.fy, intrinsics.cx, intrinsics.cy,
            intrinsics.width, intrinsics.height,
        )

        cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_AUTOSIZE)
        last_fps_time = time.monotonic()
        frame_count = 0
        display_fps = 0.0
        debug = False
        show_hud = True
        path_progress = PathProgressState()

        while True:
            frame_bgr, timestamp = camera.read()
            frame_gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)

            try:
                detections = detector.detect(frame_gray, timestamp)
            except AprilTagUnavailableError as exc:
                logger.error("pupil-apriltags is not installed: %s", exc)
                return
            except TagDetectorError as exc:
                logger.error("AprilTag detection failed: %s", exc)
                return

            try:
                poses = pose_estimator.estimate(frame_gray, detections, intrinsics)
            except PoseBackendUnavailableError as exc:
                logger.error("pupil-apriltags is not installed: %s", exc)
                return
            except PoseEstimationError as exc:
                logger.error("Pose estimation failed: %s", exc)
                return

            tracked_tags = tag_tracker.update(poses, timestamp)
            resolved = resolved_poses(tracked_tags)

            try:
                ramp_estimate = estimator.fuse(resolved, timestamp)
            except RampGeometryError as exc:
                logger.error("Ramp geometry reconstruction failed: %s", exc)
                return

            guidance_target = guidance_generator.generate(resolved, timestamp)
            path_progress = advance_path_progress(path_progress, guidance_target)
            navigation_path = build_navigation_path(
                guidance_target, ramp_estimate, approach_path_params, progress=path_progress
            )

            posed_ids = {pose.tag_id for pose in poses}
            unknown_detections = [d for d in detections if d.tag_id not in posed_ids]

            frame_count += 1
            now = time.monotonic()
            elapsed = now - last_fps_time
            if elapsed >= 0.5:
                display_fps = frame_count / elapsed
                frame_count = 0
                last_fps_time = now

            if debug:
                annotated = draw_tag_detections(frame_bgr, unknown_detections)
                annotated = draw_tag_poses(
                    annotated, poses, intrinsics, roles=roles, tag_sizes_m=tag_sizes_m
                )
                annotated = draw_ramp_estimate(annotated, ramp_estimate, intrinsics)
                annotated = draw_guidance_target(annotated, guidance_target, poses, intrinsics)
                annotated = draw_target_bearing(annotated, guidance_target)
            else:
                # Every tag's outline/ID/margin is lightweight enough to
                # always show -- only the detailed per-tag pose text,
                # raw ramp diagnostics, and the older verbose guidance
                # overlay are gated behind debug mode.
                annotated = draw_tag_detections(frame_bgr, detections)
                annotated = draw_navigation_path(annotated, navigation_path, intrinsics)
                annotated = draw_navigation_landmarks(
                    annotated, navigation_path, ramp_estimate, intrinsics
                )
                annotated = draw_top_down_guidance_inset(annotated, navigation_path)
                # No draw_target_bearing() call here anymore -- its
                # compass arrow was independently bearing-based (straight
                # to GuidanceTarget.target_point_camera_m) and could point
                # somewhere different from the white approach curve.
                # draw_navigation_path()'s own rover-direction arrow (from
                # desired_path_direction()) replaces it; still available
                # in debug mode below as a raw diagnostic.
                if show_hud:
                    annotated = draw_navigation_hud(
                        annotated, guidance_target, ramp_estimate, navigation_path
                    )
                    annotated = draw_navigation_legend(annotated)

            # Shown in both views -- small, and useful regardless of debug
            # mode; top-right so it never collides with the top-left HUD
            # panel or the bottom status bar.
            annotated = draw_tag_tracking_status(
                annotated, tracked_tags, intrinsics,
                origin=(annotated.shape[1] - 160, 30),
            )

            cv2.putText(
                annotated,
                f"{intrinsics.width}x{intrinsics.height} @ {display_fps:.1f} fps  "
                f"tags={len(detections)} posed={len(poses)}",
                (10, annotated.shape[0] - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2,
            )
            cv2.putText(
                annotated,
                f"[D]ebug: {'ON' if debug else 'off'}   [H]UD: {'ON' if show_hud else 'off'}   "
                "Q/ESC: quit",
                (10, annotated.shape[0] - 40 - 20 * len(unknown_detections)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, CONTROLS_TEXT_COLOR_BGR, 1,
            )
            for i, detection in enumerate(unknown_detections):
                cv2.putText(
                    annotated,
                    f"id={detection.tag_id}: pose skipped (unknown physical size)",
                    (10, annotated.shape[0] - 40 - 20 * i),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, UNKNOWN_TAG_COLOR_BGR, 1,
                )

            cv2.imshow(WINDOW_NAME, annotated)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), KEY_ESCAPE):
                break
            if key in KEYS_TOGGLE_DEBUG:
                debug = not debug
            elif key in KEYS_TOGGLE_HUD:
                show_hud = not show_hud
    except CameraError as exc:
        logger.error("Camera error during streaming: %s", exc)
    finally:
        camera.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
