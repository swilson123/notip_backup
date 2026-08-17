"""Pose estimation layer.

    ... -> AprilTag Detection -> Pose Estimation -> Multi-Tag Fusion -> ...

Takes repository-owned `TagDetection` values plus the grayscale frame
they came from, `CameraIntrinsics`, and each tag's *pose* physical size
(`config/tags.yaml`'s `known_tags[].pose_tag_size_m` -- **not**
`overall_size_m`; see that file's comments and `generated_tags/
README.md`) and produces one `TagPose` per detection whose tag ID has a
known pose size and yields a valid solve. Depends only on `models.py`.

Camera-relative, not ramp-relative: every `TagPose` this module returns
describes a tag directly in the *camera's* coordinate frame (see below).
Turning that into a position on the physical ramp -- accounting for
where each tag is actually mounted and at what angle -- is
`tag_fusion.py`'s job, not implemented yet. A tag's own yaw here is not
the ramp's heading whenever that tag is mounted at an angle to the ramp
face; do not conflate the two.

Unknown tag IDs (detected, but with no configured pose size): silently
skipped, not an error. `estimate()` simply omits them from its result --
callers (e.g. `scripts/test_apriltag_pose.py`) are expected to render
those `TagDetection`s as detection-only, with a clear "pose skipped"
label, rather than guessing a size. This is the one behavior choice this
module makes on the "unknown tag" question the milestone raised:
detection-only beats guessing (a wrong guessed size would silently scale
every downstream distance) and beats crashing the whole stream over one
unrecognized tag.

Why this module needs the raw grayscale frame, not just `TagDetection`
------------------------------------------------------------------------
`pupil-apriltags` (this module's backend, like `detector.py`'s) only
exposes pose estimation as an option on its *own* `Detector.detect()`
call (`estimate_tag_pose=True`, with `camera_params` and a single
`tag_size` applied to *every* tag found in that call) -- there is no
public "estimate the pose of this already-decoded detection" entry
point (confirmed by reading `pupil_apriltags`' bindings: pose estimation
happens inline, per raw detection, inside `Detector.detect()`'s loop,
using whatever single `tag_size` was passed to that call). Since this
ramp's tags are not all the same physical size (ids 0-3 vs id 4, see
`config/tags.yaml`), a single such call cannot correctly pose-solve
every tag when a frame has both sizes visible at once. This module
therefore keeps its own lazily-constructed `pupil_apriltags.Detector`
(separate from `detector.py`'s -- this module must not import
`detector.py`, see `docs/architecture.md`'s no-sibling-imports rule) and
calls `detect()` once per *distinct* pose size actually present among
the accepted detections passed in, matching raw results back to the
caller's `TagDetection`s by tag ID. This is exactly what "requires pose
estimation during the original detection call" (see the milestone
notes) means in practice -- the public interface
(`estimate(frame_gray, detections, intrinsics) -> list[TagPose]`) hides
all of it: nothing outside this module ever sees a `pupil_apriltags` type.

Camera coordinate convention
------------------------------------------------------------------------
This is the standard pinhole/OpenCV camera frame -- implied directly by
the `(fx, fy, cx, cy)` intrinsics themselves (the same convention
`models.CameraIntrinsics`/`camera.py` already use):
    * +X: right, in the image plane.
    * +Y: down, in the image plane.
    * +Z: forward, out of the camera, along the optical axis into the scene.
`TagPose.translation` is the tag's origin (its printed center) expressed
in this frame -- camera-relative XYZ position of the tag, in metres.
**Verified against physical hardware** (a tag panned left/right and
moved closer/farther while watching `camera_x_m`/`camera_z_m`/
`distance_m`): this axis convention and the translation values are
correct as returned by the backend, unmodified by this module.

Raw tag-local frame and why yaw/pitch/roll need a fixed correction
------------------------------------------------------------------------
`TagPose.rotation` is the rotation that carries a vector expressed in
the tag's own **raw backend** local frame into the camera frame above
(``p_camera = rotation @ p_tag_raw + translation``), exactly as returned
by the backend -- this module never remaps `rotation` itself, so it
stays useful for anyone doing their own geometry against it (e.g. this
module's own axis-drawing-adjacent math).

That raw tag-local frame is *not* the frame a human intuitively expects
when picturing "the tag's own X/Y/Z" -- confirmed empirically (not
assumed) by holding a tag approximately facing the camera and observing
the raw decoded rotation: it comes out close to
``diag(-1, -1, +1)`` (a 180 degree rotation about the tag's own raw Z
axis), not the identity. Concretely, when a tag directly faces the
camera in a normal, upright, non-mirrored orientation:
    * the backend's raw tag-local +X axis maps to the camera's **-X**
      (not +X),
    * the backend's raw tag-local +Y axis maps to the camera's **-Y**
      (not +Y),
    * the backend's raw tag-local +Z axis maps to the camera's **+Z**
      (this one already lines up with "forward, away from the camera").
Only `diag(-1, -1, +1)` is consistent with that sign pattern *and* a
valid rotation (determinant +1) -- the other two 180-degree-diagonal
possibilities would each show up as a large `roll` instead of a large
`yaw`, which is not what was observed. This is a real, checkable
property of the backend's tag-frame convention, not this codebase's
prior (and, before being checked this way, incorrect) assumption that
it was `diag(1, -1, -1)`.

`correct_tag_frame()` below applies the fixed correction
``rotation @ diag(-1, -1, 1)`` -- equivalent to negating `rotation`'s
first two columns -- before Euler extraction, so that `TagPose.yaw_deg`/
`pitch_deg`/`roll_deg` describe an *intuitive* tag-local frame instead:
one that lines up with the camera's own axes when the tag directly
faces the camera. This correction is fixed (the same matrix every time,
derived once from the backend's documented/observed convention, not
fit per-frame) and self-inverse (`diag(-1,-1,1) @ diag(-1,-1,1) ==
identity`) -- see `correct_tag_frame()`'s docstring and
`tests/test_pose.py` for the exact algebra and the empirical case this
was checked against. It only ever affects `yaw_deg`/`pitch_deg`/
`roll_deg` -- `TagPose.rotation` itself, `TagPose.translation`, and the
axis triad `visualization.draw_pose_axes()` projects are all left alone
(they were already correct; see above).

Euler angle convention
------------------------------------------------------------------------
See `rotation_matrix_to_euler_deg()` below for the exact, tested
yaw/pitch/roll decomposition this module uses, applied to the
*corrected* rotation from `correct_tag_frame()` (not the raw
`TagPose.rotation`). With that correction, a tag directly facing the
camera reports approximately yaw = pitch = roll = 0 degrees; from there:
    * panning the tag left/right (about the vertical/camera-Y axis)
      changes **yaw**,
    * tilting the tag up/down (about the horizontal/camera-X axis)
      changes **pitch**,
    * rotating the tag within its own printed plane (about the camera-Z/
      optical axis) changes **roll**.
"""
from __future__ import annotations

import logging
import math
from collections.abc import Mapping
from typing import Any

import numpy as np

from .models import CameraIntrinsics, TagDetection, TagPose

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class PoseEstimationError(Exception):
    """Base class for every error this module raises."""


class PoseBackendUnavailableError(PoseEstimationError):
    """Raised when pose estimation is used but `pupil-apriltags` is not installed."""


class InvalidCameraIntrinsicsError(PoseEstimationError):
    """Raised when `CameraIntrinsics` has a non-positive/non-finite focal
    length, or a non-finite principal point."""


class InvalidTagSizeError(PoseEstimationError):
    """Raised when a configured tag pose size is not a positive, finite number."""


class InvalidTagImageError(PoseEstimationError):
    """Raised when `estimate()` is given an image that isn't a valid grayscale frame."""


class PoseSolveError(PoseEstimationError):
    """Raised when the underlying pose backend fails to construct/run, or
    the whole call's output is malformed. A single malformed *per-tag*
    result does not raise this -- see `estimate()`, which logs and skips
    just that tag instead."""


# ---------------------------------------------------------------------------
# Euler angle conversion
# ---------------------------------------------------------------------------

_GIMBAL_LOCK_EPSILON = 1e-6


def rotation_matrix_to_euler_deg(rotation: np.ndarray) -> tuple[float, float, float]:
    """Decompose *rotation* into ``(yaw_deg, pitch_deg, roll_deg)``.

    Describes the orientation of the tag's own local frame *relative to
    the camera* (not the reverse) -- i.e. this decomposes `TagPose.
    rotation` directly, with no transpose/inverse applied.

    Convention: intrinsic Tait-Bryan Z-Y-X ("aerospace" yaw-pitch-roll),
    meaning *rotation* is treated as::

        rotation == Rz(yaw) @ Ry(pitch) @ Rx(roll)

    i.e. picture starting aligned with the camera axes, then rotating by
    *roll* about the (camera) X axis, then by *pitch* about the
    once-rotated Y axis, then by *yaw* about the twice-rotated Z axis, to
    reach *rotation*. All three follow the right-hand rule about their
    respective camera axis (thumb along +axis, fingers curl toward
    positive rotation) -- e.g. positive yaw rotates the camera's +X
    (right) axis toward +Y (down).

    Extraction (standard for this decomposition, re-derived and checked
    against `tests/test_pose.py`'s known-matrix cases rather than copied
    unchecked)::

        pitch = asin(-rotation[2, 0])
        yaw   = atan2(rotation[1, 0], rotation[0, 0])
        roll  = atan2(rotation[2, 1], rotation[2, 2])

    Gimbal lock (``pitch`` at or extremely near +/-90 degrees, i.e.
    ``|rotation[2, 0]| ~= 1``): yaw and roll become coupled -- only their
    sum (`pitch` = -90) or difference (`pitch` = +90) is well-defined.
    This function resolves the ambiguity by fixing ``roll = 0`` and
    folding the remaining rotation into ``yaw`` (a standard, deterministic
    convention -- see the gimbal-lock test cases for the exact identities
    this satisfies), rather than returning `nan` or raising.

    Raises:
        ValueError: *rotation* is not a `(3, 3)` array.
    """
    if rotation.shape != (3, 3):
        raise ValueError(f"rotation must have shape (3, 3), got {rotation.shape}")

    sin_pitch = float(np.clip(-rotation[2, 0], -1.0, 1.0))
    pitch = math.asin(sin_pitch)

    if abs(sin_pitch) >= 1.0 - _GIMBAL_LOCK_EPSILON:
        roll = 0.0
        yaw = math.atan2(-rotation[0, 1], rotation[1, 1])
    else:
        yaw = math.atan2(rotation[1, 0], rotation[0, 0])
        roll = math.atan2(rotation[2, 1], rotation[2, 2])

    return math.degrees(yaw), math.degrees(pitch), math.degrees(roll)


# Fixed raw-tag-frame -> intuitive-tag-frame correction -- see this
# module's "Raw tag-local frame..." docstring section for the empirical
# derivation. Self-inverse: _TAG_FRAME_CORRECTION @ _TAG_FRAME_CORRECTION
# == identity (checked in tests/test_pose.py).
_TAG_FRAME_CORRECTION = np.diag([-1.0, -1.0, 1.0])


def correct_tag_frame(rotation: np.ndarray) -> np.ndarray:
    """Apply the fixed raw-tag-frame -> intuitive-tag-frame correction.

    Returns ``rotation @ diag(-1, -1, 1)`` -- equivalently, *rotation*
    with its first two columns negated and its third column unchanged.
    Use this on a raw `TagPose.rotation` before calling
    `rotation_matrix_to_euler_deg()` if you want yaw/pitch/roll that read
    as approximately zero when the tag directly faces the camera (see
    the module docstring); `TagPoseEstimator` already does this when
    populating `TagPose.yaw_deg`/`pitch_deg`/`roll_deg`, so most callers
    never need to call this directly.

    Raises:
        ValueError: *rotation* is not a `(3, 3)` array.
    """
    if rotation.shape != (3, 3):
        raise ValueError(f"rotation must have shape (3, 3), got {rotation.shape}")
    return rotation @ _TAG_FRAME_CORRECTION


# ---------------------------------------------------------------------------
# Backend import / validation
# ---------------------------------------------------------------------------


def _import_pupil_apriltags() -> Any:
    """Import `pupil_apriltags`, raising an actionable error if it is missing."""
    try:
        import pupil_apriltags
    except ImportError as exc:
        raise PoseBackendUnavailableError(
            "pupil-apriltags is required for pose estimation but is not "
            "installed. Install the optional AprilTag extra with: "
            "pip install -e '.[apriltag]'"
        ) from exc
    return pupil_apriltags


def _validate_grayscale_image(image: np.ndarray) -> None:
    if not isinstance(image, np.ndarray):
        raise InvalidTagImageError(f"Expected a numpy.ndarray, got {type(image).__name__}.")
    if image.ndim != 2:
        raise InvalidTagImageError(
            f"Expected a 2D grayscale image, got shape {image.shape} -- convert "
            "BGR frames to grayscale before calling estimate()."
        )
    if image.dtype != np.uint8:
        raise InvalidTagImageError(f"Expected dtype uint8, got {image.dtype}.")
    height, width = image.shape
    if width == 0 or height == 0:
        raise InvalidTagImageError(f"Image has a zero dimension: shape={image.shape}.")


def _validate_intrinsics(intrinsics: CameraIntrinsics) -> None:
    if not (math.isfinite(intrinsics.fx) and intrinsics.fx > 0):
        raise InvalidCameraIntrinsicsError(
            f"CameraIntrinsics.fx must be positive and finite, got {intrinsics.fx}"
        )
    if not (math.isfinite(intrinsics.fy) and intrinsics.fy > 0):
        raise InvalidCameraIntrinsicsError(
            f"CameraIntrinsics.fy must be positive and finite, got {intrinsics.fy}"
        )
    if not math.isfinite(intrinsics.cx):
        raise InvalidCameraIntrinsicsError(
            f"CameraIntrinsics.cx must be finite, got {intrinsics.cx}"
        )
    if not math.isfinite(intrinsics.cy):
        raise InvalidCameraIntrinsicsError(
            f"CameraIntrinsics.cy must be finite, got {intrinsics.cy}"
        )


def _validate_tag_sizes(tag_sizes_m: Mapping[int, float]) -> None:
    for tag_id, size_m in tag_sizes_m.items():
        if not (math.isfinite(size_m) and size_m > 0):
            raise InvalidTagSizeError(
                f"tag_sizes_m[{tag_id}] must be a positive, finite size in "
                f"metres, got {size_m!r}"
            )


# ---------------------------------------------------------------------------
# TagPoseEstimator
# ---------------------------------------------------------------------------


class TagPoseEstimator:
    """Solves camera-frame 3D pose for each detected tag whose physical
    pose size is known.

    Backed by `pupil-apriltags`' own `estimate_tag_pose` (via
    `Detector.detect(..., estimate_tag_pose=True, ...)` -- see this
    module's docstring for why). The underlying `pupil_apriltags.
    Detector` is constructed lazily, on first `estimate()` call, exactly
    like `detector.py`'s `AprilTagDetector` -- so constructing this class
    never requires `pupil-apriltags` to be installed, only actually
    estimating a pose does.

    Keeps its *own* detector instance rather than sharing
    `AprilTagDetector`'s (this module must not import `detector.py`),
    which re-runs quad detection on the same frame with whatever
    settings *this* instance was constructed with. `quad_decimate`
    defaults to `1.0` here (full resolution) rather than
    `AprilTagDetector`'s speed-oriented default of `2.0` -- a reasonable
    standalone default -- but **a caller that also runs a primary
    `AprilTagDetector` on the same frame should construct this class
    with that detector's *same* tuning (`quad_decimate`/`quad_sigma`/
    `nthreads`/`refine_edges`/`decode_sharpening`), not just `family`/
    `tag_sizes_m`.** Two independently-tuned detector instances can
    disagree about which tags are even present in a given frame (e.g. a
    marginal/blurred tag detected by one decimation level but missed by
    the other) -- when that happens, a tag `AprilTagDetector` reports as
    detected can still come back with no `TagPose` at all, which looks
    identical to "unknown physical size" even though the tag's size
    *is* configured (see `scripts/test_ramp_geometry.py`/`scripts/
    test_apriltag_pose.py` for the fix: passing `tags_config.detector`'s
    full tuning through to both detector instances). This module cannot
    default to matching `AprilTagDetector` itself, since it has no
    handle to that instance's settings and must not import `detector.py`
    to get them (no-sibling-imports rule) -- the caller must pass them.

    `tag_sizes_m` is the deployment's fixed tag-ID -> pose-size mapping,
    in metres (from `config/tags.yaml`'s `known_tags[].pose_tag_size_m`,
    built by the caller -- this class never reads `config.py`'s YAML
    itself, matching this project's dependency-injection rule). See the
    module docstring for how an unrecognized tag ID is handled.
    """

    def __init__(
        self,
        *,
        family: str,
        tag_sizes_m: Mapping[int, float],
        quad_decimate: float = 1.0,
        quad_sigma: float = 0.0,
        nthreads: int = 2,
        refine_edges: bool = True,
        decode_sharpening: float = 0.25,
        debug: bool = False,
    ) -> None:
        _validate_tag_sizes(tag_sizes_m)
        self._family = family
        self._tag_sizes_m = dict(tag_sizes_m)
        self._quad_decimate = quad_decimate
        self._quad_sigma = quad_sigma
        self._nthreads = nthreads
        self._refine_edges = refine_edges
        self._decode_sharpening = decode_sharpening
        self._debug = debug
        self._detector: Any = None

    def estimate(
        self,
        frame_gray: np.ndarray,
        detections: list[TagDetection],
        intrinsics: CameraIntrinsics,
    ) -> list[TagPose]:
        """Return one `TagPose` per *detections* entry with a known pose
        size and a valid solve.

        Detections whose tag ID is absent from this instance's
        `tag_sizes_m` are silently omitted from the result -- not an
        error; see the module docstring. A detection whose ID *is* known
        but whose raw backend result is malformed/non-finite is logged
        and also omitted, without aborting the rest of the batch.

        Raises:
            InvalidTagImageError: *frame_gray* is not a 2D `uint8` array.
            InvalidCameraIntrinsicsError: *intrinsics* has a non-finite/
                non-positive focal length, or a non-finite principal point.
            PoseBackendUnavailableError: `pupil-apriltags` is not installed.
            PoseSolveError: the backend itself failed to construct or run.
        """
        _validate_grayscale_image(frame_gray)
        _validate_intrinsics(intrinsics)

        detections_by_id = {d.tag_id: d for d in detections if d.tag_id in self._tag_sizes_m}
        if not detections_by_id:
            return []

        image = np.ascontiguousarray(frame_gray)
        camera_params = (intrinsics.fx, intrinsics.fy, intrinsics.cx, intrinsics.cy)
        detector = self._get_or_create_detector()

        sizes_needed = sorted({self._tag_sizes_m[tag_id] for tag_id in detections_by_id})

        poses_by_id: dict[int, TagPose] = {}
        for size_m in sizes_needed:
            ids_for_size = {
                tag_id for tag_id in detections_by_id if self._tag_sizes_m[tag_id] == size_m
            }
            try:
                raw_detections = detector.detect(
                    image, estimate_tag_pose=True, camera_params=camera_params, tag_size=size_m
                )
            except Exception as exc:
                raise PoseSolveError(
                    "pupil_apriltags.Detector.detect(estimate_tag_pose=True, "
                    f"tag_size={size_m}) failed: {exc}"
                ) from exc

            for raw in raw_detections:
                tag_id = int(raw.tag_id)
                if tag_id not in ids_for_size or tag_id in poses_by_id:
                    continue
                try:
                    poses_by_id[tag_id] = _map_raw_pose(raw, detections_by_id[tag_id])
                except PoseSolveError as exc:
                    logger.warning("Skipping pose for tag id=%d: %s", tag_id, exc)

        return list(poses_by_id.values())

    def _get_or_create_detector(self) -> Any:
        if self._detector is not None:
            return self._detector

        pupil_apriltags = _import_pupil_apriltags()
        try:
            self._detector = pupil_apriltags.Detector(
                families=self._family,
                nthreads=self._nthreads,
                quad_decimate=self._quad_decimate,
                quad_sigma=self._quad_sigma,
                refine_edges=1 if self._refine_edges else 0,
                decode_sharpening=self._decode_sharpening,
                debug=1 if self._debug else 0,
            )
        except Exception as exc:
            raise PoseSolveError(
                f"Failed to construct pupil_apriltags.Detector(families={self._family!r}): {exc}"
            ) from exc
        return self._detector


def _map_raw_pose(raw: Any, detection: TagDetection) -> TagPose:
    """Map one pose-augmented `pupil_apriltags.Detection` into this
    package's `TagPose`.

    Keeps the third-party detection object entirely inside this module --
    nothing downstream ever sees a `pupil_apriltags` type.

    Raises:
        PoseSolveError: the raw translation/rotation/pose-error is the
            wrong shape or non-finite -- i.e. `estimate_tag_pose` ran but
            produced a malformed result for this one tag.
    """
    translation = np.asarray(raw.pose_t, dtype=np.float64).reshape(-1)
    rotation = np.asarray(raw.pose_R, dtype=np.float64)

    if translation.shape != (3,):
        raise PoseSolveError(
            f"Backend translation had {np.asarray(raw.pose_t).shape}, "
            "expected 3 elements."
        )
    if rotation.shape != (3, 3):
        raise PoseSolveError(f"Backend rotation had shape {rotation.shape}, expected (3, 3).")
    if not np.all(np.isfinite(translation)):
        raise PoseSolveError(f"Backend translation is not finite: {translation}")
    if not np.all(np.isfinite(rotation)):
        raise PoseSolveError(f"Backend rotation is not finite: {rotation}")

    pose_err = float(raw.pose_err) if raw.pose_err is not None else float("nan")
    if not math.isfinite(pose_err):
        raise PoseSolveError(f"Backend pose_err is not finite: {raw.pose_err!r}")

    # Euler angles use the *corrected* (intuitive) tag frame; `rotation`
    # stored below stays the raw backend value -- see the module
    # docstring for why these are deliberately different.
    yaw_deg, pitch_deg, roll_deg = rotation_matrix_to_euler_deg(correct_tag_frame(rotation))

    return TagPose(
        tag_id=int(raw.tag_id),
        translation=translation,
        rotation=rotation,
        reprojection_error=pose_err,
        timestamp=detection.timestamp,
        yaw_deg=yaw_deg,
        pitch_deg=pitch_deg,
        roll_deg=roll_deg,
        decision_margin=detection.decision_margin,
    )
