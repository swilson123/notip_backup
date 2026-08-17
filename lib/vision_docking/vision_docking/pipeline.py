"""Integration facade for the vision-docking pipeline.

    frame_bgr + CameraIntrinsics
        -> AprilTag detection      (detector.py)
        -> per-tag pose estimation (pose.py)
        -> temporal pose hold      (tag_tracking.py)
        -> ramp geometry           (tag_fusion.py)
        -> staging/guidance target (guidance.py)
        -> ordered navigation path (visualization.py)
        -> DockingResult

This module is **new** -- added specifically so an external caller (the
rover's own codebase) has exactly one class and one result type to learn,
instead of needing to understand and wire together seven internal
modules itself. It does not implement any detection/geometry/guidance
algorithm of its own: `VisionDockingPipeline.process_frame()` is pure
orchestration -- it calls the same public classes/functions
`scripts/test_ramp_geometry.py` (this project's own live debug viewer)
already calls, in the same order, with the same converter pattern for
turning loaded YAML config into each module's own constructor arguments.
If you want to see exactly what this wrapper does step by step, or you
need functionality this wrapper doesn't expose, read that script -- it
is the closest thing this project has to a second reference integration.

Every other module in this package remains fully usable directly; this
wrapper is a convenience, not a requirement.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .config import (
    ApproachPathConfig,
    RampPrototypeConfig,
    StagingConfig,
    TagsConfig,
    TagTrackingConfig,
    load_approach_path_config,
    load_ramp_prototype_config,
    load_staging_config,
    load_tag_tracking_config,
    load_tags_config,
)
from .detector import AprilTagDetector
from .guidance import (
    GroundPlane,
    GuidanceTargetGenerator,
    ProvisionalCalibration,
    RampTagMount,
    StagingCalibration,
)
from .models import CameraIntrinsics, GuidanceTarget, RampEstimate, TagTrackingState, TrackedTag
from .pose import TagPoseEstimator
from .tag_fusion import ThreeTagRampConfig, ThreeTagRampEstimator
from .tag_tracking import TagHoldConfig, TagPoseTracker, resolved_poses
from .visualization import (
    ApproachPathParams,
    NavigationPath,
    PathProgressState,
    advance_path_progress,
    build_navigation_path,
    desired_path_direction,
)

# Default hold timeout used when no tag_tracking.yaml is supplied --
# matches config/tag_tracking.yaml's own shipped default (see that
# file's comments for the reasoning).
_DEFAULT_HOLD_TIMEOUT_S = 0.20

# The three ramp-centerline tag IDs this deployment's config/tags.yaml
# configures (id 0 = entrance, id 1 = middle, id 2 = top). Hard-coded
# here only as a fallback for `from_config_dir()`'s default `tag_ids`
# behavior; a caller with a different physical layout should pass
# `tag_ids` explicitly to `VisionDockingPipeline.__init__()`.
_DEFAULT_RAMP_TAG_IDS = (0, 1, 2)


def _ramp_geometry_quality(supporting_tag_ids: tuple[int, ...], valid: bool) -> str:
    """`"EXACT"`/`"PROVISIONAL"`/`"INVALID"` for a `RampEstimate`, derived
    the same way `visualization.py`'s (private) HUD helper does -- see
    `tag_fusion.py`'s module docstring, "Three-tag centerline model"
    section: EXACT iff both endpoint tags (ids 0 and 2) directly
    contributed, PROVISIONAL iff valid but not both, INVALID iff not
    valid at all. `RampEstimate` itself carries no separate quality
    field by design, so every caller (including this one) derives it
    from `supporting_tag_ids`/`valid` the same way."""
    if not valid:
        return "INVALID"
    if {0, 2} <= set(supporting_tag_ids):
        return "EXACT"
    return "PROVISIONAL"


@dataclass(frozen=True)
class DockingResult:
    """One frame's complete, ready-to-consume docking/navigation result.

    This is the *only* type an integrator needs to understand -- every
    field is a plain Python/numpy value, never an internal pipeline
    class. See `INTEGRATION.md` for the full field-by-field explanation
    and for exactly which field the rover's controller should consume.

    The single most important field is `desired_travel_direction_deg`:
    a signed horizontal correction angle, **relative to the camera's own
    forward axis** (0 = already pointed the right way, positive = the
    target/path is to the right, negative = to the left) -- not a
    compass bearing, not a wheel angle, and not a motor command. This
    package does not convert it into any of those; the rover's own
    controller owns that step. It is `None` whenever `valid` is `False`
    or the currently active path section has no direction to report --
    never a fabricated value.
    """

    # --- top-level validity / confidence -----------------------------
    valid: bool
    quality: str  # "EXACT" / "PROVISIONAL" / "INVALID" -- staging/guidance quality
    confidence: float  # 0.0-1.0, staging/guidance confidence (see `quality`)
    reason: str  # human-readable diagnostic -- always populated, even when invalid

    # --- which tags actually produced this result --------------------
    live_tag_ids: tuple[int, ...]  # directly detected+posed this frame
    held_tag_ids: tuple[int, ...]  # temporarily reused from a recent frame (see tag_tracking.py)
    lost_tag_ids: tuple[int, ...]  # configured but neither live nor held this frame
    supporting_tag_ids: tuple[int, ...]  # which tags actually drove the staging/guidance result
    tracked_tags: tuple[TrackedTag, ...]  # full per-tag LIVE/HELD/LOST detail, if needed

    # --- ramp geometry (tag_fusion.py's independent reconstruction) --
    ramp_valid: bool
    ramp_confidence: float
    ramp_supporting_tag_ids: tuple[int, ...]
    geometry_quality: str  # "EXACT" / "PROVISIONAL" / "INVALID" -- ramp reconstruction quality

    # --- ordered navigation path (visualization.py) -------------------
    active_path_section: str | None  # "APPROACH" / "FINAL_ALIGNMENT" / "RAMP" / None
    next_mandatory_waypoint: str | None  # "STAGING" / "ENTRANCE" / "TOP" / None

    # --- landmark points, camera-frame metres (None if not available) -
    staging_point_camera_m: np.ndarray | None
    entrance_point_camera_m: np.ndarray | None
    top_point_camera_m: np.ndarray | None
    lookahead_point_camera_m: np.ndarray | None  # a point ahead on the current path; NOT a steering target yet

    # --- the value the rover controller should consume ----------------
    desired_travel_direction_deg: float | None
    ramp_direction_source: str | None  # e.g. "TAGS 0+2" / "TAG 2 ORIENTATION" -- see INTEGRATION.md

    timestamp: float


class VisionDockingPipeline:
    """Runs the full detect -> pose -> track -> ramp -> guidance -> path
    pipeline for one frame at a time and returns a single `DockingResult`.

    Owns exactly one piece of cross-frame state: the `PathProgressState`
    that decides when the rover has legitimately entered `RAMP` mode
    (see `visualization.py`'s `advance_path_progress()`). Everything
    else this class does is a stateless, per-frame recomputation, so
    creating a new `VisionDockingPipeline` mid-run (instead of calling
    `reset()`) is always safe if you'd rather start that state over.

    Does not own a camera. Does not touch `pyrealsense2` at all. The
    caller is responsible for producing `frame_bgr`/`intrinsics` however
    it likes -- from this package's own `camera.RealSenseCamera`, from
    the rover's existing RealSense integration, or from a synthetic/test
    array. See `INTEGRATION.md` for both patterns.
    """

    def __init__(
        self,
        *,
        tags_config: TagsConfig,
        ramp_config: RampPrototypeConfig,
        staging_config: StagingConfig,
        approach_path_config: ApproachPathConfig | None = None,
        tag_tracking_config: TagTrackingConfig | None = None,
        tag_ids: tuple[int, ...] | None = None,
    ) -> None:
        """Build every underlying component from already-loaded configs.

        Prefer `from_config_dir()` below unless you have a reason to
        load/override the configs yourself (e.g. constructing one in
        code for a unit test). *tag_ids* is which ramp-centerline tag
        IDs `tag_tracking.py`'s temporal hold layer tracks -- defaults
        to every ID in `tags_config.known_tags`.
        """
        self._roles = {kt.tag_id: kt.role for kt in tags_config.known_tags}
        self._tag_sizes_m = {kt.tag_id: kt.pose_tag_size_m for kt in tags_config.known_tags}

        self._detector = AprilTagDetector(
            family=tags_config.family,
            quad_decimate=tags_config.detector.quad_decimate,
            quad_sigma=tags_config.detector.quad_sigma,
            nthreads=tags_config.detector.nthreads,
            min_decision_margin=tags_config.detector.min_decision_margin,
            refine_edges=tags_config.detector.refine_edges,
            decode_sharpening=tags_config.detector.decode_sharpening,
            debug=tags_config.detector.debug,
        )
        # Same detector tuning passed to both -- see pose.py's own
        # module docstring for why a second, differently-tuned detector
        # instance here is a past mistake this project explicitly
        # guards against.
        self._pose_estimator = TagPoseEstimator(
            family=tags_config.family,
            tag_sizes_m=self._tag_sizes_m,
            quad_decimate=tags_config.detector.quad_decimate,
            quad_sigma=tags_config.detector.quad_sigma,
            nthreads=tags_config.detector.nthreads,
            refine_edges=tags_config.detector.refine_edges,
            decode_sharpening=tags_config.detector.decode_sharpening,
            debug=tags_config.detector.debug,
        )

        resolved_tag_ids = tag_ids if tag_ids is not None else tuple(self._tag_sizes_m)
        hold_timeout_s = (
            tag_tracking_config.hold_timeout_s
            if tag_tracking_config is not None
            else _DEFAULT_HOLD_TIMEOUT_S
        )
        self._tag_tracker = TagPoseTracker(
            tag_ids=resolved_tag_ids, config=TagHoldConfig(hold_timeout_s=hold_timeout_s)
        )

        self._ramp_estimator = ThreeTagRampEstimator(
            ThreeTagRampConfig(
                ramp_width_m=ramp_config.ramp_width_m,
                entrance_offset_m=ramp_config.entrance_offset_m,
                top_offset_m=ramp_config.top_offset_m,
                nominal_entrance_to_top_horizontal_m=(
                    ramp_config.nominal_entrance_to_top_horizontal_m
                ),
            )
        )

        staging_tags = {
            tag_id: RampTagMount(mount_heading_offset_deg=mount.mount_heading_offset_deg)
            for tag_id, mount in staging_config.tags.items()
        }
        self._guidance_generator = GuidanceTargetGenerator(
            StagingCalibration(
                staging_distance_m=staging_config.staging_distance_m,
                tags=staging_tags,
                ground_plane=GroundPlane(
                    camera_height_m=staging_config.camera_to_ground.camera_height_m
                ),
                provisional=ProvisionalCalibration(
                    nominal_entrance_to_top_horizontal_m=(
                        staging_config.provisional.nominal_entrance_to_top_horizontal_m
                    )
                ),
            )
        )

        self._approach_path_params = (
            ApproachPathParams(
                handle_fraction=approach_path_config.handle_fraction,
                min_handle_m=approach_path_config.min_handle_m,
                max_handle_m=approach_path_config.max_handle_m,
                sample_count=approach_path_config.sample_count,
                lookahead_m=approach_path_config.lookahead_m,
            )
            if approach_path_config is not None
            else ApproachPathParams()
        )

        self._path_progress = PathProgressState()

    @classmethod
    def from_config_dir(
        cls, config_dir: Path | str, *, tag_ids: tuple[int, ...] | None = None
    ) -> VisionDockingPipeline:
        """Build a `VisionDockingPipeline` from a directory containing
        `tags.yaml`, `staging.yaml`, `ramp_prototype.yaml`, and
        (optionally) `approach_path.yaml`/`tag_tracking.yaml` -- exactly
        the files shipped in this package's own `config/` folder.
        `camera.yaml` is **not** read here -- it only matters if you use
        this package's own `camera.RealSenseCamera`, which this class
        never constructs itself (see the class docstring).
        """
        config_dir = Path(config_dir)
        tags_config = load_tags_config(config_dir / "tags.yaml")
        ramp_config = load_ramp_prototype_config(config_dir / "ramp_prototype.yaml")
        staging_config = load_staging_config(config_dir / "staging.yaml")

        approach_path_path = config_dir / "approach_path.yaml"
        approach_path_config = (
            load_approach_path_config(approach_path_path) if approach_path_path.exists() else None
        )
        tag_tracking_path = config_dir / "tag_tracking.yaml"
        tag_tracking_config = (
            load_tag_tracking_config(tag_tracking_path) if tag_tracking_path.exists() else None
        )

        return cls(
            tags_config=tags_config,
            ramp_config=ramp_config,
            staging_config=staging_config,
            approach_path_config=approach_path_config,
            tag_tracking_config=tag_tracking_config,
            tag_ids=tag_ids,
        )

    def reset(self) -> None:
        """Forget accumulated cross-frame state -- currently just
        `PathProgressState` (see the class docstring). Call this if the
        rover disengages from the ramp and later starts a fresh docking
        attempt; otherwise a stale `RAMP` commitment from a previous
        attempt would incorrectly persist."""
        self._path_progress = PathProgressState()

    def process_frame(
        self,
        frame_bgr: np.ndarray,
        intrinsics: CameraIntrinsics,
        timestamp: float | None = None,
    ) -> DockingResult:
        """Run one frame through the full pipeline and return its
        `DockingResult`.

        *frame_bgr* is a `(height, width, 3)` `uint8` BGR image (exactly
        what `cv2`/RealSense color frames already are -- no pre-
        processing needed). *intrinsics* must describe *that* frame; use
        your camera's *active* stream profile, not a hard-coded value
        (see `INTEGRATION.md`). *timestamp* should be a monotonically
        increasing clock reading in seconds (`time.monotonic()` if
        omitted) -- it drives `tag_tracking.py`'s hold-timeout math, so
        wall-clock jumps or a decreasing value will confuse it.

        Raises `vision_docking.detector.TagDetectorError` or
        `vision_docking.pose.PoseEstimationError` for a genuinely
        malformed input (wrong image shape/dtype, non-finite intrinsics,
        a missing optional dependency) -- these are programming/input
        errors, not "no tags visible" (which is a completely normal
        result: `DockingResult.valid=False` with a `reason`, never an
        exception). See `INTEGRATION.md`, "Failure behavior."
        """
        if timestamp is None:
            timestamp = time.monotonic()

        frame_gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        detections = self._detector.detect(frame_gray, timestamp)
        poses = self._pose_estimator.estimate(frame_gray, detections, intrinsics)

        tracked_tags = self._tag_tracker.update(poses, timestamp)
        resolved = resolved_poses(tracked_tags)

        ramp_estimate = self._ramp_estimator.fuse(resolved, timestamp)
        guidance_target = self._guidance_generator.generate(resolved, timestamp)

        self._path_progress = advance_path_progress(self._path_progress, guidance_target)
        navigation_path = build_navigation_path(
            guidance_target,
            ramp_estimate,
            self._approach_path_params,
            progress=self._path_progress,
        )

        return _build_docking_result(tracked_tags, ramp_estimate, guidance_target, navigation_path)


def _build_docking_result(
    tracked_tags: list[TrackedTag],
    ramp_estimate: RampEstimate,
    guidance: GuidanceTarget,
    navigation_path: NavigationPath,
) -> DockingResult:
    """Map this frame's internal results into one `DockingResult` --
    pure data assembly, no new computation beyond the trivial `geometry_
    quality` derivation `_ramp_geometry_quality()` already documents."""
    live = tuple(t.tag_id for t in tracked_tags if t.state is TagTrackingState.LIVE)
    held = tuple(t.tag_id for t in tracked_tags if t.state is TagTrackingState.HELD)
    lost = tuple(t.tag_id for t in tracked_tags if t.state is TagTrackingState.LOST)

    active_section = navigation_path.active_section
    return DockingResult(
        valid=guidance.valid,
        quality=guidance.quality.name,
        confidence=guidance.confidence,
        reason=guidance.reason,
        live_tag_ids=live,
        held_tag_ids=held,
        lost_tag_ids=lost,
        supporting_tag_ids=guidance.supporting_tag_ids,
        tracked_tags=tuple(tracked_tags),
        ramp_valid=ramp_estimate.valid,
        ramp_confidence=ramp_estimate.confidence,
        ramp_supporting_tag_ids=ramp_estimate.supporting_tag_ids,
        geometry_quality=_ramp_geometry_quality(
            ramp_estimate.supporting_tag_ids, ramp_estimate.valid
        ),
        active_path_section=active_section.name if active_section is not None else None,
        next_mandatory_waypoint=navigation_path.next_mandatory_waypoint,
        staging_point_camera_m=navigation_path.staging_point_camera_m,
        entrance_point_camera_m=navigation_path.entrance_point_camera_m,
        top_point_camera_m=navigation_path.top_point_camera_m,
        lookahead_point_camera_m=navigation_path.lookahead_point_camera_m,
        desired_travel_direction_deg=_desired_travel_direction_deg(navigation_path),
        ramp_direction_source=navigation_path.ramp_direction_source,
        timestamp=guidance.timestamp,
    )


def _desired_travel_direction_deg(navigation_path: NavigationPath) -> float | None:
    """`desired_path_direction()`'s value for the current frame's own
    `active_section`, converted to degrees -- the exact same computation
    `visualization.py`'s `navigation_hud_lines()`/rover-direction-arrow
    already use, so this package's headless integration output can never
    disagree with what the (optional) debug viewer draws."""
    if navigation_path.active_section is None:
        return None
    direction = desired_path_direction(navigation_path, navigation_path.active_section)
    if direction is None:
        return None
    return math.degrees(math.atan2(direction[0], direction[2]))
