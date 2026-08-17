"""Shared data models for the vision-docking pipeline.

This module is the single source of truth for every type that crosses a
layer boundary in the docking pipeline::

    Camera -> AprilTag Detection -> Pose Estimation -> Tag Tracking
           -> Multi-Tag Fusion -> Ramp Estimate -> Guidance Target
           -> Docking Controller -> Vehicle Commands

Every other module in this package may import from `models`; `models`
itself must never import from any other module in this package. That
one-directional rule is what keeps the dependency graph acyclic as the
project grows -- if a future change makes `models` need something from
`detector` or `docking_controller`, that is a sign the new type belongs
in a different module, not that this rule should bend.

Numpy-array fields and `__eq__`
--------------------------------
Several dataclasses below hold `numpy.ndarray` fields. `numpy` arrays do
not support the plain `==` comparison a generated dataclass `__eq__`
relies on (comparing two arrays returns an array of booleans, not a
single `bool`, which raises `ValueError` inside the generated method).
Every dataclass with an array field marks that field `compare=False` and
documents an explicit `.close_to(...)` helper where approximate equality
is actually useful, rather than leaving the default `__eq__` as a latent
footgun.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum, auto

import numpy as np

# ---------------------------------------------------------------------------
# Camera calibration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CameraIntrinsics:
    """Pinhole camera intrinsic calibration parameters.

    Attributes:
        fx: Focal length in pixels, x-axis.
        fy: Focal length in pixels, y-axis.
        cx: Principal point x-coordinate, in pixels.
        cy: Principal point y-coordinate, in pixels.
        width: Sensor/stream width, in pixels.
        height: Sensor/stream height, in pixels.
        distortion: Distortion coefficients in OpenCV order
            (k1, k2, p1, p2, k3, ...). Empty tuple means "assume
            undistorted" (e.g. the RealSense SDK already rectified the
            stream).

    See also:
        `calibration.py` -- produces these from a checkerboard capture.
    """

    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int
    distortion: tuple[float, ...] = ()

    def as_matrix(self) -> np.ndarray:
        """Return the 3x3 OpenCV-style camera intrinsic matrix K."""
        return np.array(
            [
                [self.fx, 0.0, self.cx],
                [0.0, self.fy, self.cy],
                [0.0, 0.0, 1.0],
            ],
            dtype=np.float64,
        )


# ---------------------------------------------------------------------------
# AprilTag detection
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TagDetection:
    """One AprilTag detected in a single camera frame, in pixel space.

    Produced by `detector.py`; consumed by `pose.py`.

    Attributes:
        tag_id: Decoded AprilTag ID.
        corners: (4, 2) array of pixel-space corner coordinates, ordered
            counter-clockwise starting from the tag's bottom-left corner
            (the convention used by most AprilTag libraries).
        center: Pixel-space centroid of the tag, (x, y).
        decision_margin: Detector confidence score; higher is more
            confident. Threshold via `config/tags.yaml`'s
            `min_decision_margin`.
        timestamp: Capture time of the source frame, in seconds
            (monotonic clock, not wall-clock).
        hamming: Number of bit errors the decoder corrected (0 is a
            perfect decode). Defaults to 0 for detector backends/tests
            that don't report it.
        family: AprilTag family string (e.g. "tag36h11") this detection
            was decoded against. Defaults to "" when not reported.
    """

    tag_id: int
    corners: np.ndarray = field(compare=False)
    center: tuple[float, float]
    decision_margin: float
    timestamp: float
    hamming: int = 0
    family: str = ""

    def __post_init__(self) -> None:
        if self.corners.shape != (4, 2):
            raise ValueError(
                f"TagDetection.corners must have shape (4, 2), got {self.corners.shape}"
            )


# ---------------------------------------------------------------------------
# Pose estimation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TagPose:
    """3D pose of one AprilTag relative to the camera.

    Produced by `pose.py`; consumed by `tag_fusion.py`. Everything here
    is **camera-relative**, not ramp-relative -- see `pose.py`'s module
    docstring for the exact camera coordinate convention (verified
    against the backend, not assumed) and for why a tag's own yaw is not
    the ramp's heading whenever that tag is mounted at an angle. Turning
    this into ramp-relative geometry is `tag_fusion.py`'s job, not this
    model's.

    Attributes:
        tag_id: Which tag this pose belongs to (matches `TagDetection.tag_id`).
        translation: (3,) translation vector, metres, camera frame --
            the tag's origin (printed center) expressed in the camera's
            coordinate frame. See `camera_x_m`/`camera_y_m`/`camera_z_m`
            below for labeled per-axis access.
        rotation: (3, 3) rotation matrix that carries a vector expressed
            in the tag's own **raw backend** local frame into the camera
            frame (``p_camera = rotation @ p_tag_raw + translation``),
            exactly as returned by the pose backend with no remapping
            applied -- this is *not* the same tag-frame convention
            `yaw_deg`/`pitch_deg`/`roll_deg` below describe; see
            `pose.py`'s module docstring (and its `correct_tag_frame()`)
            for exactly why and how those differ, and
            `scripts/test_apriltag_pose.py`'s "raw pose" overlay section
            for inspecting this field directly.
        reprojection_error: The pose backend's own object-space pose-fit
            error (`pupil_apriltags.Detection.pose_err`) -- despite the
            name (kept for backward compatibility with this field's
            original `cv2.solvePnP`-oriented design), this is *not* a
            pixel-space reprojection error; it is AprilTag's own residual
            from its homography-based pose solve. Lower is better. A
            data-quality signal for `tag_fusion.py` to weigh this pose
            against others.
        timestamp: Capture time of the source frame, in seconds
            (monotonic clock).
        yaw_deg: Tag orientation relative to the camera, in degrees --
            rotation about the camera's Z axis in the Tait-Bryan Z-Y-X
            (yaw-pitch-roll) decomposition of the *corrected* tag frame
            (`pose.correct_tag_frame(rotation)`, **not** `rotation`
            itself -- see `pose.py`'s module docstring for why a fixed
            correction is needed). With that correction, a tag directly
            facing the camera reads approximately yaw = pitch = roll = 0;
            panning the tag left/right changes yaw. See `pose.py`'s
            `rotation_matrix_to_euler_deg()` for the exact, tested
            decomposition. Defaults to 0.0 for callers that don't
            populate it (e.g. existing tests constructing a `TagPose`
            directly from a translation/rotation only).
        pitch_deg: Rotation about the once-rotated Y axis in the same
            corrected decomposition -- tilting the tag up/down changes
            pitch.
        roll_deg: Rotation about the twice-rotated X axis in the same
            corrected decomposition -- rotating the tag within its own
            printed plane changes roll.
        decision_margin: The originating `TagDetection.decision_margin`
            this pose was solved from -- carried here so a consumer that
            only has a `TagPose` (not the original `TagDetection`) still
            has a data-quality signal available. Defaults to 0.0.
    """

    tag_id: int
    translation: np.ndarray = field(compare=False)
    rotation: np.ndarray = field(compare=False)
    reprojection_error: float
    timestamp: float
    yaw_deg: float = 0.0
    pitch_deg: float = 0.0
    roll_deg: float = 0.0
    decision_margin: float = 0.0

    def __post_init__(self) -> None:
        if self.translation.shape != (3,):
            raise ValueError(
                f"TagPose.translation must have shape (3,), got {self.translation.shape}"
            )
        if self.rotation.shape != (3, 3):
            raise ValueError(
                f"TagPose.rotation must have shape (3, 3), got {self.rotation.shape}"
            )
        if not np.all(np.isfinite(self.translation)):
            raise ValueError(f"TagPose.translation must be finite, got {self.translation}")
        if not np.all(np.isfinite(self.rotation)):
            raise ValueError(f"TagPose.rotation must be finite, got {self.rotation}")
        for name, value in (
            ("reprojection_error", self.reprojection_error),
            ("yaw_deg", self.yaw_deg),
            ("pitch_deg", self.pitch_deg),
            ("roll_deg", self.roll_deg),
            ("decision_margin", self.decision_margin),
        ):
            if not math.isfinite(value):
                raise ValueError(f"TagPose.{name} must be finite, got {value}")

    @property
    def camera_x_m(self) -> float:
        """Camera-frame X, metres: positive = right of the camera's optical axis."""
        return float(self.translation[0])

    @property
    def camera_y_m(self) -> float:
        """Camera-frame Y, metres: positive = below the camera's optical axis
        (image Y is down -- see `pose.py`'s documented convention)."""
        return float(self.translation[1])

    @property
    def camera_z_m(self) -> float:
        """Camera-frame Z, metres: positive = forward, away from the
        camera, along its optical axis."""
        return float(self.translation[2])

    @property
    def distance_m(self) -> float:
        """Straight-line distance from the camera to the tag, metres --
        the Euclidean norm of `translation` (not just `camera_z_m`)."""
        return float(np.linalg.norm(self.translation))

    @property
    def lateral_offset_m(self) -> float:
        """User-friendly alias for `camera_x_m`: positive = tag is to the
        right of the camera's centerline."""
        return self.camera_x_m

    @property
    def vertical_offset_m(self) -> float:
        """User-friendly derived label: negated `camera_y_m` so that
        positive = tag appears *higher* than the camera -- more intuitive
        than the raw image-Y-down convention `camera_y_m` uses."""
        return -self.camera_y_m

    @property
    def forward_distance_m(self) -> float:
        """User-friendly alias for `camera_z_m`: how far the tag is along
        the camera's optical axis. Distinct from `distance_m` (the
        straight-line distance) whenever there is lateral/vertical offset."""
        return self.camera_z_m


# ---------------------------------------------------------------------------
# Tag tracking (temporal hold layer)
# ---------------------------------------------------------------------------


class TagTrackingState(Enum):
    """One tracked tag's resolved status for the current frame --
    produced by `tag_tracking.py`'s `TagPoseTracker`. See that module's
    docstring for the full state machine this reflects.

    Values:
        LIVE: A valid pose was observed this frame; that pose is used.
        HELD: No valid pose was observed this frame, but the last
            observed pose is still within the configured hold timeout,
            so it is temporarily reused, unmodified.
        LOST: No valid pose was observed this frame, and either the
            last observed pose is now older than the hold timeout, or
            this tag has never been observed at all. No pose is
            reported.
    """

    LIVE = "LIVE"
    HELD = "HELD"
    LOST = "LOST"


@dataclass(frozen=True)
class TrackedTag:
    """One configured tag ID's temporally-resolved state for the current
    frame, produced by `tag_tracking.py`'s `TagPoseTracker.update()`.

    Never itself smoothed, averaged, or extrapolated -- `pose` is either
    this frame's own observation (`LIVE`) or a past frame's observation
    reused verbatim (`HELD`); see `tag_tracking.py`'s module docstring,
    "No smoothing" section.

    Attributes:
        tag_id: Which tag this is (matches `TagPose.tag_id`).
        pose: The pose to actually use this frame -- this frame's own
            observation when `state` is `LIVE`, the last observed pose
            verbatim when `HELD`, and `None` when `LOST` (never
            fabricated).
        state: This tag's current `TagTrackingState`.
        last_seen_timestamp: The timestamp this tag was last *directly*
            observed (not merely held) -- `None` if it has never been
            observed at all.
    """

    tag_id: int
    pose: TagPose | None
    state: TagTrackingState
    last_seen_timestamp: float | None

    def __post_init__(self) -> None:
        if self.last_seen_timestamp is not None and not math.isfinite(self.last_seen_timestamp):
            raise ValueError(
                f"TrackedTag.last_seen_timestamp must be finite, got {self.last_seen_timestamp}"
            )
        if self.state is TagTrackingState.LOST and self.pose is not None:
            raise ValueError("TrackedTag: a LOST tag must not carry a pose")
        if self.state is not TagTrackingState.LOST and self.pose is None:
            raise ValueError(f"TrackedTag: a {self.state.value} tag must carry a pose")


# ---------------------------------------------------------------------------
# Multi-tag fusion
# ---------------------------------------------------------------------------


def _validate_optional_vec3(owner: str, name: str, value: np.ndarray | None) -> None:
    if value is None:
        return
    if value.shape != (3,):
        raise ValueError(f"{owner}.{name} must have shape (3,), got {value.shape}")
    if not np.all(np.isfinite(value)):
        raise ValueError(f"{owner}.{name} must be finite, got {value}")


def _validate_optional_float(owner: str, name: str, value: float | None) -> None:
    if value is not None and not math.isfinite(value):
        raise ValueError(f"{owner}.{name} must be finite, got {value}")


@dataclass(frozen=True)
class RampSectionEstimate:
    """One rigid ramp section's pose relative to the camera, reconstructed
    from whichever of its mounted tags are currently visible.

    Produced by `tag_fusion.py` -- once per call for the *entrance*
    assembly (tags 0-1) and once for the *upper* assembly (tags 2-4); see
    that module's docstring for why the ramp is deliberately modeled as
    two independently-posed rigid sections rather than one rigid body.
    Consumed by `tag_fusion.py` itself (`build_ramp_estimate()`) to
    produce the final `RampEstimate`.

    This is intentionally a thin, generic "where is this rigid section,
    and how sure are we" result -- it carries no ramp-specific landmark
    points itself (no `entrance_center`, no `top_left`, etc.); those are
    derived downstream by applying `transform_camera_section` to the
    section's configured local landmark points (`config/ramp.yaml`'s
    `entrance_section`/`upper_section`), which is exactly what
    `build_ramp_estimate()` does to produce a `RampEstimate`.

    Attributes:
        transform_camera_section: (4, 4) homogeneous rigid transform
            mapping a point expressed in this section's own local frame
            into the camera frame (``p_camera = transform_camera_section
            @ [p_section_x, p_section_y, p_section_z, 1]``), or `None` if
            no valid estimate could be produced (`valid` is always
            `False` whenever this is `None`, and vice versa -- see
            `tag_fusion.py`'s `combine_section_transforms()`, the sole
            producer of this type, which enforces that invariant).
            Structural validation only (shape, finite); the deeper
            "is this actually a rigid transform" checks (orthonormal
            rotation block, proper `[0, 0, 0, 1]` bottom row) are
            `tag_fusion.py`'s `validate_transform()`'s job, enforced
            *before* this object is ever constructed.
        supporting_tag_ids: IDs of the tags that were actually used to
            produce `transform_camera_section` (excludes any tag that
            was visible but rejected as an outlier -- see
            `tag_fusion.py`'s disagreement-tolerance handling).
        confidence: Fusion confidence in [0.0, 1.0] -- see
            `tag_fusion.py`'s module docstring for exactly how this is
            computed (single-tag vs. multi-tag agreement).
        valid: Whether this section estimate is usable at all. `False`
            for "no visible/mounted tags", "tags disagree beyond
            tolerance with no majority", or "confidence below the
            configured minimum" -- see `reason` for which.
        reason: Human-readable diagnostic -- always populated (even when
            `valid` is `True`, e.g. "single supporting tag (id=4)"),
            never blank, so a caller/live-viewer never has to guess why.
        timestamp: Capture time of the source frame this was
            reconstructed from, in seconds (monotonic clock).
    """

    transform_camera_section: np.ndarray | None = field(compare=False)
    supporting_tag_ids: tuple[int, ...]
    confidence: float
    valid: bool
    reason: str
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        if self.transform_camera_section is not None:
            if self.transform_camera_section.shape != (4, 4):
                raise ValueError(
                    "RampSectionEstimate.transform_camera_section must have shape "
                    f"(4, 4), got {self.transform_camera_section.shape}"
                )
            if not np.all(np.isfinite(self.transform_camera_section)):
                raise ValueError(
                    "RampSectionEstimate.transform_camera_section must be finite, "
                    f"got {self.transform_camera_section}"
                )
        if not (0.0 <= self.confidence <= 1.0):
            raise ValueError(
                f"RampSectionEstimate.confidence must be in [0, 1], got {self.confidence}"
            )
        if not math.isfinite(self.timestamp):
            raise ValueError(f"RampSectionEstimate.timestamp must be finite, got {self.timestamp}")


@dataclass(frozen=True)
class RampEstimate:
    """Dynamic, camera-relative reconstruction of the docking ramp.

    Produced by `tag_fusion.py`'s `build_ramp_estimate()` from one
    entrance `RampSectionEstimate` and one upper `RampSectionEstimate`;
    consumed by `docking_controller.py` (once implemented) and
    `visualization.py`. Supersedes the earlier placeholder `RampPose`
    (a single rigid-body translation/rotation) now that the ramp is
    known to be two independently-moving sections -- see `tag_fusion.py`
    for the full reasoning.

    Every field here is **camera-relative**, not rover/world-relative,
    and every point/direction is **optional**: this ramp may currently
    be visible only at the entrance, only at the top, fully, or not at
    all -- see `valid`/`reason`/`supporting_tag_ids` to know which, and
    check each field individually rather than assuming `valid=True`
    means every field is populated (e.g. an entrance-only estimate still
    reports `valid=True` with every top-section field `None`).

    Attributes:
        entrance_center_m: Entrance assembly's configured center
            landmark, camera frame, metres -- `None` if the entrance
            section is invalid or that landmark isn't configured in
            `config/ramp.yaml`.
        middle_center_m: Midpoint of the middle tag pair (ids 2-3),
            camera frame, metres -- only populated by `tag_fusion.py`'s
            prototype midpoint model (`estimate_ramp_from_midpoints()`);
            the full two-section model leaves this `None` (it has no
            equivalent middle-pair concept). `None` whenever neither
            middle tag is visible. **Never used to compute
            `centerline_direction`/`heading_deg`/`pitch_deg` below** --
            the primary centerline is always the straight line from
            `entrance_center_m` to `top_center_m` only; this point is a
            diagnostic-only input, see `middle_perpendicular_distance_m`.
        top_center_m: Upper assembly's configured top-center landmark,
            camera frame, metres -- same caveats as `entrance_center_m`.
        middle_perpendicular_distance_m: Perpendicular distance, metres,
            from `middle_center_m` to the straight `entrance_center_m`-
            to-`top_center_m` centerline -- a pure diagnostic (how far
            off-axis the middle pair sits), never used to move or bend
            the centerline itself. Only populated by the prototype
            midpoint model; `None` whenever `middle_center_m` or the
            centerline itself (both `entrance_center_m` and
            `top_center_m`) is unavailable. See `tag_fusion.py`'s
            `_project_onto_centerline()`.
        middle_distance_along_centerline_m: Signed distance, metres,
            from `entrance_center_m` along `centerline_direction` at
            which `middle_center_m`'s projection onto the centerline
            falls (0 = at the entrance, `deployed_length_m` = at the
            top) -- a positional diagnostic alongside
            `middle_perpendicular_distance_m`, same availability
            caveats.
        entrance_left_m: Entrance assembly's left outside-edge landmark,
            camera frame, metres, or `None`.
        entrance_right_m: Entrance assembly's right outside-edge
            landmark, camera frame, metres, or `None`.
        top_left_m: Upper assembly's left outside-edge landmark, camera
            frame, metres, or `None`.
        top_right_m: Upper assembly's right outside-edge landmark,
            camera frame, metres, or `None`.
        centerline_direction: (3,) unit vector, camera frame, from
            `entrance_center_m` toward `top_center_m` -- `None` unless
            both are available and not coincident.
        horizontal_approach_direction: (3,) unit vector -- `centerline_
            direction` projected onto the camera-horizontal (X-Z) plane
            and re-normalized, i.e. with the vertical (camera Y)
            component discarded. Points from the entrance toward the
            ramp (the direction of travel when *approaching/entering*
            it) -- see `tag_fusion.py`'s `compute_staging_point_m()` for
            how a future steering layer can use this. `None` unless
            `centerline_direction` is available and not purely vertical.
        deployed_length_m: `norm(top_center_m - entrance_center_m)`,
            metres -- the ramp's *current* entrance-to-top length (it can
            change: see `tag_fusion.py`'s module docstring on why the
            ramp is not modeled as one rigid body). `None` unless both
            centers are available.
        width_m: Best available ramp width, metres. Reconstructed from
            whichever section's left/right landmarks are configured and
            valid (entrance preferred over upper), falling back to
            `config/ramp.yaml`'s configured `width_m` if no landmarks are
            available, or `0.0` as a last resort (a sentinel, not a
            measurement -- check `valid`/`reason`/`supporting_tag_ids`
            before trusting a nonzero value here).
        heading_deg: Horizontal ramp heading, degrees --
            ``atan2(horizontal_approach_direction.x,
            horizontal_approach_direction.z)``: 0 means the ramp extends
            straight along the camera's forward axis, positive means it
            trends toward the camera's right, negative toward its left.
            `None` unless `horizontal_approach_direction` is available.
        pitch_deg: Vertical ramp pitch, degrees --
            ``atan2(-centerline_direction.y, horizontal_length)``:
            positive means the top is higher than the entrance (uphill,
            approaching from below), negative means downhill. `None`
            unless `centerline_direction` is available.
        supporting_tag_ids: Union of the entrance's and the upper
            section's `supporting_tag_ids` (accepted tags only, outliers
            excluded).
        confidence: Overall confidence in [0.0, 1.0] -- `min()` of the
            two section confidences when both are valid, otherwise
            whichever single section is valid, otherwise `0.0`. See
            `tag_fusion.py` for the exact combination (including the
            width-disagreement penalty).
        valid: `True` if at least one section (entrance or upper)
            produced a usable estimate *and* the combined confidence
            meets `config/ramp.yaml`'s `min_confidence` -- covers the
            "entrance-only"/"upper-only"/"complete" outcomes alike.
            `False` only for "insufficient tags" or "confidence too low".
        reason: Human-readable diagnostic, always populated; names which
            outcome this is (complete/entrance-only/upper-only/
            insufficient) and folds in either section's own `reason`.
        timestamp: Capture time of the source frame, in seconds
            (monotonic clock).
    """

    entrance_center_m: np.ndarray | None = field(compare=False)
    middle_center_m: np.ndarray | None = field(compare=False)
    top_center_m: np.ndarray | None = field(compare=False)
    middle_perpendicular_distance_m: float | None
    middle_distance_along_centerline_m: float | None
    entrance_left_m: np.ndarray | None = field(compare=False)
    entrance_right_m: np.ndarray | None = field(compare=False)
    top_left_m: np.ndarray | None = field(compare=False)
    top_right_m: np.ndarray | None = field(compare=False)
    centerline_direction: np.ndarray | None = field(compare=False)
    horizontal_approach_direction: np.ndarray | None = field(compare=False)
    deployed_length_m: float | None
    width_m: float
    heading_deg: float | None
    pitch_deg: float | None
    supporting_tag_ids: tuple[int, ...]
    confidence: float
    valid: bool
    reason: str
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        for name in (
            "entrance_center_m",
            "middle_center_m",
            "top_center_m",
            "entrance_left_m",
            "entrance_right_m",
            "top_left_m",
            "top_right_m",
            "centerline_direction",
            "horizontal_approach_direction",
        ):
            _validate_optional_vec3("RampEstimate", name, getattr(self, name))
        for name in (
            "deployed_length_m",
            "heading_deg",
            "pitch_deg",
            "middle_perpendicular_distance_m",
            "middle_distance_along_centerline_m",
        ):
            _validate_optional_float("RampEstimate", name, getattr(self, name))
        if not math.isfinite(self.width_m):
            raise ValueError(f"RampEstimate.width_m must be finite, got {self.width_m}")
        if not (0.0 <= self.confidence <= 1.0):
            raise ValueError(f"RampEstimate.confidence must be in [0, 1], got {self.confidence}")
        if not math.isfinite(self.timestamp):
            raise ValueError(f"RampEstimate.timestamp must be finite, got {self.timestamp}")


# ---------------------------------------------------------------------------
# Guidance target generation
# ---------------------------------------------------------------------------


class TargetQuality(Enum):
    """How directly a `GuidanceTarget` was observed, not merely whether
    one exists -- see `guidance.py`'s module docstring for the full
    EXACT/PROVISIONAL hierarchy.

    Deliberately not a stateful phase machine like `DockingPhase` below
    -- `guidance.py` is a stateless, per-frame geometric transform, so
    this only reflects what one frame's visible tags allowed computing,
    not a multi-frame docking attempt.

    Values:
        EXACT: The entrance was directly observed -- both bottom
            entrance tags (ids 0-1) visible, or one of them visible
            with a configured pair spacing to reconstruct the other.
        PROVISIONAL: No bottom entrance tag was usable at all; the
            entrance was instead *estimated* from the upper tags (ids
            2-4) plus a configured nominal top-to-entrance distance --
            never a substitute for directly observing ids 0-1, only a
            coarse heading/centerline cue to steer by until they're
            visible. Always lower confidence than any `EXACT` result.
        INVALID: No usable target could be computed at all (no bottom
            or upper tags usable, or required calibration missing).
    """

    EXACT = auto()
    PROVISIONAL = auto()
    INVALID = auto()


@dataclass(frozen=True)
class GuidanceTarget:
    """A virtual, camera-relative point for the rover to aim toward,
    plus the geometry describing how to reach it.

    Produced by `guidance.py`'s `compute_guidance_target()` directly
    from `TagPose` values -- **not** from a `RampEstimate` -- purely a
    geometric transform, not steering: there is no wheel command, no
    velocity, no controller here at all. See that module's docstring
    for the exact EXACT/PROVISIONAL hierarchy, the staging-point
    formula, and the mounting-heading correction.

    Every field here is **camera-relative**. `target_point_camera_m` and
    everything derived from it are `None` whenever no tier of the
    hierarchy produced a usable entrance (see `quality`) or the ground
    plane isn't configured -- never fabricated from a stale or guessed
    direction.

    Attributes:
        entrance_center_m: (3,) raw horizontal position of the entrance
            -- the exact midpoint of ids 0/1 when `quality` is `EXACT`
            and both are visible, a spacing-corrected single-bottom-tag
            reconstruction when `EXACT` with only one, or a *nominal*
            estimate projected back from the upper tags (ids 2-4) when
            `quality` is `PROVISIONAL` (see `guidance.py`'s module
            docstring for exactly how). Its vertical (camera Y)
            component is whatever the source tag(s) reported -- **not
            yet** snapped to the ground plane (see
            `entrance_ground_point_camera_m` for that). `None` if
            `quality` is `INVALID`.
        entrance_ground_point_camera_m: (3,) `entrance_center_m` with
            its vertical component replaced by the configured ground
            plane height -- this, not `entrance_center_m`, is what
            `target_point_camera_m` is actually computed from. `None`
            under the same conditions as `entrance_center_m`, plus
            whenever the ground plane isn't configured.
        approach_heading_deg: The corrected ramp-approach heading
            estimate used to build the horizontal direction, degrees --
            a circular mean of whichever supporting tags' mounting-
            corrected headings contributed (see `supporting_tag_ids`).
            Sourced from each tag's `TagPose.pitch_deg`, **not**
            `yaw_deg` -- see `guidance.py`'s module docstring for why
            `pitch_deg` is the field that actually carries horizontal
            panning under this repository's tested Euler convention,
            and why that has nothing to do with the ramp's own vertical
            incline despite the shared word "pitch". **Not the same
            quantity as `target_bearing_deg`** -- this is which way the
            *ramp* faces, not which way the *staging point* is from the
            rover's current position; see `target_bearing_deg`'s
            docstring for a worked example of how they differ. `None`
            if `quality` is `INVALID`.
        target_point_camera_m: (3,) staging point, camera frame, metres
            -- ``entrance_ground_point_camera_m - staging_distance_m *
            horizontal_direction``, where `horizontal_direction` is
            built purely from `approach_heading_deg` (never from
            `TagPose.yaw_deg`/`roll_deg`, and never from `top_center -
            entrance_center`). Its vertical component always exactly
            equals `entrance_ground_point_camera_m`'s -- the ramp's
            vertical incline and any tag's own height can never move
            it. `None` if `entrance_ground_point_camera_m` or
            `approach_heading_deg` is unavailable.
        target_bearing_deg: Horizontal angle, degrees, from the rover's
            forward axis (camera +Z) to `target_point_camera_m` --
            ``atan2(lateral_error_m, forward_error_m)``. **Positive
            means the target is to the rover's right; negative means
            to its left; 0 means straight ahead** (the same sign
            convention as `RampEstimate.heading_deg`). This is a raw,
            unfiltered per-frame direction to travel, not a steering/
            wheel angle -- no EMA/median/rate-limiting/PID/Pure-Pursuit/
            Stanley is applied anywhere in this pipeline yet (see
            `guidance.py`'s module docstring, "Raw target bearing"
            section). **Assumption**: the rover's current position is
            taken to be exactly the camera's origin, since
            `target_point_camera_m` is already camera-relative and this
            prototype has no separate camera-to-rover mounting offset
            measured yet. **Not the same quantity as `approach_heading_
            deg`**: that field is which way the *ramp* faces;
            `target_bearing_deg` is which way the *staging point* is
            from here right now -- a rover can be off to one side of
            the ramp's centerline while the ramp still faces it
            squarely, giving a near-zero `approach_heading_deg` and a
            large, nonzero `target_bearing_deg` simultaneously; never
            confuse or combine the two. When the horizontal distance to
            the target is below `guidance.py`'s `_AT_TARGET_TOLERANCE_M`
            (the rover is numerically already there), this is reported
            as `0.0` by convention rather than an unstable, noise-driven
            `atan2` result -- see `reason` for whether that happened.
            Targets behind the rover are **not** rejected -- this
            approaches +/-180 rather than being clamped or treated as
            invalid. `None` unless `target_point_camera_m` is available.
        distance_to_target_m: Straight-line, **horizontal-only**
            (ground-plane) distance to `target_point_camera_m`, metres
            -- ``hypot(lateral_error_m, forward_error_m)``. Deliberately
            excludes the vertical component: a wheeled rover's travel
            distance depends on ground position, not on the camera's
            height above the target. `None` unless
            `target_point_camera_m` is available.
        lateral_error_m: `target_point_camera_m`'s camera-X component,
            metres -- how far to the rover's right (positive) or left
            (negative) the target currently is. Same sign convention as
            `pose.py`'s `TagPose.lateral_offset_m`. `None` unless
            `target_point_camera_m` is available.
        forward_error_m: `target_point_camera_m`'s camera-Z component,
            metres -- how far ahead (positive) the target currently is.
            Same sign convention as `pose.py`'s
            `TagPose.forward_distance_m`. `None` unless
            `target_point_camera_m` is available.
        heading_error_deg: Angular difference, degrees, between the
            rover's current forward direction and the direction it
            should travel to reach the target. **Assumption**: the
            rover body frame currently coincides with the camera frame
            (no separate IMU heading yet), so this is presently just a
            copy of `target_bearing_deg` -- seeded as its own field
            (rather than reusing `target_bearing_deg` directly) so a
            future revision can subtract the rover's actual IMU heading
            here without changing `target_bearing_deg`'s meaning. See
            `guidance.py`'s module docstring. `None` unless
            `target_point_camera_m` is available.
        staging_distance_m: The configured distance actually applied
            this frame, metres -- echoed through from `StagingConfig`/
            `GuidanceTargetGenerator` so a single `GuidanceTarget` is
            self-describing for logging/display. `None` when `quality`
            is `INVALID`.
        ground_plane_height_m: The configured camera height above the
            ground plane actually used this frame, metres -- echoed
            through from `StagingConfig.camera_to_ground.
            camera_height_m`. `None` if the ground plane wasn't
            configured (in which case no target could be computed at
            all, regardless of tag visibility).
        supporting_tag_ids: Which tag IDs actually contributed to this
            frame's entrance/heading estimate (e.g. `(0, 1)` for a full
            `EXACT` result, `(2, 3, 4)` for a full `PROVISIONAL` one).
            Empty when `quality` is `INVALID`. `quality` alone tells you
            whether the entrance came from the bottom tags (`EXACT`) or
            was estimated from the upper tags (`PROVISIONAL`) --  no
            separate "entrance source" field is needed.
        quality: `TargetQuality` this frame's target reflects -- `EXACT`
            (directly observed via ids 0-1), `PROVISIONAL` (estimated
            from ids 2-4 plus a configured nominal distance, only when
            no `EXACT` result was possible), or `INVALID`.
        confidence: `1.0` with both bottom tags, reduced for the
            single-bottom-tag fallback (`EXACT`); lower still for any
            `PROVISIONAL` tier (always below every `EXACT` confidence,
            by construction -- see `guidance.py` for the exact values);
            `0.0` when `quality` is `INVALID`. This module applies no
            per-tag agreement/outlier logic (unlike `tag_fusion.py`).
        valid: `True` iff `target_point_camera_m` could be computed
            (`quality` is `EXACT` or `PROVISIONAL`).
        reason: Human-readable diagnostic, always populated.
        timestamp: Capture time of the source frame, in seconds
            (monotonic clock).
    """

    entrance_center_m: np.ndarray | None = field(compare=False)
    entrance_ground_point_camera_m: np.ndarray | None = field(compare=False)
    target_point_camera_m: np.ndarray | None = field(compare=False)
    approach_heading_deg: float | None
    target_bearing_deg: float | None
    distance_to_target_m: float | None
    lateral_error_m: float | None
    forward_error_m: float | None
    heading_error_deg: float | None
    staging_distance_m: float | None
    ground_plane_height_m: float | None
    supporting_tag_ids: tuple[int, ...]
    quality: TargetQuality
    confidence: float
    valid: bool
    reason: str
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        for name in (
            "entrance_center_m",
            "entrance_ground_point_camera_m",
            "target_point_camera_m",
        ):
            _validate_optional_vec3("GuidanceTarget", name, getattr(self, name))
        for name in (
            "approach_heading_deg",
            "target_bearing_deg",
            "distance_to_target_m",
            "lateral_error_m",
            "forward_error_m",
            "heading_error_deg",
            "staging_distance_m",
            "ground_plane_height_m",
        ):
            _validate_optional_float("GuidanceTarget", name, getattr(self, name))
        if self.distance_to_target_m is not None and self.distance_to_target_m < 0:
            raise ValueError(
                f"GuidanceTarget.distance_to_target_m must be non-negative, "
                f"got {self.distance_to_target_m}"
            )
        if not (0.0 <= self.confidence <= 1.0):
            raise ValueError(f"GuidanceTarget.confidence must be in [0, 1], got {self.confidence}")
        if not math.isfinite(self.timestamp):
            raise ValueError(f"GuidanceTarget.timestamp must be finite, got {self.timestamp}")


# ---------------------------------------------------------------------------
# Docking state machine
# ---------------------------------------------------------------------------


class DockingPhase(Enum):
    """Discrete phases of one docking attempt, driven by `state_machine.py`."""

    SEARCHING = auto()       # No ramp pose yet; rover is looking for tags.
    APPROACHING = auto()     # Ramp found; closing distance, coarse heading.
    ALIGNING = auto()        # Close enough to prioritize heading alignment.
    FINAL_APPROACH = auto()  # Aligned; slow, precise final approach.
    DOCKED = auto()          # Within docking tolerance -- terminal success state.
    ABORTED = auto()         # Docking abandoned (lost tags too long, etc.) -- terminal.


@dataclass(frozen=True)
class DockingCommand:
    """One commanded velocity, produced by `docking_controller.py`.

    This is the sole output type the docking pipeline hands to the
    rover's vehicle-command layer (outside this package) -- everything
    upstream of this type is internal to vision-docking.

    Attributes:
        linear_velocity_mps: Forward velocity command, metres/second.
            Positive is forward.
        angular_velocity_radps: Yaw rate command, radians/second.
            Positive is counter-clockwise (left turn).
        phase: `DockingPhase` this command was computed under, so the
            vehicle-integration layer can log/gate commands per phase.
        timestamp: Time this command was computed, in seconds
            (monotonic clock).
    """

    linear_velocity_mps: float
    angular_velocity_radps: float
    phase: DockingPhase
    timestamp: float


@dataclass
class DockingState:
    """Mutable state owned and updated by `state_machine.py`.

    Deliberately not frozen: this is the one place per docking attempt
    that legitimately changes over time (unlike the per-frame,
    immutable pipeline values above). Nothing else in this package should
    hold or mutate its own copy of docking state -- pass this instance
    through function/method calls rather than duplicating it.

    Attributes:
        phase: Current `DockingPhase`.
        ramp_estimate: Most recent `RampEstimate`, or `None` if no tags
            are currently visible. Check `RampEstimate.valid` -- an
            entrance-only or upper-only partial estimate is still not
            `None` here, just missing some fields; see `RampEstimate`'s
            docstring.
        last_command: Most recent `DockingCommand` issued, or `None`
            before the first command.
        started_at: Monotonic timestamp when this docking attempt began,
            or `None` if not yet started.
        updated_at: Monotonic timestamp of the last state update.
        missed_frame_count: Consecutive frames with no valid
            `RampEstimate`; compared against `config/docking.yaml`'s
            `max_missed_frames` to decide when to abort.
    """

    phase: DockingPhase
    ramp_estimate: RampEstimate | None
    last_command: DockingCommand | None
    started_at: float | None
    updated_at: float
    missed_frame_count: int = 0
