"""Debug visualization utilities.

Not part of the linear pipeline (`camera.py` through
`docking_controller.py`) -- this module only ever reads pipeline data
models and draws them onto a copy of a frame for human inspection. It
must never be imported by any pipeline module (including `detector.py`,
`pose.py`, and `tag_fusion.py`); the dependency only ever points from an
example/script into `visualization.py`, never the reverse, so debug
rendering can never become a hidden dependency of actual docking
behavior.

TODO(vision-docking): implement `draw_docking_state()` -- overlay
    `DockingState.phase` and the current `DockingCommand` as on-frame
    text, for recorded-run debugging.
"""
from __future__ import annotations

import logging
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum, auto

import cv2
import numpy as np

from .models import (
    CameraIntrinsics,
    DockingCommand,
    DockingState,
    GuidanceTarget,
    RampEstimate,
    TagDetection,
    TagPose,
    TagTrackingState,
    TargetQuality,
    TrackedTag,
)

logger = logging.getLogger(__name__)

_EDGE_COLOR_BGR = (0, 255, 0)
_CORNER_COLOR_BGR = (0, 0, 255)
_CENTER_COLOR_BGR = (255, 0, 0)
_LABEL_COLOR_BGR = (0, 255, 255)

# X=red, Y=green, Z=blue -- the common OpenCV/RViz axis-color convention.
_POSE_AXIS_COLORS_BGR = ((0, 0, 255), (0, 255, 0), (255, 0, 0))
_POSE_TEXT_COLOR_BGR = (0, 255, 255)

_RAMP_ENTRANCE_COLOR_BGR = (255, 255, 0)  # cyan
_RAMP_MIDDLE_COLOR_BGR = (0, 255, 255)  # yellow
_RAMP_TOP_COLOR_BGR = (0, 165, 255)  # orange
_RAMP_CENTERLINE_COLOR_BGR = (255, 0, 255)  # magenta
_RAMP_EDGE_COLOR_BGR = (200, 200, 200)  # light gray
_RAMP_TEXT_COLOR_BGR = (255, 255, 255)  # white

_GUIDANCE_EXACT_COLOR_BGR = (0, 0, 255)  # red -- EXACT staging point/line
_GUIDANCE_PROVISIONAL_COLOR_BGR = (0, 255, 255)  # yellow -- PROVISIONAL staging point/line
_GUIDANCE_TEXT_COLOR_BGR = (255, 255, 255)  # white
_GUIDANCE_RAMP_TAG_COLOR_BGR = (0, 255, 0)  # green -- highlights ids 0/1/2 among all tags
_GUIDANCE_EXACT_ENTRANCE_COLOR_BGR = (255, 0, 128)  # purple-pink -- EXACT entrance (tag 0)
_GUIDANCE_PROVISIONAL_ENTRANCE_COLOR_BGR = (128, 0, 255)  # violet -- PROVISIONAL entrance
_GUIDANCE_GROUND_ENTRANCE_COLOR_BGR = (0, 200, 255)  # gold -- ground-projected entrance point

_BEARING_TEXT_COLOR_BGR = (255, 255, 255)  # white -- the prominent bearing/quality readout
_BEARING_ARROW_COLOR_BGR = (255, 255, 255)  # white -- camera-to-target direction indicator

# ---------------------------------------------------------------------------
# Navigation HUD (clean default view) -- see draw_navigation_*() below
# ---------------------------------------------------------------------------
#
# Three segments, three colors, by segment *identity* (fixed ramp / fixed
# alignment / flexible approach) -- not by EXACT/PROVISIONAL quality, which
# is now expressed as a color *override* shared by both fixed segments
# (see `_SEGMENT_PROVISIONAL_COLOR_BGR`) rather than by dashing (dashing
# now means only one thing: "this segment is the flexible one").

# green -- ENTRANCE -> TOP, "RAMP CENTERLINE" (fixed)
_SEGMENT_RAMP_COLOR_BGR = (0, 255, 0)
# yellow -- STAGING -> ENTRANCE, "FINAL ALIGNMENT" (fixed)
_SEGMENT_ALIGNMENT_COLOR_BGR = (0, 255, 255)
# white -- ROVER -> STAGING, "APPROACH" (flexible, dashed)
_SEGMENT_APPROACH_COLOR_BGR = (255, 255, 255)
# orange -- entrance is estimated, not observed (both fixed segments switch to this)
_SEGMENT_PROVISIONAL_COLOR_BGR = (0, 140, 255)

_ROVER_ORIGIN_COLOR_BGR = (255, 255, 255)  # white -- rover/camera origin marker
_NAV_ENTRANCE_COLOR_BGR = _GUIDANCE_GROUND_ENTRANCE_COLOR_BGR  # gold -- entrance landmark
_NAV_TOP_COLOR_BGR = _RAMP_TOP_COLOR_BGR  # orange -- top-center landmark
_NAV_MIDDLE_DIAGNOSTIC_COLOR_BGR = (150, 150, 150)  # subtle gray -- id 1, diagnostic only
_NAV_LOOKAHEAD_COLOR_BGR = (255, 0, 255)  # magenta -- debug lookahead point (geometry only)
_HUD_BG_COLOR_BGR = (20, 20, 20)  # near-black -- translucent panel background
_HUD_TEXT_COLOR_BGR = (255, 255, 255)  # white -- HUD/legend/inset text


def draw_tag_detections(frame_bgr: np.ndarray, detections: list[TagDetection]) -> np.ndarray:
    """Return a copy of *frame_bgr* with each detection's outline and label drawn.

    Never mutates *frame_bgr* -- every draw call below operates on
    *annotated*, a copy made up front.

    For each detection, draws:
        * the four tag edges (green), connecting `corners` in order,
        * a small numbered marker (0-3) at each corner, in `corners`
          order -- lets a viewer visually verify corner ordering,
        * the tag center (blue dot),
        * a text label with the tag ID and decision margin.
    """
    annotated: np.ndarray = frame_bgr.copy()
    for detection in detections:
        _draw_one_detection(annotated, detection)
    return annotated


def _draw_one_detection(frame_bgr: np.ndarray, detection: TagDetection) -> None:
    corners = detection.corners.astype(np.int32)

    for i in range(4):
        start = _as_point(corners[i])
        end = _as_point(corners[(i + 1) % 4])
        cv2.line(frame_bgr, start, end, _EDGE_COLOR_BGR, 2)

    for i, corner in enumerate(corners):
        point = _as_point(corner)
        cv2.circle(frame_bgr, point, 4, _CORNER_COLOR_BGR, -1)
        cv2.putText(
            frame_bgr, str(i), (point[0] + 5, point[1] + 5),
            cv2.FONT_HERSHEY_SIMPLEX, 0.4, _CORNER_COLOR_BGR, 1,
        )

    center = (int(round(detection.center[0])), int(round(detection.center[1])))
    cv2.circle(frame_bgr, center, 5, _CENTER_COLOR_BGR, -1)

    label = f"id={detection.tag_id} margin={detection.decision_margin:.1f}"
    cv2.putText(
        frame_bgr, label, (center[0] + 8, center[1] - 8),
        cv2.FONT_HERSHEY_SIMPLEX, 0.5, _LABEL_COLOR_BGR, 1,
    )


def _as_point(corner: np.ndarray) -> tuple[int, int]:
    return int(corner[0]), int(corner[1])


# ---------------------------------------------------------------------------
# Per-tag camera-relative pose overlay
# ---------------------------------------------------------------------------


def translation_text(pose: TagPose) -> str:
    """Return a one-line camera-relative X/Y/Z string, e.g.
    ``"X=+0.120m Y=-0.045m Z=1.203m"`` (see `pose.py` for the axis
    convention: X right, Y down, Z forward)."""
    return f"X={pose.camera_x_m:+.3f}m Y={pose.camera_y_m:+.3f}m Z={pose.camera_z_m:+.3f}m"


def distance_text(pose: TagPose) -> str:
    """Return a one-line straight-line distance string, e.g. ``"dist=1.203m"``."""
    return f"dist={pose.distance_m:.3f}m"


def euler_text(pose: TagPose) -> str:
    """Return a one-line yaw/pitch/roll string, in degrees (see
    `pose.rotation_matrix_to_euler_deg()` for the exact convention)."""
    return f"yaw={pose.yaw_deg:+.1f} pitch={pose.pitch_deg:+.1f} roll={pose.roll_deg:+.1f}"


def role_and_size_text(tag_id: int, role: str | None, pose_size_m: float | None) -> str:
    """Return a one-line ``"id, role, pose size"`` label, omitting parts
    that are `None` (e.g. an unrecognized tag with no configured size)."""
    parts = [f"id={tag_id}"]
    if role:
        parts.append(role)
    if pose_size_m is not None:
        parts.append(f"size={pose_size_m * 100.0:.2f}cm")
    return "  ".join(parts)


def raw_pose_lines(pose: TagPose) -> list[str]:
    """Return text lines showing *pose*'s raw translation vector and raw
    3x3 rotation matrix exactly as returned by the pose backend, with no
    Euler conversion or tag-frame correction applied (see `pose.py`'s
    module docstring for why `yaw_deg`/`pitch_deg`/`roll_deg` use a
    *corrected* tag frame that `rotation` itself does not) -- for
    debugging the pose pipeline itself, independent of `euler_text()`'s
    corrected angles."""
    t = pose.translation
    r = pose.rotation
    return [
        "raw pose (pre-correction):",
        f"  t=[{t[0]:+.4f} {t[1]:+.4f} {t[2]:+.4f}]",
        f"  R0=[{r[0, 0]:+.3f} {r[0, 1]:+.3f} {r[0, 2]:+.3f}]",
        f"  R1=[{r[1, 0]:+.3f} {r[1, 1]:+.3f} {r[1, 2]:+.3f}]",
        f"  R2=[{r[2, 0]:+.3f} {r[2, 1]:+.3f} {r[2, 2]:+.3f}]",
    ]


def _project_point(
    point_camera: np.ndarray, intrinsics: CameraIntrinsics
) -> tuple[int, int] | None:
    """Project a camera-frame 3D point to pixel coordinates using the
    pinhole model (no distortion correction -- adequate for a debug
    overlay). Returns `None` if the point is at or behind the camera."""
    x, y, z = float(point_camera[0]), float(point_camera[1]), float(point_camera[2])
    if z <= 1e-6:
        return None
    u = intrinsics.fx * (x / z) + intrinsics.cx
    v = intrinsics.fy * (y / z) + intrinsics.cy
    return int(round(u)), int(round(v))


def draw_pose_axes(
    frame_bgr: np.ndarray,
    pose: TagPose,
    intrinsics: CameraIntrinsics,
    *,
    axis_length_m: float = 0.05,
) -> np.ndarray:
    """Return a copy of *frame_bgr* with *pose*'s coordinate-axis triad
    drawn at its origin (tag center), projected via *intrinsics*.

    Axis colors: X=red, Y=green, Z=blue (BGR), the common OpenCV/RViz
    convention. Draws nothing (returns an unmodified copy) if the tag's
    origin projects behind the camera.
    """
    annotated: np.ndarray = frame_bgr.copy()
    _draw_axes_inplace(annotated, pose, intrinsics, axis_length_m)
    return annotated


def _draw_axes_inplace(
    frame_bgr: np.ndarray, pose: TagPose, intrinsics: CameraIntrinsics, axis_length_m: float
) -> tuple[int, int] | None:
    origin_px = _project_point(pose.translation, intrinsics)
    if origin_px is None:
        return None
    for axis_index, color in enumerate(_POSE_AXIS_COLORS_BGR):
        direction = pose.rotation[:, axis_index]
        tip = pose.translation + axis_length_m * direction
        tip_px = _project_point(tip, intrinsics)
        if tip_px is not None:
            cv2.line(frame_bgr, origin_px, tip_px, color, 2)
    return origin_px


def draw_tag_poses(
    frame_bgr: np.ndarray,
    poses: list[TagPose],
    intrinsics: CameraIntrinsics,
    *,
    roles: Mapping[int, str] | None = None,
    tag_sizes_m: Mapping[int, float] | None = None,
    axis_length_m: float = 0.05,
) -> np.ndarray:
    """Return a copy of *frame_bgr* with each pose's axis triad and a text
    block (role/size, translation, distance, Euler angles, decision
    margin, pose error) drawn near its origin.

    Never mutates *frame_bgr*. *roles*/*tag_sizes_m* are both optional --
    pass the same tag-id-keyed mappings the caller already built from
    `config/tags.yaml`'s `known_tags` to label each tag's mounted role
    and the physical size its pose was solved against.
    """
    annotated: np.ndarray = frame_bgr.copy()
    for pose in poses:
        _draw_one_pose(annotated, pose, intrinsics, roles, tag_sizes_m, axis_length_m)
    return annotated


def _draw_one_pose(
    frame_bgr: np.ndarray,
    pose: TagPose,
    intrinsics: CameraIntrinsics,
    roles: Mapping[int, str] | None,
    tag_sizes_m: Mapping[int, float] | None,
    axis_length_m: float,
) -> None:
    origin_px = _draw_axes_inplace(frame_bgr, pose, intrinsics, axis_length_m)
    if origin_px is None:
        return

    role = roles.get(pose.tag_id) if roles else None
    pose_size_m = tag_sizes_m.get(pose.tag_id) if tag_sizes_m else None
    lines = [
        role_and_size_text(pose.tag_id, role, pose_size_m),
        translation_text(pose),
        distance_text(pose),
        euler_text(pose),
        f"margin={pose.decision_margin:.1f} err={pose.reprojection_error:.4f}",
        *raw_pose_lines(pose),
    ]
    x, y = origin_px[0] + 10, origin_px[1] + 20
    for i, line in enumerate(lines):
        cv2.putText(
            frame_bgr, line, (x, y + i * 16),
            cv2.FONT_HERSHEY_SIMPLEX, 0.45, _POSE_TEXT_COLOR_BGR, 1, cv2.LINE_AA,
        )


# ---------------------------------------------------------------------------
# Tag tracking status overlay
# ---------------------------------------------------------------------------


_TAG_TRACKING_STATE_COLOR_BGR = {
    TagTrackingState.LIVE: (0, 255, 0),  # green -- observed this frame
    TagTrackingState.HELD: (0, 165, 255),  # orange -- temporarily reused
    TagTrackingState.LOST: (0, 0, 255),  # red -- no pose this frame
}


def tag_tracking_summary_lines(tracked_tags: list[TrackedTag]) -> list[str]:
    """Return one line per tracked tag, e.g. ``"ID 0: LIVE"`` /
    ``"ID 1: HELD"`` / ``"ID 2: LOST"``, in *tracked_tags* order -- a
    pure function, no image/cv2 involved, so it's directly unit-testable
    without a frame. See `tag_tracking.py`'s module docstring for what
    each state means."""
    return [f"ID {tracked.tag_id}: {tracked.state.value}" for tracked in tracked_tags]


def draw_tag_tracking_status(
    frame_bgr: np.ndarray,
    tracked_tags: list[TrackedTag],
    intrinsics: CameraIntrinsics,
    *,
    origin: tuple[int, int] = (10, 400),
) -> np.ndarray:
    """Return a copy of *frame_bgr* with `tag_tracking_summary_lines()`'s
    text drawn -- one line per tracked tag, colored by state (green
    `LIVE`, orange `HELD`, red `LOST`) -- plus a small marker at each
    `LIVE`/`HELD` tag's current pose position: a solid-filled circle for
    `LIVE`, a hollow (unfilled) circle for `HELD`, so a held pose is
    visually unmistakable from a directly-observed one even at a glance.
    `LOST` tags have no pose to project, so only their text line
    appears. Never mutates *frame_bgr*.
    """
    annotated: np.ndarray = frame_bgr.copy()

    for tracked in tracked_tags:
        if tracked.pose is None:
            continue
        tag_px = _project_point(tracked.pose.translation, intrinsics)
        if tag_px is None:
            continue
        color = _TAG_TRACKING_STATE_COLOR_BGR[tracked.state]
        thickness = -1 if tracked.state is TagTrackingState.LIVE else 2
        cv2.circle(annotated, tag_px, 12, color, thickness)

    for i, tracked in enumerate(tracked_tags):
        color = _TAG_TRACKING_STATE_COLOR_BGR[tracked.state]
        cv2.putText(
            annotated, f"ID {tracked.tag_id}: {tracked.state.value}",
            (origin[0], origin[1] + i * 20),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2, cv2.LINE_AA,
        )

    return annotated


def ramp_summary_lines(ramp_estimate: RampEstimate) -> list[str]:
    """Return text lines summarizing *ramp_estimate*'s scalar
    diagnostics (validity, confidence, supporting tags, deployed length,
    heading, pitch, width, middle-pair axis offset, reason) -- a pure
    function, no image/cv2 involved, so it's directly unit-testable
    without a frame."""
    lines = [
        f"ramp: valid={ramp_estimate.valid} confidence={ramp_estimate.confidence:.2f}",
        f"supporting_ids={ramp_estimate.supporting_tag_ids}",
    ]
    if ramp_estimate.deployed_length_m is not None:
        lines.append(f"deployed_length={ramp_estimate.deployed_length_m:.3f}m")
    if ramp_estimate.heading_deg is not None:
        lines.append(f"heading={ramp_estimate.heading_deg:+.1f}deg")
    if ramp_estimate.pitch_deg is not None:
        lines.append(f"pitch={ramp_estimate.pitch_deg:+.1f}deg")
    lines.append(f"width={ramp_estimate.width_m:.3f}m")
    if ramp_estimate.middle_perpendicular_distance_m is not None:
        lines.append(f"middle_axis_offset={ramp_estimate.middle_perpendicular_distance_m:.3f}m")
    lines.append(f"reason: {ramp_estimate.reason}")
    return lines


def _draw_edge_inplace(
    frame_bgr: np.ndarray,
    left_m: np.ndarray | None,
    right_m: np.ndarray | None,
    intrinsics: CameraIntrinsics,
) -> None:
    if left_m is None or right_m is None:
        return
    left_px = _project_point(left_m, intrinsics)
    right_px = _project_point(right_m, intrinsics)
    if left_px is not None:
        cv2.circle(frame_bgr, left_px, 5, _RAMP_EDGE_COLOR_BGR, -1)
    if right_px is not None:
        cv2.circle(frame_bgr, right_px, 5, _RAMP_EDGE_COLOR_BGR, -1)
    if left_px is not None and right_px is not None:
        cv2.line(frame_bgr, left_px, right_px, _RAMP_EDGE_COLOR_BGR, 1)


def draw_ramp_estimate(
    frame_bgr: np.ndarray,
    ramp_estimate: RampEstimate,
    intrinsics: CameraIntrinsics,
) -> np.ndarray:
    """Return a copy of *frame_bgr* with *ramp_estimate*'s available
    landmarks, centerline, outside edges, and a diagnostic text summary
    drawn.

    The centerline drawn is **always** the single, straight
    entrance-to-top segment -- the middle point never bends it (see
    `tag_fusion.py`'s module docstring, "Three-tag centerline model"
    section). The middle point is drawn as its own marker plus, when its
    projection onto the centerline is known
    (`middle_distance_along_centerline_m`), a short connector line to
    that projection -- a visual read of `middle_perpendicular_distance_m`,
    not a second path segment.

    Draws only whichever fields are not `None` -- a partial (entrance-
    only or top-only) estimate is drawn partially, never padded out
    with a fabricated point. Never mutates *frame_bgr*.
    """
    annotated: np.ndarray = frame_bgr.copy()

    entrance_px = (
        _project_point(ramp_estimate.entrance_center_m, intrinsics)
        if ramp_estimate.entrance_center_m is not None
        else None
    )
    middle_px = (
        _project_point(ramp_estimate.middle_center_m, intrinsics)
        if ramp_estimate.middle_center_m is not None
        else None
    )
    top_px = (
        _project_point(ramp_estimate.top_center_m, intrinsics)
        if ramp_estimate.top_center_m is not None
        else None
    )

    if entrance_px is not None:
        cv2.circle(annotated, entrance_px, 8, _RAMP_ENTRANCE_COLOR_BGR, -1)
        cv2.putText(
            annotated, "entrance", (entrance_px[0] + 10, entrance_px[1]),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, _RAMP_ENTRANCE_COLOR_BGR, 2,
        )
    if middle_px is not None:
        cv2.circle(annotated, middle_px, 8, _RAMP_MIDDLE_COLOR_BGR, -1)
        cv2.putText(
            annotated, "middle", (middle_px[0] + 10, middle_px[1]),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, _RAMP_MIDDLE_COLOR_BGR, 2,
        )
    if top_px is not None:
        cv2.circle(annotated, top_px, 8, _RAMP_TOP_COLOR_BGR, -1)
        cv2.putText(
            annotated, "top", (top_px[0] + 10, top_px[1]),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, _RAMP_TOP_COLOR_BGR, 2,
        )

    # The one and only centerline segment -- never routed through middle_px.
    if entrance_px is not None and top_px is not None:
        cv2.line(annotated, entrance_px, top_px, _RAMP_CENTERLINE_COLOR_BGR, 2)

    # Optional error-visualization line: middle point -> its projection
    # onto the centerline. Purely diagnostic, drawn thin/gray to read as
    # distinct from the primary centerline and the middle marker.
    if (
        middle_px is not None
        and ramp_estimate.middle_distance_along_centerline_m is not None
        and ramp_estimate.entrance_center_m is not None
        and ramp_estimate.centerline_direction is not None
    ):
        projected_point_m = (
            ramp_estimate.entrance_center_m
            + ramp_estimate.middle_distance_along_centerline_m
            * ramp_estimate.centerline_direction
        )
        projected_px = _project_point(projected_point_m, intrinsics)
        if projected_px is not None:
            cv2.line(annotated, middle_px, projected_px, _RAMP_EDGE_COLOR_BGR, 1)

    _draw_edge_inplace(
        annotated, ramp_estimate.entrance_left_m, ramp_estimate.entrance_right_m, intrinsics
    )
    _draw_edge_inplace(annotated, ramp_estimate.top_left_m, ramp_estimate.top_right_m, intrinsics)

    for i, line in enumerate(ramp_summary_lines(ramp_estimate)):
        cv2.putText(
            annotated, line, (10, 30 + i * 20),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, _RAMP_TEXT_COLOR_BGR, 1, cv2.LINE_AA,
        )

    return annotated


def _entrance_source_text(quality: TargetQuality, supporting_tag_ids: tuple[int, ...]) -> str:
    """Describe exactly what produced the current staging entrance --
    distinct from `quality` alone, since `PROVISIONAL` covers several
    genuinely different tag combinations that a viewer must be able to
    tell apart (see `guidance.py`'s module docstring, "Single-tag
    reconstruction is PROVISIONAL, not EXACT")."""
    if quality is TargetQuality.INVALID:
        return "none"
    if supporting_tag_ids == (0, 2):
        return "ids [0,2]"
    if supporting_tag_ids == (0, 1):
        return "ids [0,1] fallback"
    if supporting_tag_ids == (1, 2):
        return "ids [1,2] fallback"
    if supporting_tag_ids == (0,):
        return "id [0] fallback"
    if supporting_tag_ids == (1,):
        return "id [1] fallback"
    if supporting_tag_ids == (2,):
        return "id [2] fallback"
    return "unknown"


def _ramp_geometry_quality_text(ramp_estimate: RampEstimate) -> str:
    """`EXACT`/`PROVISIONAL`/`INVALID` for *ramp_estimate*'s own
    reconstruction, derived purely from its existing `valid`/
    `supporting_tag_ids` fields -- no separate quality field exists on
    `RampEstimate` itself (see `tag_fusion.py`'s module docstring,
    "Three-tag centerline model" section, for why): `EXACT` iff both
    authoritative endpoint tags (ids 0 and 2) contributed, `PROVISIONAL`
    iff valid but not both, `INVALID` iff not valid at all."""
    if not ramp_estimate.valid:
        return "INVALID"
    if {0, 2} <= set(ramp_estimate.supporting_tag_ids):
        return "EXACT"
    return "PROVISIONAL"


def _ramp_entrance_source_text(ramp_estimate: RampEstimate) -> str:
    """`TAG 0` when the entrance was directly observed, `ESTIMATED`
    when it was reconstructed from id 1 and/or id 2 instead, `N/A` when
    there is no entrance at all this frame."""
    if not ramp_estimate.valid or ramp_estimate.entrance_center_m is None:
        return "N/A"
    return "TAG 0" if 0 in ramp_estimate.supporting_tag_ids else "ESTIMATED"


def _ramp_top_source_text(ramp_estimate: RampEstimate) -> str:
    """`TAG 2` when the top was directly observed, `ESTIMATED` when it
    was reconstructed from id 0 and/or id 1 instead, `N/A` when there is
    no top at all this frame."""
    if not ramp_estimate.valid or ramp_estimate.top_center_m is None:
        return "N/A"
    return "TAG 2" if 2 in ramp_estimate.supporting_tag_ids else "ESTIMATED"


def _ramp_centerline_source_text(ramp_estimate: RampEstimate) -> str:
    """Which visible ramp-centerline tag(s) the current centerline
    direction actually came from -- fully recoverable from
    `supporting_tag_ids` alone, since each of `tag_fusion.py`'s seven
    visibility cases produces a distinct combination (see that module's
    docstring, "Geometry authority" section)."""
    if not ramp_estimate.valid or ramp_estimate.centerline_direction is None:
        return "N/A"
    ids = set(ramp_estimate.supporting_tag_ids)
    if {0, 2} <= ids:
        return "TAG 0 + TAG 2"
    if {0, 1} <= ids:
        return "TAG 0 + TAG 1"
    if {1, 2} <= ids:
        return "TAG 1 + TAG 2"
    if 0 in ids:
        return "TAG 0 (heading)"
    if 1 in ids:
        return "TAG 1 (heading)"
    if 2 in ids:
        return "TAG 2 (heading)"
    return "N/A"


def guidance_summary_lines(guidance_target: GuidanceTarget) -> list[str]:
    """Return text lines summarizing *guidance_target*'s diagnostics --
    staging quality, source tags, confidence, entrance source, approach
    heading, entrance center, staging distance/bearing, ground-plane
    height, and the reason -- a pure function, no image/cv2 involved."""
    entrance_source = _entrance_source_text(
        guidance_target.quality, guidance_target.supporting_tag_ids
    )
    lines = [
        f"STAGING: {guidance_target.quality.name}",
        f"SOURCE TAGS: {list(guidance_target.supporting_tag_ids)}",
        f"TARGET CONFIDENCE: {guidance_target.confidence:.2f}",
        f"ENTRANCE SOURCE: {entrance_source}",
    ]
    if guidance_target.approach_heading_deg is not None:
        lines.append(f"Approach heading estimate: {guidance_target.approach_heading_deg:+.1f} deg")
    if guidance_target.entrance_center_m is not None:
        x, y, z = guidance_target.entrance_center_m
        lines.append(f"Entrance center: [{x:+.3f}, {y:+.3f}, {z:+.3f}] m")
    if guidance_target.staging_distance_m is not None:
        lines.append(f"Staging distance: {guidance_target.staging_distance_m:.3f} m")
    if guidance_target.target_bearing_deg is not None:
        lines.append(f"Staging bearing: {guidance_target.target_bearing_deg:+.1f} deg")
    if guidance_target.ground_plane_height_m is not None:
        lines.append(f"Ground-plane height: {guidance_target.ground_plane_height_m:.3f} m")
    lines.append(f"reason: {guidance_target.reason}")
    return lines


def draw_guidance_target(
    frame_bgr: np.ndarray,
    guidance_target: GuidanceTarget,
    tag_poses: list[TagPose],
    intrinsics: CameraIntrinsics,
    *,
    text_origin: tuple[int, int] = (10, 200),
) -> np.ndarray:
    """Return a copy of *frame_bgr* with the ramp-centerline tags (ids
    0-2, highlighted among whatever *tag_poses* contains), the entrance
    point (styled per `quality` -- see below), the ground-projected
    entrance point, the staging point, an arrowed line from the ground
    entrance to the staging point (doubling as the horizontal-approach-
    direction indicator), and a short diagnostic text summary drawn.

    **EXACT and PROVISIONAL targets are drawn with a deliberately
    different color** (`_GUIDANCE_EXACT_COLOR_BGR` vs.
    `_GUIDANCE_PROVISIONAL_COLOR_BGR`, applied to the staging point, its
    connector line, and the entrance marker) so a `PROVISIONAL` estimate
    (ids 0 and 2 not simultaneously visible) is visually unmistakable
    from a directly-observed `EXACT` one. The staging point is always
    drawn as a hollow circle (unlike the ramp's solid-filled landmark
    markers in `draw_ramp_estimate()`) to read as a *virtual*, computed
    point rather than a directly observed one. Only one line connects
    entrance to staging point (an arrow, not a separate direction
    indicator plus a separate connector) to avoid drawing two redundant,
    overlapping segments.

    `text_origin` defaults to sit below `draw_ramp_estimate()`'s text
    block (which uses at most ~8 lines starting at y=30) so the two
    overlays don't collide when both are drawn on the same frame, as
    `scripts/test_ramp_geometry.py` does -- pass a different origin if
    composing them differently.

    Draws only whichever points are not `None` -- an invalid frame
    still draws the text summary and any ramp-centerline tags present in
    *tag_poses*, but never a fabricated entrance/staging point. Never
    mutates *frame_bgr*.
    """
    annotated: np.ndarray = frame_bgr.copy()

    for pose in tag_poses:
        if pose.tag_id not in (0, 1, 2):
            continue
        tag_px = _project_point(pose.translation, intrinsics)
        if tag_px is None:
            continue
        cv2.circle(annotated, tag_px, 10, _GUIDANCE_RAMP_TAG_COLOR_BGR, 2)
        cv2.putText(
            annotated, f"ID{pose.tag_id}", (tag_px[0] + 10, tag_px[1] + 20),
            cv2.FONT_HERSHEY_SIMPLEX, 0.45, _GUIDANCE_RAMP_TAG_COLOR_BGR, 1,
        )

    if guidance_target.quality is TargetQuality.PROVISIONAL:
        entrance_color = _GUIDANCE_PROVISIONAL_ENTRANCE_COLOR_BGR
        entrance_label = "provisional entrance (estimated)"
        staging_color = _GUIDANCE_PROVISIONAL_COLOR_BGR
        staging_label = "staging point (PROVISIONAL)"
    else:
        entrance_color = _GUIDANCE_EXACT_ENTRANCE_COLOR_BGR
        entrance_label = "entrance (tag 0)"
        staging_color = _GUIDANCE_EXACT_COLOR_BGR
        staging_label = "staging point (EXACT)"

    midpoint_px = (
        _project_point(guidance_target.entrance_center_m, intrinsics)
        if guidance_target.entrance_center_m is not None
        else None
    )
    if midpoint_px is not None:
        cv2.circle(annotated, midpoint_px, 6, entrance_color, -1)
        cv2.putText(
            annotated, entrance_label, (midpoint_px[0] + 10, midpoint_px[1]),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, entrance_color, 2,
        )

    ground_entrance_px = (
        _project_point(guidance_target.entrance_ground_point_camera_m, intrinsics)
        if guidance_target.entrance_ground_point_camera_m is not None
        else None
    )
    if ground_entrance_px is not None:
        cv2.circle(annotated, ground_entrance_px, 6, _GUIDANCE_GROUND_ENTRANCE_COLOR_BGR, -1)
        cv2.putText(
            annotated, "entrance (ground)",
            (ground_entrance_px[0] + 10, ground_entrance_px[1] + 18),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, _GUIDANCE_GROUND_ENTRANCE_COLOR_BGR, 2,
        )

    target_px = (
        _project_point(guidance_target.target_point_camera_m, intrinsics)
        if guidance_target.target_point_camera_m is not None
        else None
    )
    if target_px is not None:
        cv2.circle(annotated, target_px, 8, staging_color, 2)
        cv2.putText(
            annotated, staging_label, (target_px[0] + 10, target_px[1]),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, staging_color, 2,
        )

    if ground_entrance_px is not None and target_px is not None:
        cv2.arrowedLine(annotated, ground_entrance_px, target_px, staging_color, 2, tipLength=0.08)

    for i, line in enumerate(guidance_summary_lines(guidance_target)):
        cv2.putText(
            annotated, line, (text_origin[0], text_origin[1] + i * 20),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, _GUIDANCE_TEXT_COLOR_BGR, 1, cv2.LINE_AA,
        )

    return annotated


def _degrees_text(value_deg: float | None) -> str:
    return f"{value_deg:+.1f} deg" if value_deg is not None else "N/A"


def _metres_text(value_m: float | None) -> str:
    return f"{value_m:.2f} m" if value_m is not None else "N/A"


def _segment_distance_m(
    point_a_m: np.ndarray | None, point_b_m: np.ndarray | None
) -> float | None:
    """Plain 3D Euclidean distance between two camera-frame points, or
    `None` if either is unavailable -- used to report each `Navigation
    Path` segment's own current length, rather than pulling `Guidance
    Target.distance_to_target_m` (a separate, ground-plane-snapped
    quantity that no longer matches what this path actually draws; see
    `navigation_hud_lines()`)."""
    if point_a_m is None or point_b_m is None:
        return None
    return float(np.linalg.norm(point_a_m - point_b_m))


def bearing_summary_lines(guidance_target: GuidanceTarget) -> list[str]:
    """Return exactly five text lines -- target quality, raw bearing,
    approach heading, distance to the staging point, and confidence --
    meant to be drawn larger/more prominently than
    `guidance_summary_lines()`'s fuller diagnostic block. A pure
    function, no image/cv2 involved.

    Always returns the same five lines regardless of `quality` --
    unavailable values are rendered as ``"N/A"`` rather than omitted, so
    this block's shape never changes across EXACT/PROVISIONAL/INVALID
    frames."""
    return [
        f"TARGET QUALITY: {guidance_target.quality.name}",
        f"TARGET BEARING: {_degrees_text(guidance_target.target_bearing_deg)}",
        f"APPROACH HEADING: {_degrees_text(guidance_target.approach_heading_deg)}",
        f"DISTANCE TO STAGING: {_metres_text(guidance_target.distance_to_target_m)}",
        f"TARGET CONFIDENCE: {guidance_target.confidence:.2f}",
    ]


def _draw_bearing_arrow_inplace(frame_bgr: np.ndarray, target_bearing_deg: float | None) -> None:
    """Draw a fixed-length compass-style arrow, anchored at the bottom
    center of *frame_bgr*, pointing in the horizontal direction from the
    camera/rover (the anchor, standing in for the rover's current
    position -- see `guidance.py`'s module docstring) toward the current
    staging target. Straight up = straight ahead (bearing 0); the arrow
    tilts right of vertical for a positive bearing, left for negative --
    the same left/right sense as the frame itself, since camera +X
    (right) is also positive bearing. Draws nothing when
    *target_bearing_deg* is `None` (no valid target to point toward).

    This is deliberately a fixed-length screen-space indicator, not a
    3D-projected one: the camera/rover's own position is the coordinate
    origin, which has no well-defined pinhole projection to draw at."""
    if target_bearing_deg is None:
        return
    height, width = frame_bgr.shape[:2]
    anchor = (width // 2, height - 20)
    radius = 70.0
    bearing_rad = math.radians(target_bearing_deg)
    tip = (
        int(round(anchor[0] + radius * math.sin(bearing_rad))),
        int(round(anchor[1] - radius * math.cos(bearing_rad))),
    )
    cv2.arrowedLine(frame_bgr, anchor, tip, _BEARING_ARROW_COLOR_BGR, 2, tipLength=0.3)


def draw_target_bearing(
    frame_bgr: np.ndarray,
    guidance_target: GuidanceTarget,
    *,
    text_origin: tuple[int, int] | None = None,
    show_text: bool = True,
) -> np.ndarray:
    """Return a copy of *frame_bgr* with a compass-style arrow showing the
    raw horizontal bearing from the camera/rover to `GuidanceTarget.
    target_point_camera_m` -- guidance.py's own, separately-computed,
    ground-plane-snapped staging point, **not** this module's
    `NavigationPath`/approach curve (see `_draw_bearing_arrow_inplace()`)
    -- plus, when *show_text* is `True`, `bearing_summary_lines()`'s
    five lines drawn prominently (larger font, bold).

    A raw diagnostic only: this bearing is expected to disagree with
    `desired_path_direction()`/the rover-direction arrow `draw_
    navigation_path()` draws whenever the approach curve bends (see
    that function's docstring and this module's "Navigation HUD"
    section comment) -- never treat this as the rover's authoritative
    direction. `scripts/test_ramp_geometry.py`'s clean navigation view
    no longer calls this function at all (its own rover-direction arrow
    replaced what `show_text=False` used to provide here); debug mode
    still calls it with the default `show_text=True`, as a raw,
    independent cross-check against the path.

    `text_origin` defaults to the frame's top-right corner, deliberately
    separate from `draw_ramp_estimate()`'s and `draw_guidance_target()`'s
    text blocks (both anchored top-left) so this milestone's readout
    never collides with or grows into the existing overlays. Never
    mutates *frame_bgr*.
    """
    annotated: np.ndarray = frame_bgr.copy()
    height, width = annotated.shape[:2]
    origin = text_origin if text_origin is not None else (max(10, width - 330), 30)

    if show_text:
        for i, line in enumerate(bearing_summary_lines(guidance_target)):
            cv2.putText(
                annotated, line, (origin[0], origin[1] + i * 24),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, _BEARING_TEXT_COLOR_BGR, 2, cv2.LINE_AA,
            )

    _draw_bearing_arrow_inplace(annotated, guidance_target.target_bearing_deg)

    return annotated


# ---------------------------------------------------------------------------
# Navigation HUD: three explicitly separate segments (default live-viewer
# mode) -- see `NavigationPath` and `build_navigation_path()` below.
# ---------------------------------------------------------------------------
#
# The navigation path is **three independently-owned segments**, never one
# continuous rover -> top polyline and never one shared geometry
# calculation that could let one endpoint influence another:
#
#   Segment 1 -- FIXED ramp centerline:    entrance -> top
#   Segment 2 -- FIXED staging alignment:  staging  -> entrance
#   Segment 3 -- FLEXIBLE rover approach:  rover    -> staging
#
# Segments 1 and 2 are fixed **relative to the ramp** -- once the entrance
# and ramp heading are reconstructed from the AprilTags, the rover's own
# position has *zero* influence on them (see `build_navigation_path()`:
# neither one is ever computed from `rover_point_camera_m`). Segment 3 is
# the *only* flexible one -- it is defined as wherever the rover currently
# is, to wherever staging currently is, and it is expected to change shape
# every frame as the rover moves. This is why `NavigationPath` -- not a
# polyline, not a single "path" list -- is the representation: each
# segment's own two endpoints are named fields, not adjacent elements of
# one array that some future refactor could accidentally connect straight
# through.
#
# `RampEstimate.middle_center_m` never appears in this construction at
# all -- see `draw_navigation_landmarks()` for where it's drawn (a small
# diagnostic marker only, exactly as `tag_fusion.py`'s module docstring
# already establishes for `draw_ramp_estimate()`'s centerline).
#
# **entrance_point_camera_m is the complete 3D entrance position,
# verbatim -- never ground-snapped, never Y-adjusted:**
#
#   entrance_point_camera_m = tag0.translation   # ids 0+2 or 0+1 visible
#
# directly observed at tag 0 whenever it's visible; reconstructed
# backward from tag 1 and/or tag 2 (see `tag_fusion.py`'s module
# docstring, "Three-tag centerline model" section, for the exact
# per-case formula) only when tag 0 itself isn't visible. Sourced from
# `RampEstimate.entrance_center_m` (the tag_fusion-authoritative
# reconstruction) when available, falling back to `GuidanceTarget.
# entrance_center_m` (also verbatim) only when no fused entrance exists
# at all. This is the ENTRANCE landmark drawn by
# `draw_navigation_landmarks()` -- it must render directly at tag 0
# whenever tag 0 is visible, which is the easiest visual correctness
# check for this whole module. It is also the end of the fixed ramp
# centerline segment and one end of the fixed staging-alignment
# segment: there is no separate ground-projected point for either
# purpose.
#
# A previous version of this module additionally ground-snapped a
# second "entrance_ground_point" (X/Z from the entrance point, Y
# replaced by the configured `camera_height_m` ground plane) and used
# *that* for both fixed segments, keeping the raw entrance point only as
# a small diagnostic marker. That made the ENTRANCE marker drift away
# from where tag 0 actually is, which broke the module's own easiest
# correctness check. This version removes that ground projection
# entirely from the navigation path: `entrance_point_camera_m` **is**
# the entrance point, full stop. The rover/camera-to-ground mounting
# transform this was meant to approximate can be reintroduced later,
# once it's actually measured -- see `staging_point_camera_m` below for
# where the same simplification applies.
#
# **staging_point_camera_m is built directly from entrance_point_
# camera_m and the reconstructed ramp centerline (entrance -> top), not
# from `approach_heading_deg` and not from `GuidanceTarget.target_
# point_camera_m`:**
#
#   ramp_vector = top_point_camera_m - entrance_point_camera_m
#   horizontal_direction = normalize([ramp_vector[0], 0, ramp_vector[2]])
#   staging = entrance_point_camera_m - staging_distance_m * horizontal_direction
#   staging[1] = entrance_point_camera_m[1]   # same local path plane
#
# **There is exactly one authoritative centerline direction**, and it is
# this one -- computed from the *exact same two points*
# (`entrance_point_camera_m`, `top_point_camera_m`) that
# `draw_navigation_path()` draws the green ramp-centerline segment
# between. This is deliberate: it is what guarantees `STAGING ->
# ENTRANCE -> TOP` are collinear in horizontal X/Z, and that the yellow
# segment always looks like the green one simply continuing another
# `staging_distance_m` beyond the entrance -- rotate the ramp (top
# moves), and both segments rotate together, by construction, because
# they share the same two source points. Consulting `RampEstimate.
# centerline_direction` separately here would risk a second, possibly-
# divergent notion of "the centerline" (e.g. if a future `entrance_
# offset_m` calibration made `RampEstimate.entrance_center_m` disagree
# with the entrance this path actually uses); deriving it locally from
# this path's own two points instead makes that divergence structurally
# impossible.
#
# `approach_heading_deg` (the entrance's own corrected heading) is used
# for staging direction **only** as a PROVISIONAL fallback, and only
# when the ramp centerline cannot be formed at all -- `top_point_
# camera_m` is `None` (no top tag visible yet) or the ramp vector's
# horizontal component is degenerate (a perfectly vertical top,
# effectively zero horizontal length). `staging_direction_source`
# records which path was taken (`"RAMP CENTERLINE"` or `"HEADING
# FALLBACK"`), surfaced verbatim by `navigation_hud_lines()`'s `STAGING
# DIRECTION SOURCE` line. Any single tag's own pitch/yaw and
# `RampEstimate.heading_deg`/`pitch_deg` never contribute to
# `staging_point_camera_m` at all, in either case -- they remain
# available as diagnostics elsewhere, but this path never reads them.
#
# `GuidanceTarget.target_point_camera_m` is guidance.py's own staging
# point, ground-plane-snapped via the configured `camera_height_m` --
# a real quantity, kept for later use once the physical camera-to-
# rover-ground mounting transform is measured, but deliberately **not**
# what this navigation path draws today. Building staging on the *same*
# vertical plane as the entrance guarantees `distance(entrance,
# staging)` is exactly `staging_distance_m` in 3D as well as
# horizontally -- with no ground-plane height involved, there is
# nothing that could pull the two points' Y components apart. This is
# the correct simplification for *validating relative navigation
# geometry from the AprilTags* (this module's current job); it is not a
# statement about where the rover physically drives, which is a
# separate, later milestone.
#
# `top_point_camera_m` is `RampEstimate.top_center_m` verbatim, with no
# ground-projection -- id 2 is mounted at the ramp's own top platform
# (see `config/tags.yaml`), not elevated above a separate driving
# surface the way the entrance tag is.
#
# **The complete path is ONE ordered sequence, not three unrelated
# lines:** ROVER -> STAGING -> ENTRANCE -> TOP. STAGING is the mandatory
# first target -- a rover must never aim directly at ENTRANCE (a
# "shortcut" past staging) while it still hasn't reached STAGING, no
# matter how convenient that bearing might look. This module represents
# that ordering two ways:
#
#   1. `approach_points` -- the sampled ROVER -> STAGING curve is its
#      own field, entirely separate from `entrance_point_camera_m`/
#      `top_point_camera_m`. Nothing that builds it ever reads the
#      entrance or top point (see `_build_approach_points()`), so it is
#      *structurally* impossible for the approach geometry to end up
#      pointing at entrance instead of staging.
#   2. `active_section`/`next_mandatory_waypoint` -- an explicit,
#      ordered `PathSection` state (`APPROACH` -> `FINAL_ALIGNMENT` ->
#      `RAMP`) and its corresponding mandatory waypoint name
#      (`"STAGING"` -> `"ENTRANCE"` -> `"TOP"`). This is **not** decided
#      by "which waypoint is geometrically closest" -- path order is
#      authoritative, never proximity. This milestone has no reliable
#      way yet to detect "has the rover actually reached staging", so
#      `build_navigation_path()` always reports `APPROACH` (and
#      therefore `"STAGING"`) whenever a valid path exists at all --
#      see `PathSection`'s docstring for why an honest, unmoving value
#      beats inventing unreliable transition logic just to look dynamic.
#
# **The curved approach is a CONSUMER of the staging point, never a
# producer of it.** The construction order is always: reconstruct
# entrance -> reconstruct top -> build the ramp centerline -> place
# staging exactly `staging_distance_m` behind entrance along it -> only
# *then* generate the rover -> staging curve from that already-frozen
# staging point. The rover's own position may reshape the curve; it can
# never move staging itself -- see `_build_approach_points()`, which
# takes `staging_point`/`final_direction` as inputs, not things it
# computes.
#
# **Curve construction** (`_build_approach_points()`,
# `_bezier_control_points_xz()`): a cubic Bezier in horizontal camera
# X/Z space (vertical/camera-Y is handled separately, see below), built
# from exactly four control points:
#
#   P0 = rover_xz                                   (curve start)
#   P1 = P0 + handle_length_m * ROVER_FORWARD_XZ     (start handle)
#   P3 = staging_xz                                  (curve end)
#   P2 = P3 - handle_length_m * final_direction_xz   (end handle)
#
# `ROVER_FORWARD_XZ` is the constant ``(0, 1)`` -- camera +Z. **Camera
# frame == rover body frame is an explicit, documented assumption for
# this prototype** (see `guidance.py`'s own identical "rover position ==
# camera origin" assumption): the rover's current heading is *never*
# read from any AprilTag's orientation, only from this fixed axis.
# `final_direction_xz` is the horizontal (X, Z) component of whichever
# direction `staging_point_camera_m` was actually built from this frame
# (the ramp centerline, or the heading fallback -- see above) -- the
# *same* vector, passed straight through, never recomputed from tag
# yaw/pitch/heading independently. Because a cubic Bezier's tangent at
# t=0 is proportional to (P1 - P0) and at t=1 to (P3 - P2), this
# construction *is* what makes the curve start tangent to the rover's
# forward direction and end tangent to the fixed staging->entrance
# direction -- the white curve becomes tangent to the yellow line by
# construction, with no separate tangent-matching step required.
# `handle_length_m` (`_bezier_handle_length_m()`) is `ApproachPathParams.
# handle_fraction` of the straight-line rover-to-staging distance,
# clamped to `[min_handle_m, max_handle_m]`. Vertical (camera Y) is not
# part of the Bezier at all -- each sample's height is a plain linear
# blend between `rover_point_camera_m[1]` and `staging_point_camera_m[1]`
# at that sample's curve parameter `t`, a prototype-visualization
# simplification consistent with `staging_point_camera_m` itself already
# living on one flat local plane rather than a measured ground surface.
# `approach_points[0]`/`approach_points[-1]` are forced to be exactly
# `rover_point_camera_m`/`staging_point_camera_m` (the same objects),
# removing any doubt about the curve's endpoints matching this path's
# own reference points.
#
# `lookahead_point_camera_m` (`_point_along_polyline_at_distance()`) is
# a point `ApproachPathParams.lookahead_m` forward along `approach_
# points`' own arc length, clamped to `approach_points[-1]` (i.e.
# `staging_point_camera_m`) once the lookahead distance reaches the
# curve's own length -- it can *never* advance past staging onto the
# fixed alignment segment, let alone reach entrance, because it walks
# `approach_points` alone. This is geometry/visualization only for this
# milestone -- see `PathSection`'s docstring -- not yet used to issue
# any steering command; it exists so the next milestone's lookahead
# controller has a ready-made point to consume. This is a **PATH
# TANGENT** point (it lies on the curve, forward of the rover), a
# distinct concept from a **LOOKAHEAD BEARING** (the direction *to* that
# point, which a future Pure-Pursuit-style controller might steer
# toward) -- this milestone's rover-direction arrow always renders the
# local path tangent (`desired_path_direction()`, below), never a
# bearing to `lookahead_point_camera_m`.
#
# **`desired_path_direction(navigation_path, section)`** is the single
# source of truth for "which way should the rover currently point,"
# used by the rover-direction arrow, `navigation_hud_lines()`'s
# `DESIRED TRAVEL DIRECTION` line, and `_final_approach_heading_error_
# deg()` alike -- never independently recomputed from `GuidanceTarget.
# target_bearing_deg`, `approach_heading_deg`, any tag's yaw/pitch, or
# an image-space line. It reads whichever geometry the requested
# `PathSection` actually owns: `APPROACH` reads `approach_points`' own
# first two samples (the white curve's own tangent leaving the rover);
# `FINAL_ALIGNMENT` reads the fixed staging->entrance vector (the
# yellow segment); `RAMP` reads the fixed entrance->top vector,
# projected flat (the green segment). A curved approach's `APPROACH`
# direction is *not* the same as a direct bearing to staging or
# entrance -- that mismatch is expected, not a bug (see this section's
# module comment's Bezier-construction paragraphs for why the curve's
# own start tangent is what it is).


class PathSection(Enum):
    """Which ordered segment of ROVER -> STAGING -> ENTRANCE -> TOP is
    currently active. `visualization.py`-local for now, like
    `NavigationPath` itself -- a future steering milestone may promote
    this to `models.py` once a real controller consumes it.

    `APPROACH` -> `FINAL_ALIGNMENT` still never transitions in this
    repository -- there is no reliable "has the rover actually reached
    staging yet" signal yet, and inventing one just to make a HUD value
    look dynamic would be worse than a value that's honest about never
    advancing (unchanged from this enum's original milestone). `build_
    navigation_path()` reports `APPROACH` whenever a valid path exists
    and RAMP has not been entered.

    `-> RAMP` **does** now transition, via `PathProgressState`/
    `advance_path_progress()`: once the rover has been confirmed to have
    driven past the physical entrance tag (id 0) for several consecutive
    frames -- not merely "id 0 isn't visible this frame," which flickers
    -- `RAMP` becomes active and **stays** active for the rest of that
    tracked session, even if id 0 later reappears (e.g. a stray
    reflection, or the rover briefly backing up) -- see that function's
    docstring for the full debounce/stickiness rationale. Do not switch
    sections simply because another waypoint is closer in Euclidean
    distance -- path order is authoritative, never proximity.
    """

    APPROACH = auto()
    FINAL_ALIGNMENT = auto()
    RAMP = auto()


_NEXT_MANDATORY_WAYPOINT: dict[PathSection, str] = {
    PathSection.APPROACH: "STAGING",
    PathSection.FINAL_ALIGNMENT: "ENTRANCE",
    PathSection.RAMP: "TOP",
}


@dataclass(frozen=True)
class ApproachPathParams:
    """Tuning for the ROVER -> STAGING cubic-Bezier approach curve --
    `visualization.py`-local, structurally similar to (but a
    deliberately separate declaration from) `config.py`'s
    `ApproachPathConfig`; a caller (`scripts/test_ramp_geometry.py`)
    converts one into the other, exactly as `guidance.py`'s
    `StagingCalibration` already does for `config.py`'s `StagingConfig`
    (this module's "downstream-only"/no-sibling-imports convention --
    see the module docstring).

    Defaults match `config/approach_path.yaml`'s own defaults, so
    callers that don't care about tuning (most tests) can omit this
    parameter entirely. See `_build_approach_points()` for exactly how
    each field is used.
    """

    handle_fraction: float = 0.35
    min_handle_m: float = 0.20
    max_handle_m: float = 1.00
    sample_count: int = 30
    lookahead_m: float = 0.30


@dataclass(frozen=True)
class NavigationPath:
    """The rover/staging/entrance/top points that define the three
    navigation-path segments -- see this section's module comment and
    `build_navigation_path()` (the *only* place this type is
    constructed) for exactly how each point is derived.

    This is a `visualization.py`-local composition type, not a pipeline
    model: it is built purely downstream of `GuidanceTarget`/
    `RampEstimate` for rendering, and no pipeline module reads it back
    (matching this module's "downstream-only" rule -- see the module
    docstring). Every field is `None` together when `quality` is
    `INVALID` -- no segment is ever drawn from a fabricated point.

    Attributes:
        rover_point_camera_m: The rover/camera's own position, (0,
            ground_height, 0) -- always exactly the coordinate origin's
            horizontal position with its vertical component snapped to
            the configured ground plane (see `guidance.py`'s "rover
            position == camera origin" assumption). This is the *only*
            point among the four that legitimately changes with "where
            the rover is" -- and even this one is a fixed formula, never
            read back from anywhere else in this path.
        staging_point_camera_m: `entrance_point_camera_m` translated
            exactly `staging_distance_m` horizontally, opposite the
            *horizontal ramp-centerline direction* (`top_point_camera_m`
            minus `entrance_point_camera_m`, projected flat -- see
            `staging_direction_source`), with its vertical component
            forced equal to `entrance_point_camera_m`'s own -- **not**
            `GuidanceTarget.target_point_camera_m` (which is ground-
            plane-snapped via the configured `camera_height_m`; see
            this section's module comment for why that's deliberately
            not used here). Sharing the entrance's own Y guarantees
            `distance(entrance, staging)` is exactly `staging_distance_m`
            in 3D as well as horizontally, and sharing the ramp's own
            horizontal direction guarantees staging, entrance, and top
            are collinear in horizontal X/Z.
        entrance_point_camera_m: The navigation "ENTRANCE" landmark --
            the complete, verbatim 3D entrance position: tag 0's own
            translation whenever tag 0 is visible, or reconstructed from
            tags 1/2 otherwise (see `tag_fusion.py`'s module docstring,
            "Three-tag centerline model" section). Sourced from
            `RampEstimate.entrance_center_m` when available (the
            tag_fusion-authoritative entrance), falling back to
            `GuidanceTarget.entrance_center_m` (also verbatim) only when
            no fused entrance exists at all. Never ground-projected,
            never Y-adjusted. The end of the fixed ramp centerline
            segment and one end of the fixed staging segment. Must
            render directly at tag 0 whenever tag 0 is visible -- the
            easiest visual correctness check for this module.
        top_point_camera_m: `RampEstimate.top_center_m`, verbatim --
            never adjusted, never derived from the staging point.
        staging_distance_m: Echoed through from `GuidanceTarget.
            staging_distance_m` -- both the on-screen label and the
            actual magnitude `staging_point_camera_m` is built from.
        staging_direction_source: Which direction `staging_point_
            camera_m` was actually built from this frame -- `"RAMP
            CENTERLINE"` (the normal, highest-authority case: both
            `entrance_point_camera_m` and `top_point_camera_m` are
            available with a non-degenerate horizontal separation) or
            `"HEADING FALLBACK"` (`approach_heading_deg`-derived,
            PROVISIONAL, used only when the ramp centerline cannot be
            formed at all). `None` exactly when `staging_point_camera_m`
            is `None`. See this section's module comment. This is also
            the *exact* direction `approach_points`' final tangent is
            built from -- never independently recomputed from tag yaw/
            pitch/heading.
        ramp_travel_heading_deg: `GuidanceTarget.approach_heading_deg`,
            echoed through verbatim -- the best current estimate of
            which way the ramp centerline itself currently points,
            independent of `entrance_point_camera_m`/`top_point_
            camera_m` (and therefore still available once id 0 is no
            longer visible at all, unlike those two). This is what
            `desired_path_direction()` reads for `PathSection.RAMP` --
            see that function and `advance_path_progress()`'s docstring,
            "Ramp-direction hierarchy," for the full case-by-case
            sourcing. `None` exactly when `GuidanceTarget.approach_
            heading_deg` is `None`.
        ramp_direction_source: Which tag combination `ramp_travel_
            heading_deg` actually came from this frame -- `"TAGS 0+2"`/
            `"TAGS 0+1"`/`"TAGS 1+2"` (an empirically observed two-point
            direction) or `"TAG 0 ORIENTATION"`/`"TAG 1 ORIENTATION"`/
            `"TAG 2 ORIENTATION"` (a single tag's own calibrated
            heading, lower confidence -- see `guidance.py`'s module
            docstring). `None` exactly when `ramp_travel_heading_deg` is.
        approach_points: The sampled ROVER -> STAGING cubic-Bezier curve
            -- see `_build_approach_points()` and this section's module
            comment. `approach_points[0]` is exactly
            `rover_point_camera_m`; `approach_points[-1]` is exactly
            `staging_point_camera_m` (same objects). `None` whenever
            either endpoint or the staging direction is unavailable --
            never a fabricated curve.
        lookahead_point_camera_m: A point `ApproachPathParams.
            lookahead_m` forward along `approach_points`, clamped to
            `approach_points[-1]` -- see `_point_along_polyline_at_
            distance()`. Geometry/visualization only this milestone
            (see `PathSection`'s docstring); not yet used to steer.
            `None` whenever `approach_points` is `None`.
        active_section: The `PathSection` the rover is currently on --
            see that enum's docstring for why this always reports
            `APPROACH` this milestone. `None` only when there is no
            valid path at all (`staging_point_camera_m` is `None`).
        quality: `GuidanceTarget.quality`, echoed through -- there is
            only one entrance reconstruction feeding this whole path.
        valid: `GuidanceTarget.valid`, echoed through.
    """

    rover_point_camera_m: np.ndarray | None = field(compare=False)
    staging_point_camera_m: np.ndarray | None = field(compare=False)
    entrance_point_camera_m: np.ndarray | None = field(compare=False)
    top_point_camera_m: np.ndarray | None = field(compare=False)
    approach_points: tuple[np.ndarray, ...] | None = field(compare=False)
    lookahead_point_camera_m: np.ndarray | None = field(compare=False)
    staging_distance_m: float | None
    staging_direction_source: str | None
    ramp_travel_heading_deg: float | None
    ramp_direction_source: str | None
    active_section: PathSection | None
    quality: TargetQuality
    valid: bool

    @property
    def flexible_approach_segment(self) -> tuple[np.ndarray | None, np.ndarray | None]:
        """Segment 3's start/end points only (rover, staging) -- for
        identity/testing convenience. The actual drawn/followed path is
        the full curve, `approach_points`; this is the only segment that
        may change shape as the rover moves."""
        return self.rover_point_camera_m, self.staging_point_camera_m

    @property
    def fixed_staging_segment(self) -> tuple[np.ndarray | None, np.ndarray | None]:
        """Segment 2: staging -> ENTRANCE -- fixed relative to the ramp,
        exactly `staging_distance_m` long."""
        return self.staging_point_camera_m, self.entrance_point_camera_m

    @property
    def next_mandatory_waypoint(self) -> str | None:
        """The mandatory next waypoint for `active_section` --
        `"STAGING"` during `APPROACH`, `"ENTRANCE"` during `FINAL_
        ALIGNMENT`, `"TOP"` during `RAMP`, `None` when there's no active
        path at all. Never `"ENTRANCE"` while `APPROACH` is active,
        however geometrically convenient a direct rover->entrance
        bearing might look -- path order is authoritative, not
        proximity (see `PathSection`'s docstring)."""
        if self.active_section is None:
            return None
        return _NEXT_MANDATORY_WAYPOINT[self.active_section]

    @property
    def fixed_ramp_segment(self) -> tuple[np.ndarray | None, np.ndarray | None]:
        """Segment 1: ENTRANCE -> top -- fixed relative to the ramp."""
        return self.entrance_point_camera_m, self.top_point_camera_m


_STAGING_SOURCE_RAMP_CENTERLINE = "RAMP CENTERLINE"
_STAGING_SOURCE_HEADING_FALLBACK = "HEADING FALLBACK"

# Below this horizontal length (metres), the entrance->top ramp vector is
# treated as too close to purely vertical to define a horizontal direction
# from -- a defensive guard against dividing by (near) zero, not a value
# expected to matter for any real ramp.
_MIN_HORIZONTAL_RAMP_LENGTH_M = 1e-6


def _horizontal_direction_from_heading_deg(heading_deg: float) -> np.ndarray:
    """Purely horizontal unit vector for a corrected ramp-approach
    heading: ``(sin(heading), 0, cos(heading))`` -- the same sign
    convention as `guidance.py`'s own `_horizontal_direction_from_
    heading_deg()` (duplicated here, not imported, to keep this module
    downstream-only). Used **only** as `staging_point_camera_m`'s
    PROVISIONAL fallback direction, when the ramp centerline itself
    cannot be formed -- see `_ramp_centerline_horizontal_direction()`
    and this section's module comment."""
    heading_rad = math.radians(heading_deg)
    direction: np.ndarray = np.array([math.sin(heading_rad), 0.0, math.cos(heading_rad)])
    return direction


def _ramp_centerline_horizontal_direction(
    entrance_point: np.ndarray | None, top_point: np.ndarray | None
) -> np.ndarray | None:
    """Return the horizontal (X, Z) unit vector from *entrance_point*
    toward *top_point* -- the **single authoritative centerline
    direction**, derived from the exact same two points `draw_
    navigation_path()` draws the green ramp-centerline segment between.
    `None` when either point is unavailable, or the horizontal
    separation between them is degenerate (a near-perfectly-vertical
    ramp vector) -- callers fall back to `_horizontal_direction_from_
    heading_deg()` in that case."""
    if entrance_point is None or top_point is None:
        return None
    ramp_vector = top_point - entrance_point
    horizontal_ramp_vector = np.array([ramp_vector[0], 0.0, ramp_vector[2]])
    horizontal_length = float(np.linalg.norm(horizontal_ramp_vector))
    if horizontal_length < _MIN_HORIZONTAL_RAMP_LENGTH_M:
        return None
    direction: np.ndarray = horizontal_ramp_vector / horizontal_length
    return direction


def _ramp_direction_source_text(supporting_tag_ids: tuple[int, ...]) -> str:
    """Describe which ramp-centerline tag combination `GuidanceTarget.
    approach_heading_deg` actually came from -- the same *supporting_
    tag_ids* combinations `guidance.py`'s own EXACT/PROVISIONAL hierarchy
    produces (see that module's docstring): `{0, 2}`/`{0, 1}`/`{1, 2}`
    for an empirically observed two-point direction, or a single id for
    that one tag's own calibrated heading. `"N/A"` for an empty/
    unrecognized combination (e.g. `INVALID`)."""
    ids = set(supporting_tag_ids)
    if {0, 2} <= ids:
        return "TAGS 0+2"
    if {0, 1} <= ids:
        return "TAGS 0+1"
    if {1, 2} <= ids:
        return "TAGS 1+2"
    if 0 in ids:
        return "TAG 0 ORIENTATION"
    if 1 in ids:
        return "TAG 1 ORIENTATION"
    if 2 in ids:
        return "TAG 2 ORIENTATION"
    return "N/A"


# Consecutive frames the "tag 0 is now behind the rover" signal must hold
# before RAMP mode commits -- a simple glitch filter, not a modeled
# physical duration (see `advance_path_progress()`). A single-frame
# dropout/misread right at the crossing point must never by itself
# commit to RAMP.
_RAMP_ENTRY_CONFIRM_FRAMES = 3

# Camera-frame Z at or below which the entrance tag is considered to be
# behind the rover ("reached/passed") -- 0.0, the coordinate origin
# itself. Deliberately not a small positive margin: this prototype does
# not model the rover's own physical extent (see `guidance.py`'s "rover
# position == camera origin" assumption), so there is no more-precise
# threshold to justify.
_RAMP_ENTRY_Z_THRESHOLD_M = 0.0


@dataclass(frozen=True)
class PathProgressState:
    """Sticky, cross-frame memory of whether the rover has legitimately
    entered `PathSection.RAMP` -- see `advance_path_progress()`.

    `visualization.py`-local, like `NavigationPath`/`PathSection`
    themselves. The default, `PathProgressState()` (no confirmed
    passage yet), is exactly what every existing caller/test that never
    passes a `progress` argument to `build_navigation_path()` implicitly
    uses -- omitting it reproduces the prior "always APPROACH" behavior
    exactly, so no caller is forced to opt into RAMP tracking.

    A caller that *does* want RAMP tracking keeps one `PathProgressState`
    alive across frames (e.g. `scripts/test_ramp_geometry.py`'s main
    loop), replacing it each frame with `advance_path_progress()`'s
    return value *before* calling `build_navigation_path()`.
    """

    ramp_committed: bool = False
    consecutive_passed_entrance_frames: int = 0


def advance_path_progress(
    state: PathProgressState, guidance_target: GuidanceTarget
) -> PathProgressState:
    """Return the next frame's `PathProgressState`, given the current
    *state* and this frame's *guidance_target*.

    **Sticky:** once `state.ramp_committed` is `True`, this always
    returns *state* unchanged -- losing tag 0 (or every tag) after
    commitment never reverts RAMP mode; see `PathSection`'s docstring.
    Do not call this after committing expecting it to ever reconsider.

    **Debounced, tag-0-direct-observation-only trigger:** before
    commitment, the raw per-frame signal is "tag 0 was *directly*
    observed this frame (`0 in guidance_target.supporting_tag_ids` --
    never a tag 1/2 reconstruction) and its own camera-relative Z is no
    longer positive" (`_RAMP_ENTRY_Z_THRESHOLD_M`) -- i.e. the physical
    entrance tag is now behind the rover. Deliberately **not** "tag 0 is
    merely not visible this frame": that flickers constantly (occlusion,
    a missed decision-margin frame, motion blur) and would false-trigger
    on the very first dropout, which is exactly the failure mode this
    function exists to avoid (see `tag_tracking.py`'s temporal-hold
    layer for the analogous problem one layer downstream). The signal
    must hold for `_RAMP_ENTRY_CONFIRM_FRAMES` *consecutive* calls before
    committing -- any call where the signal does not hold (tag 0 not
    observed at all, or observed with a still-positive Z) resets the
    consecutive count to `0`, so only a sustained crossing, never a
    single ambiguous frame, ever commits.
    """
    if state.ramp_committed:
        return state

    tag0_directly_observed = 0 in guidance_target.supporting_tag_ids
    passed_this_frame = (
        tag0_directly_observed
        and guidance_target.entrance_center_m is not None
        and guidance_target.entrance_center_m[2] <= _RAMP_ENTRY_Z_THRESHOLD_M
    )

    consecutive = state.consecutive_passed_entrance_frames + 1 if passed_this_frame else 0
    return PathProgressState(
        ramp_committed=consecutive >= _RAMP_ENTRY_CONFIRM_FRAMES,
        consecutive_passed_entrance_frames=consecutive,
    )


# Camera +Z, expressed in the (x, z) horizontal-plane representation the
# Bezier construction below works in. **Camera frame == rover body frame
# is an explicit, documented assumption for this prototype** (matching
# `guidance.py`'s own "rover position == camera origin" assumption) -- the
# rover's current heading is *never* read from any AprilTag's orientation,
# only from this fixed axis. See this section's module comment.
_ROVER_FORWARD_XZ = np.array([0.0, 1.0])


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _bezier_handle_length_m(
    rover_xz: np.ndarray, staging_xz: np.ndarray, params: ApproachPathParams
) -> float:
    """The shared control-handle length (both curve ends) for the ROVER
    -> STAGING cubic Bezier -- `params.handle_fraction` of the straight-
    line rover-to-staging horizontal distance, clamped to
    `[params.min_handle_m, params.max_handle_m]`."""
    straight_line_m = float(np.linalg.norm(staging_xz - rover_xz))
    return _clamp(
        params.handle_fraction * straight_line_m, params.min_handle_m, params.max_handle_m
    )


def _bezier_control_points_xz(
    rover_xz: np.ndarray,
    staging_xz: np.ndarray,
    final_direction_xz: np.ndarray,
    handle_length_m: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return the cubic Bezier's four horizontal (X, Z) control points
    (P0, P1, P2, P3) for the ROVER -> STAGING approach curve -- see this
    section's module comment for the full construction rationale.

    P0 = rover_xz, P3 = staging_xz -- the curve starts and ends exactly
    at the rover and staging points, by construction (a cubic Bezier's
    endpoints are always its first/last control points). P1 is P0
    advanced *handle_length_m* along `_ROVER_FORWARD_XZ`. P2 is P3
    pulled back *handle_length_m* against *final_direction_xz* (the
    same staging->entrance direction the fixed alignment segment uses).

    A cubic Bezier's tangent at t=0 is proportional to (P1 - P0), and at
    t=1 to (P3 - P2) -- so this construction alone is what makes the
    curve start tangent to the rover's forward direction and end
    tangent to the fixed staging->entrance direction."""
    p0 = rover_xz
    p1 = rover_xz + handle_length_m * _ROVER_FORWARD_XZ
    p3 = staging_xz
    p2 = staging_xz - handle_length_m * final_direction_xz
    return p0, p1, p2, p3


def _cubic_bezier_point_xz(
    p0: np.ndarray, p1: np.ndarray, p2: np.ndarray, p3: np.ndarray, t: float
) -> np.ndarray:
    one_minus_t = 1.0 - t
    point: np.ndarray = (
        (one_minus_t**3) * p0
        + 3.0 * (one_minus_t**2) * t * p1
        + 3.0 * one_minus_t * (t**2) * p2
        + (t**3) * p3
    )
    return point


def _build_approach_points(
    rover_point: np.ndarray,
    staging_point: np.ndarray,
    final_direction: np.ndarray,
    params: ApproachPathParams,
) -> tuple[np.ndarray, ...]:
    """Sample the ROVER -> STAGING cubic Bezier curve (see this
    section's module comment and `_bezier_control_points_xz()`) into
    `params.sample_count` camera-frame 3D points.

    *final_direction* is whichever direction `staging_point_camera_m`
    was actually built from this frame (ramp centerline, or heading
    fallback) -- passed straight through from `build_navigation_path()`,
    never recomputed here.

    The first and last returned points are *exactly* *rover_point*/
    *staging_point* (the same objects, not recomputed copies) -- this is
    exact analytically anyway (a Bezier evaluates to P0/P3 at t=0/t=1),
    but forcing it explicitly removes any floating-point doubt that this
    curve begins/ends at precisely the points this whole path is built
    from."""
    rover_xz = np.array([rover_point[0], rover_point[2]])
    staging_xz = np.array([staging_point[0], staging_point[2]])
    final_direction_xz = np.array([final_direction[0], final_direction[2]])

    handle_length_m = _bezier_handle_length_m(rover_xz, staging_xz, params)
    p0, p1, p2, p3 = _bezier_control_points_xz(
        rover_xz, staging_xz, final_direction_xz, handle_length_m
    )

    sample_count = max(params.sample_count, 2)
    points: list[np.ndarray] = []
    for i in range(sample_count):
        t = i / (sample_count - 1)
        xz = _cubic_bezier_point_xz(p0, p1, p2, p3, t)
        y = rover_point[1] + t * (staging_point[1] - rover_point[1])
        points.append(np.array([xz[0], y, xz[1]]))
    points[0] = rover_point
    points[-1] = staging_point
    return tuple(points)


def _polyline_length_m(points: tuple[np.ndarray, ...]) -> float:
    """Total 3D arc length along consecutive *points*, metres -- `0.0`
    for fewer than two points."""
    return float(sum(np.linalg.norm(b - a) for a, b in zip(points, points[1:], strict=False)))


def _point_along_polyline_at_distance(
    points: tuple[np.ndarray, ...], distance_m: float
) -> np.ndarray | None:
    """Return the point *distance_m* along *points* (3D arc length),
    clamped to *points*' own endpoints -- `points[0]` for a non-positive
    distance, `points[-1]` for a distance at or past the polyline's
    total length. Used for both `lookahead_point_camera_m` (walking
    `approach_points`, so it can never advance past `staging_point_
    camera_m` onto the fixed alignment segment, let alone reach
    entrance) and `_draw_segment_direction_arrow_inplace()`'s short
    direction-indicator arrows. `None` only for an empty *points*."""
    if not points:
        return None
    if distance_m <= 0.0:
        return points[0]
    remaining = distance_m
    for a, b in zip(points, points[1:], strict=False):
        segment_vector = b - a
        segment_length = float(np.linalg.norm(segment_vector))
        if segment_length <= 0.0:
            continue
        if remaining <= segment_length:
            point: np.ndarray = a + (remaining / segment_length) * segment_vector
            return point
        remaining -= segment_length
    return points[-1]


def desired_path_direction(
    navigation_path: NavigationPath, section: PathSection
) -> np.ndarray | None:
    """Single source of truth for "which way should the rover currently
    travel" -- derived strictly from the geometry *section* itself owns,
    never independently from `GuidanceTarget.target_bearing_deg`
    (bearing straight to guidance.py's own staging point),
    `approach_heading_deg`, any tag's yaw/pitch, or an image-space line.
    Every consumer of "rover direction" in this module -- the rover-
    direction arrow (`_draw_rover_direction_arrow_inplace()`),
    `navigation_hud_lines()`'s `DESIRED TRAVEL DIRECTION` line, and
    `_final_approach_heading_error_deg()` -- calls this one function;
    there is no second, independently-computed notion of rover
    direction anywhere in this module.

    `PathSection.APPROACH`: the white approach curve's own tangent
    leaving the rover -- ``normalize(approach_points[1] -
    approach_points[0])``, read directly from the sampled curve itself
    (`build_navigation_path()`'s `_build_approach_points()`). This is
    **not** `target_bearing_deg` (bearing straight to staging) and
    **not** `approach_heading_deg` -- for a curved approach these are
    *expected* to differ from the path's own tangent; that is normal,
    not a bug. (The analytic control-point tangent, ``3 * (P1 - P0)``,
    points the same way by construction -- see `_bezier_control_
    points_xz()` -- since `P1` is built from the rover's fixed forward
    direction; this reads the actual sampled curve instead of
    re-deriving the control points, so there is only one code path that
    ever produces this value.)

    `PathSection.FINAL_ALIGNMENT`: the fixed yellow segment's own
    direction, ``normalize(entrance_point_camera_m -
    staging_point_camera_m)`` -- already exactly horizontal, since
    `staging_point_camera_m`'s vertical component is forced equal to
    `entrance_point_camera_m`'s own (see `build_navigation_path()`).

    `PathSection.RAMP`: `navigation_path.ramp_travel_heading_deg`
    (`GuidanceTarget.approach_heading_deg`, echoed through), converted
    to a horizontal direction vector via `_horizontal_direction_from_
    heading_deg()`. **Not** `top_point_camera_m` minus `entrance_point_
    camera_m` -- unlike the other two sections, this direction must
    keep working after id 0 (and therefore `entrance_point_camera_m`,
    once no other tag can reconstruct it either) is no longer visible at
    all, and must use each single-tag fallback's own *calibrated*
    heading (`config/staging.yaml`'s `mount_heading_offset_deg`) rather
    than tag_fusion.py's uncalibrated single-tag reconstruction -- see
    `advance_path_progress()`'s docstring and `guidance.py`'s module
    docstring for the full ramp-direction hierarchy this value already
    encodes.

    `None` whenever *section*'s own geometry isn't available (or is
    degenerate -- zero length) -- never a fabricated direction.
    """
    vector: np.ndarray
    if section is PathSection.APPROACH:
        points = navigation_path.approach_points
        if points is None or len(points) < 2:
            return None
        vector = points[1] - points[0]
    elif section is PathSection.FINAL_ALIGNMENT:
        staging_point = navigation_path.staging_point_camera_m
        entrance_point = navigation_path.entrance_point_camera_m
        if staging_point is None or entrance_point is None:
            return None
        vector = entrance_point - staging_point
    elif section is PathSection.RAMP:
        if navigation_path.ramp_travel_heading_deg is None:
            return None
        vector = _horizontal_direction_from_heading_deg(navigation_path.ramp_travel_heading_deg)
    else:
        return None

    norm = float(np.linalg.norm(vector))
    if norm <= 0.0:
        return None
    direction: np.ndarray = vector / norm
    return direction


def build_navigation_path(
    guidance_target: GuidanceTarget,
    ramp_estimate: RampEstimate,
    approach_path_params: ApproachPathParams | None = None,
    progress: PathProgressState | None = None,
) -> NavigationPath:
    """Return the single, authoritative `NavigationPath` for this frame --
    the *only* place any of its points (including the curved approach
    and the lookahead point) is computed. Every drawing function below
    (`draw_navigation_path()`, `draw_navigation_landmarks()`,
    `draw_top_down_guidance_inset()`) takes an already-built
    `NavigationPath` and never recomputes a point of its own, so there
    is exactly one entrance point, one staging point, and one approach
    curve in the whole live view, never independently-derived ones that
    could drift apart from each other.

    `entrance_point_camera_m` is always the true, complete 3D entrance
    position -- `RampEstimate.entrance_center_m` verbatim, or
    `GuidanceTarget.entrance_center_m` verbatim in the PROVISIONAL
    fallback. Never ground-projected.

    `staging_point_camera_m` is built from `entrance_point_camera_m`
    and the **ramp centerline's own horizontal direction** (`top_point_
    camera_m` minus `entrance_point_camera_m`, projected flat) whenever
    both points are available with a non-degenerate horizontal
    separation -- see `_ramp_centerline_horizontal_direction()`. Only
    when that's impossible (no top tag visible yet, or a degenerate
    ramp vector) does it fall back to `guidance_target.approach_
    heading_deg` via `_horizontal_direction_from_heading_deg()`.
    `staging_direction_source` records which one actually happened.
    Neither path ever reads `GuidanceTarget.target_point_camera_m`
    (ground-plane-snapped; see this section's module comment for why).
    Its vertical component is forced equal to the entrance's own, so
    the two points always sit on the same local path plane and
    `distance(entrance, staging)` is exactly `staging_distance_m` in 3D
    as well as horizontally, and `staging`/`entrance`/`top` are
    collinear in horizontal X/Z whenever the ramp-centerline path was
    used.

    `approach_points`/`lookahead_point_camera_m`/`active_section` are
    computed strictly *after* `staging_point_camera_m` is frozen for
    this frame -- see this section's module comment ("the curved
    approach is a CONSUMER of the staging point, never a producer of
    it"). They require `rover_point_camera_m`, `staging_point_camera_m`,
    and a resolved staging direction to all be available; `active_
    section` alone only requires `staging_point_camera_m` (it reflects
    "the rover hasn't reached staging yet", not "the curve rendered").
    *approach_path_params* defaults to `ApproachPathParams()` when
    omitted.

    `ramp_travel_heading_deg`/`ramp_direction_source` are `guidance_
    target.approach_heading_deg`/a text label for `.supporting_tag_ids`
    (`_ramp_direction_source_text()`), echoed through independently of
    everything above -- they stay populated even once `entrance_point_
    camera_m`/`staging_point_camera_m` can no longer be formed at all,
    which is exactly the point once the rover has driven past id 0 (see
    `PathSection.RAMP`'s docstring).

    *progress*, when given, is this frame's `PathProgressState` (see
    `advance_path_progress()`, which the caller must have already run
    for this frame *before* calling this function). `active_section` is
    `RAMP` whenever `progress.ramp_committed` is `True`, **regardless**
    of whether `staging_point_camera_m` could be formed this frame --
    RAMP, once committed, does not depend on staging geometry at all.
    Omitting *progress* (or passing one that has never committed)
    reproduces the exact prior behavior: `APPROACH` whenever a valid
    path exists, `None` otherwise.

    All-`None` (except `active_section`, which still respects a
    committed *progress*) when `guidance_target.quality` is `INVALID` --
    no point is ever fabricated.
    """
    if approach_path_params is None:
        approach_path_params = ApproachPathParams()

    ramp_committed = progress is not None and progress.ramp_committed
    ramp_travel_heading_deg = guidance_target.approach_heading_deg
    ramp_direction_source = (
        _ramp_direction_source_text(guidance_target.supporting_tag_ids)
        if ramp_travel_heading_deg is not None
        else None
    )

    if guidance_target.quality is TargetQuality.INVALID:
        return NavigationPath(
            rover_point_camera_m=None,
            staging_point_camera_m=None,
            entrance_point_camera_m=None,
            top_point_camera_m=None,
            approach_points=None,
            lookahead_point_camera_m=None,
            staging_distance_m=None,
            staging_direction_source=None,
            ramp_travel_heading_deg=ramp_travel_heading_deg,
            ramp_direction_source=ramp_direction_source,
            active_section=PathSection.RAMP if ramp_committed else None,
            quality=TargetQuality.INVALID,
            valid=False,
        )

    ground_height = guidance_target.ground_plane_height_m
    rover_point = np.array([0.0, ground_height, 0.0]) if ground_height is not None else None

    if ramp_estimate.entrance_center_m is not None:
        entrance_point = ramp_estimate.entrance_center_m.copy()
    else:
        entrance_point = guidance_target.entrance_center_m

    top_point = ramp_estimate.top_center_m

    staging_point: np.ndarray | None = None
    staging_direction_source: str | None = None
    staging_direction: np.ndarray | None = None
    if entrance_point is not None and guidance_target.staging_distance_m is not None:
        staging_direction = _ramp_centerline_horizontal_direction(entrance_point, top_point)
        source = _STAGING_SOURCE_RAMP_CENTERLINE
        if staging_direction is None and guidance_target.approach_heading_deg is not None:
            staging_direction = _horizontal_direction_from_heading_deg(
                guidance_target.approach_heading_deg
            )
            source = _STAGING_SOURCE_HEADING_FALLBACK
        if staging_direction is not None:
            staging_point = entrance_point - guidance_target.staging_distance_m * staging_direction
            staging_point[1] = entrance_point[1]
            staging_direction_source = source

    active_section: PathSection | None
    if ramp_committed:
        active_section = PathSection.RAMP
    else:
        active_section = PathSection.APPROACH if staging_point is not None else None

    approach_points: tuple[np.ndarray, ...] | None = None
    lookahead_point: np.ndarray | None = None
    if rover_point is not None and staging_point is not None and staging_direction is not None:
        approach_points = _build_approach_points(
            rover_point, staging_point, staging_direction, approach_path_params
        )
        lookahead_point = _point_along_polyline_at_distance(
            approach_points, approach_path_params.lookahead_m
        )

    return NavigationPath(
        rover_point_camera_m=rover_point,
        staging_point_camera_m=staging_point,
        entrance_point_camera_m=entrance_point,
        top_point_camera_m=top_point,
        approach_points=approach_points,
        lookahead_point_camera_m=lookahead_point,
        staging_distance_m=guidance_target.staging_distance_m,
        staging_direction_source=staging_direction_source,
        ramp_travel_heading_deg=ramp_travel_heading_deg,
        ramp_direction_source=ramp_direction_source,
        active_section=active_section,
        quality=guidance_target.quality,
        valid=guidance_target.valid,
    )


def _draw_dashed_segment_inplace(
    frame_bgr: np.ndarray,
    projected_points: list[tuple[int, int] | None],
    color: tuple[int, int, int],
    thickness: int,
    *,
    dashed: bool,
) -> None:
    """Draw straight sub-segments between consecutive *projected_points*,
    skipping any pair where either endpoint is `None` (didn't validly
    project -- e.g. behind the camera) rather than crashing or
    interpolating through it. When *dashed*, every other sub-segment is
    skipped to produce a dashed appearance that still respects
    perspective (each sub-segment is independently projected, not a
    straight line drawn in screen space)."""
    for i in range(len(projected_points) - 1):
        if dashed and i % 2 == 1:
            continue
        start_px, end_px = projected_points[i], projected_points[i + 1]
        if start_px is not None and end_px is not None:
            cv2.line(frame_bgr, start_px, end_px, color, thickness, cv2.LINE_AA)


def _project_segment_points(
    start_m: np.ndarray, end_m: np.ndarray, intrinsics: CameraIntrinsics, *, num_points: int = 24
) -> list[tuple[int, int] | None]:
    """Return *num_points* projected pixel coordinates evenly spaced
    along the straight 3D segment from *start_m* to *end_m* (inclusive
    of both ends), each independently projected via `_project_point()`
    -- `None` at any index that doesn't validly project. Generating and
    projecting real intermediate 3D points (rather than drawing one
    straight line in screen space between the two projected endpoints)
    is what keeps the on-screen path perspective-correct."""
    return [
        _project_point(start_m + (i / (num_points - 1)) * (end_m - start_m), intrinsics)
        for i in range(num_points)
    ]


def _draw_path_segment_inplace(
    frame_bgr: np.ndarray,
    start_m: np.ndarray,
    end_m: np.ndarray,
    intrinsics: CameraIntrinsics,
    color: tuple[int, int, int],
    *,
    thickness: int,
    dashed: bool,
) -> None:
    projected = _project_segment_points(start_m, end_m, intrinsics)
    _draw_dashed_segment_inplace(frame_bgr, projected, color, thickness, dashed=dashed)


def _draw_segment_direction_arrow_inplace(
    frame_bgr: np.ndarray,
    points: tuple[np.ndarray, ...],
    intrinsics: CameraIntrinsics,
    color: tuple[int, int, int],
) -> None:
    """Draw one small arrowhead near the middle of *points* (a 2-point
    straight segment or a densely-sampled curve alike), pointing in the
    direction of travel -- a purely cosmetic marker, not a new geometry
    calculation: both its endpoints come from `_point_along_polyline_
    at_distance()`, the exact same arc-length walk `lookahead_point_
    camera_m` itself uses, just at 45%/55% of *points*' own length
    instead of a configured distance. Makes the intended ROVER ->
    STAGING -> ENTRANCE -> TOP traversal order visually obvious. Draws
    nothing for a degenerate (zero-length) *points*."""
    total_length_m = _polyline_length_m(points)
    if total_length_m <= 0.0:
        return
    arrow_start = _point_along_polyline_at_distance(points, total_length_m * 0.45)
    arrow_end = _point_along_polyline_at_distance(points, total_length_m * 0.55)
    if arrow_start is None or arrow_end is None:
        return
    start_px = _project_point(arrow_start, intrinsics)
    end_px = _project_point(arrow_end, intrinsics)
    if start_px is None or end_px is None:
        return
    cv2.arrowedLine(frame_bgr, start_px, end_px, color, 2, tipLength=0.8)


_ROVER_DIRECTION_ARROW_RADIUS_PX = 70.0

# Metres-scale equivalent for draw_top_down_guidance_inset()'s schematic
# (metres-per-pixel) transform, where a fixed screen-pixel radius doesn't
# apply -- see that function's own rover-direction arrow.
_ROVER_DIRECTION_ARROW_LENGTH_M = 0.3


def _draw_rover_direction_arrow_inplace(
    frame_bgr: np.ndarray,
    navigation_path: NavigationPath,
    color: tuple[int, int, int],
) -> None:
    """Draw the single arrow representing the rover's current desired
    travel direction -- anchored at the same fixed bottom-center screen
    point `draw_navigation_landmarks()`'s ROVER marker uses (the rover
    IS the coordinate origin, `rover_point_camera_m`'s Z is always
    exactly `0.0`, and `_project_point()` never returns a pixel for
    `z <= 1e-6` -- there is no well-defined pinhole projection for the
    origin itself to draw *from*, exactly as `_draw_bearing_arrow_
    inplace()`'s own docstring already establishes), pointing at a
    fixed screen-space radius in the heading given by `desired_path_
    direction(navigation_path, navigation_path.active_section)` -- the
    same value `navigation_hud_lines()`'s `DESIRED TRAVEL DIRECTION`
    line reports, so the arrow and that HUD line can never disagree.

    Replaces the previous, independently-bearing-based compass arrow
    (`_draw_bearing_arrow_inplace()`/`draw_target_bearing()`), which
    could point somewhere completely different from the actual white/
    yellow/green path (straight to `GuidanceTarget.target_point_
    camera_m`, unrelated to the curve) -- see this module's "Navigation
    HUD" section comment. Draws nothing when `active_section` or a
    direction for that section is unavailable."""
    if navigation_path.active_section is None:
        return
    direction = desired_path_direction(navigation_path, navigation_path.active_section)
    if direction is None:
        return
    heading_deg = _direction_heading_deg(direction)
    if heading_deg is None:
        return
    height, width = frame_bgr.shape[:2]
    anchor = (width // 2, height - 20)
    heading_rad = math.radians(heading_deg)
    tip = (
        int(round(anchor[0] + _ROVER_DIRECTION_ARROW_RADIUS_PX * math.sin(heading_rad))),
        int(round(anchor[1] - _ROVER_DIRECTION_ARROW_RADIUS_PX * math.cos(heading_rad))),
    )
    cv2.arrowedLine(frame_bgr, anchor, tip, color, 3, tipLength=0.35)


def draw_navigation_path(
    frame_bgr: np.ndarray,
    navigation_path: NavigationPath,
    intrinsics: CameraIntrinsics,
) -> np.ndarray:
    """Return a copy of *frame_bgr* with *navigation_path*'s **three
    independently-drawn segments**: the flexible ROVER -> STAGING
    approach -- drawn as `navigation_path.approach_points`' full curve,
    always dashed, the only segment allowed to change shape as the
    rover moves -- the fixed STAGING -> ENTRANCE alignment segment, and
    the fixed ENTRANCE -> TOP ramp centerline. Each segment is drawn
    from *navigation_path*'s own fields only -- this function never
    computes or adjusts a point itself (see `build_navigation_path()`,
    the sole place any of them is derived). There is no direct
    ROVER -> ENTRANCE line anywhere in this function.

    A small arrowhead is drawn near the middle of each of the *fixed*
    segments (`_draw_segment_direction_arrow_inplace()`), making the
    mandatory ROVER -> STAGING -> ENTRANCE -> TOP traversal order
    visually obvious. The flexible approach segment instead gets
    `_draw_rover_direction_arrow_inplace()`'s arrow, anchored exactly at
    the rover and pointing exactly along `desired_path_direction()`'s
    value for whichever section is currently active -- i.e. the curve's
    *own* tangent leaving the rover during `APPROACH`, or the ramp
    centerline's own direction during `RAMP` -- never an independently-
    computed bearing -- so this arrow is guaranteed to visually agree
    with whichever colored segment currently represents "the plan."

    **Once `PathSection.RAMP` is active** (`navigation_path.active_
    section is PathSection.RAMP`), neither the flexible white approach
    curve nor the fixed yellow staging segment is drawn at all -- both
    represent a path *back toward* staging/entrance, which the rover is
    no longer supposed to be aiming for (see `PathSection`'s docstring
    and `advance_path_progress()`) -- only the green ramp centerline,
    drawn slightly thicker to emphasize it as the active segment, plus
    the rover-direction arrow (now green, and now sourced from
    `ramp_travel_heading_deg` rather than the curve).

    Never draws anything when `navigation_path.quality` is `INVALID` (no
    path is fabricated); draws only whichever segment currently has both
    of its endpoints available.

    **Styling:** segment identity is color-coded (`_SEGMENT_RAMP_COLOR_
    BGR` green / `_SEGMENT_ALIGNMENT_COLOR_BGR` yellow / `_SEGMENT_
    APPROACH_COLOR_BGR` white); dashing marks only the flexible approach
    segment. When `quality` is `PROVISIONAL`, both *fixed* segments
    switch to `_SEGMENT_PROVISIONAL_COLOR_BGR` instead (their shared
    entrance point is an estimate in that tier, not a direct
    observation) -- the approach segment's color never changes with
    quality, since "where the rover is relative to staging" is a plain
    fact regardless of how staging was derived. Never mutates
    *frame_bgr*.
    """
    annotated: np.ndarray = frame_bgr.copy()

    if navigation_path.quality is TargetQuality.INVALID:
        return annotated

    is_provisional = navigation_path.quality is TargetQuality.PROVISIONAL
    fixed_color = _SEGMENT_PROVISIONAL_COLOR_BGR if is_provisional else None
    in_ramp_mode = navigation_path.active_section is PathSection.RAMP

    if not in_ramp_mode and navigation_path.approach_points is not None:
        projected = [
            _project_point(point, intrinsics) for point in navigation_path.approach_points
        ]
        _draw_dashed_segment_inplace(
            annotated, projected, _SEGMENT_APPROACH_COLOR_BGR, 3, dashed=True
        )

    if not in_ramp_mode:
        staging_point, entrance_point = navigation_path.fixed_staging_segment
        if staging_point is not None and entrance_point is not None:
            alignment_color = fixed_color or _SEGMENT_ALIGNMENT_COLOR_BGR
            _draw_path_segment_inplace(
                annotated, staging_point, entrance_point, intrinsics,
                alignment_color, thickness=4, dashed=False,
            )
            _draw_segment_direction_arrow_inplace(
                annotated, (staging_point, entrance_point), intrinsics, alignment_color
            )

    ramp_color = fixed_color or _SEGMENT_RAMP_COLOR_BGR
    entrance_point, top_point = navigation_path.fixed_ramp_segment
    if entrance_point is not None and top_point is not None:
        ramp_thickness = 6 if in_ramp_mode else 4
        _draw_path_segment_inplace(
            annotated, entrance_point, top_point, intrinsics,
            ramp_color, thickness=ramp_thickness, dashed=False,
        )
        if not in_ramp_mode:
            _draw_segment_direction_arrow_inplace(
                annotated, (entrance_point, top_point), intrinsics, ramp_color
            )

    arrow_color = ramp_color if in_ramp_mode else _SEGMENT_APPROACH_COLOR_BGR
    _draw_rover_direction_arrow_inplace(annotated, navigation_path, arrow_color)

    return annotated


def draw_navigation_landmarks(
    frame_bgr: np.ndarray,
    navigation_path: NavigationPath,
    ramp_estimate: RampEstimate,
    intrinsics: CameraIntrinsics,
) -> np.ndarray:
    """Return a copy of *frame_bgr* with the point markers/labels for
    *navigation_path*'s landmarks -- ROVER, STAGING, LOOKAHEAD,
    ENTRANCE, TOP -- plus id 1's own position, still read from
    *ramp_estimate* directly, drawn as its own small diagnostic marker
    that never influences the path itself (see `draw_navigation_path()`
    -- it never reads `middle_center_m` at all). Every landmark position
    comes from *navigation_path* alone -- this function never
    recomputes a point of its own.

    LOOKAHEAD (`navigation_path.lookahead_point_camera_m`) is drawn only
    when available -- geometry/visualization only this milestone, not
    yet a steering target (see `PathSection`'s docstring); it always
    lies on the white approach curve, never independently toward
    ENTRANCE.

    ENTRANCE is drawn at `navigation_path.entrance_point_camera_m` --
    the verbatim entrance position -- so it must appear directly at tag
    0 whenever tag 0 is visible; see this module's "Navigation HUD"
    section comment for why no separate ground-projected point is used
    here.

    The rover/camera origin has no pinhole projection of its own (it
    *is* the coordinate origin) -- drawn instead as a fixed marker near
    the bottom-center of the frame, the same anchor convention
    `_draw_bearing_arrow_inplace()` already uses.

    Draws only whichever points are currently available -- an `INVALID`
    path still draws the ROVER marker (always true regardless of tag
    visibility) but nothing else. Never mutates *frame_bgr*.
    """
    annotated: np.ndarray = frame_bgr.copy()
    height, width = annotated.shape[:2]

    rover_anchor = (width // 2, height - 20)
    cv2.circle(annotated, rover_anchor, 8, _ROVER_ORIGIN_COLOR_BGR, -1)
    cv2.putText(
        annotated, "ROVER", (rover_anchor[0] + 12, rover_anchor[1] + 4),
        cv2.FONT_HERSHEY_SIMPLEX, 0.5, _ROVER_ORIGIN_COLOR_BGR, 2, cv2.LINE_AA,
    )

    if navigation_path.quality is TargetQuality.INVALID:
        return annotated

    is_provisional = navigation_path.quality is TargetQuality.PROVISIONAL
    fixed_color = _SEGMENT_PROVISIONAL_COLOR_BGR if is_provisional else None
    alignment_color = fixed_color or _SEGMENT_ALIGNMENT_COLOR_BGR
    ramp_color = fixed_color or _SEGMENT_RAMP_COLOR_BGR

    staging_point = navigation_path.staging_point_camera_m
    staging_px = _project_point(staging_point, intrinsics) if staging_point is not None else None
    if staging_px is not None:
        cv2.circle(annotated, staging_px, 14, alignment_color, 3)
        cv2.circle(annotated, staging_px, 4, alignment_color, -1)
        cv2.putText(
            annotated, "STAGING", (staging_px[0] + 16, staging_px[1]),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, alignment_color, 2, cv2.LINE_AA,
        )
        if navigation_path.staging_distance_m is not None:
            cv2.putText(
                annotated, f"{navigation_path.staging_distance_m:.2f} m before entrance",
                (staging_px[0] + 16, staging_px[1] + 20),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, alignment_color, 1, cv2.LINE_AA,
            )

    lookahead_point = navigation_path.lookahead_point_camera_m
    lookahead_px = (
        _project_point(lookahead_point, intrinsics) if lookahead_point is not None else None
    )
    if lookahead_px is not None:
        cv2.drawMarker(
            annotated, lookahead_px, _NAV_LOOKAHEAD_COLOR_BGR, cv2.MARKER_DIAMOND, 14, 2
        )
        cv2.putText(
            annotated, "LOOKAHEAD", (lookahead_px[0] + 10, lookahead_px[1] + 4),
            cv2.FONT_HERSHEY_SIMPLEX, 0.45, _NAV_LOOKAHEAD_COLOR_BGR, 1, cv2.LINE_AA,
        )

    entrance_point = navigation_path.entrance_point_camera_m
    entrance_px = (
        _project_point(entrance_point, intrinsics) if entrance_point is not None else None
    )
    if entrance_px is not None:
        cv2.circle(annotated, entrance_px, 9, _NAV_ENTRANCE_COLOR_BGR, -1)
        cv2.putText(
            annotated, "ENTRANCE", (entrance_px[0] + 12, entrance_px[1] - 10),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, _NAV_ENTRANCE_COLOR_BGR, 2, cv2.LINE_AA,
        )

    top_point = navigation_path.top_point_camera_m
    top_px = _project_point(top_point, intrinsics) if top_point is not None else None
    if top_px is not None:
        cv2.drawMarker(annotated, top_px, _NAV_TOP_COLOR_BGR, cv2.MARKER_TRIANGLE_UP, 20, 3)
        cv2.putText(
            annotated, "TOP", (top_px[0] + 14, top_px[1]),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, _NAV_TOP_COLOR_BGR, 2, cv2.LINE_AA,
        )

    if entrance_px is not None and top_px is not None:
        mid_px = ((entrance_px[0] + top_px[0]) // 2, (entrance_px[1] + top_px[1]) // 2)
        cv2.putText(
            annotated, "RAMP CENTERLINE", (mid_px[0] + 8, mid_px[1]),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, ramp_color, 2, cv2.LINE_AA,
        )

    if staging_px is not None and entrance_px is not None:
        mid_px = ((staging_px[0] + entrance_px[0]) // 2, (staging_px[1] + entrance_px[1]) // 2)
        cv2.putText(
            annotated, "FINAL ALIGNMENT", (mid_px[0] + 8, mid_px[1]),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, alignment_color, 2, cv2.LINE_AA,
        )

    _draw_middle_diagnostic_inplace(annotated, ramp_estimate, intrinsics)

    return annotated


def _draw_middle_diagnostic_inplace(
    frame_bgr: np.ndarray, ramp_estimate: RampEstimate, intrinsics: CameraIntrinsics
) -> None:
    """Draw id 1's own position as a small, subtle dot -- never a route
    endpoint, never a label competing with the primary landmarks --
    plus, when available, its perpendicular deviation from the ramp
    centerline as a thin connector line (the same diagnostic
    `draw_ramp_estimate()` already draws, reused here in a visually
    quieter style appropriate for the default HUD)."""
    if ramp_estimate.middle_center_m is None:
        return
    middle_px = _project_point(ramp_estimate.middle_center_m, intrinsics)
    if middle_px is None:
        return
    cv2.circle(frame_bgr, middle_px, 4, _NAV_MIDDLE_DIAGNOSTIC_COLOR_BGR, -1)

    if (
        ramp_estimate.middle_distance_along_centerline_m is not None
        and ramp_estimate.entrance_center_m is not None
        and ramp_estimate.centerline_direction is not None
    ):
        projected_point_m = (
            ramp_estimate.entrance_center_m
            + ramp_estimate.middle_distance_along_centerline_m
            * ramp_estimate.centerline_direction
        )
        projected_px = _project_point(projected_point_m, intrinsics)
        if projected_px is not None:
            cv2.line(frame_bgr, middle_px, projected_px, _NAV_MIDDLE_DIAGNOSTIC_COLOR_BGR, 1)
        if ramp_estimate.middle_perpendicular_distance_m is not None:
            cv2.putText(
                frame_bgr, f"mid ({ramp_estimate.middle_perpendicular_distance_m:.3f}m off)",
                (middle_px[0] + 8, middle_px[1] + 4),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, _NAV_MIDDLE_DIAGNOSTIC_COLOR_BGR, 1, cv2.LINE_AA,
            )


def _direction_heading_deg(direction: np.ndarray | None) -> float | None:
    """Convert a horizontal camera-frame direction vector into a
    heading in degrees (``atan2(x, z)``, this module's usual sign
    convention: 0 = straight ahead, positive = to the right) -- `None`
    when *direction* itself is `None`."""
    if direction is None:
        return None
    return math.degrees(math.atan2(direction[0], direction[2]))


def _final_approach_heading_error_deg(navigation_path: NavigationPath) -> float | None:
    """Angular difference, degrees, between the rover's fixed forward
    direction (camera +Z, 0 deg by definition -- see `_ROVER_FORWARD_
    XZ`) and the heading the rover must have by the time it reaches
    staging -- `desired_path_direction(navigation_path, PathSection.
    FINAL_ALIGNMENT)`, never independently recomputed, so this always
    matches whatever direction the fixed yellow segment actually has.
    `None` unless that direction is available."""
    direction = desired_path_direction(navigation_path, PathSection.FINAL_ALIGNMENT)
    return _direction_heading_deg(direction)


def navigation_hud_lines(
    guidance_target: GuidanceTarget,
    ramp_estimate: RampEstimate,
    navigation_path: NavigationPath,
) -> list[str]:
    """Return the compact navigation HUD's text lines -- target quality,
    source tags, confidence, entrance quality/source, the ramp-geometry
    diagnostics (visible ramp tags, entrance/centerline/top source,
    geometry quality -- all derived from *ramp_estimate* alone, see
    `_ramp_geometry_quality_text()`), a blank separator, target
    bearing/ramp heading/staging direction source, a second blank
    separator, the ordered-path state and approach-curve diagnostics,
    and (only if available) ramp length/width. A pure function, no
    image/cv2 involved.

    `ACTIVE PATH SECTION`/`NEXT MANDATORY WAYPOINT` are `navigation_
    path.active_section`/`.next_mandatory_waypoint` verbatim -- always
    `APPROACH`/`"STAGING"` this milestone (see `PathSection`'s
    docstring for why), never `"ENTRANCE"` while `APPROACH` is active,
    however close entrance might currently be. `APPROACH PATH` names
    the approach-curve generation method (`"BEZIER"`, the only one
    implemented) or `"N/A"` when no curve exists this frame.

    `ROVER TO STAGING` and `STAGING TO ENTRANCE` are deliberately two
    separate numbers, both read from *navigation_path*'s own segments
    (never `GuidanceTarget.distance_to_target_m`, which is a different,
    ground-plane-snapped quantity that no longer matches what this path
    actually draws -- see `build_navigation_path()`). `ROVER TO STAGING`
    is the flexible approach segment's current, changing length.
    `APPROACH PATH LENGTH` is the *curve's own* arc length (`_polyline_
    length_m(navigation_path.approach_points)`), which is always
    slightly longer than the straight-line `ROVER TO STAGING` distance
    whenever the curve actually bends -- the two are expected to differ,
    not duplicate each other. `FINAL APPROACH HEADING ERROR` is `_final_
    approach_heading_error_deg()` -- how much heading change the rover
    still needs by the time it completes the curve. `STAGING TO
    ENTRANCE` is the fixed alignment segment's length -- always exactly
    the configured `staging_distance_m` (see `config/staging.yaml`),
    regardless of where the rover currently is.

    `ENTRANCE QUALITY` mirrors `TARGET` (there is only one entrance
    reconstruction feeding this whole target -- see `guidance.py`'s
    module docstring), but is shown explicitly so it's never confused
    with `GEOMETRY QUALITY` below, which reflects `ramp_estimate`'s
    separate reconstruction instead. `ENTRANCE SOURCE` distinguishes the
    true ids-0-and-2 case from the two-tag and single-tag fallbacks --
    several different things `PROVISIONAL` alone cannot tell apart (see
    `_entrance_source_text()`).

    `VISIBLE RAMP TAGS`/`RAMP ENTRANCE SOURCE`/`CENTERLINE SOURCE`/`TOP
    SOURCE`/`GEOMETRY QUALITY` are `ramp_estimate`'s own, independent
    diagnostics (`tag_fusion.py`'s three-tag centerline reconstruction,
    not `guidance.py`'s staging-point generation above) -- derived
    entirely from `RampEstimate.supporting_tag_ids`/`.valid`, with no
    separate quality field on `RampEstimate` itself (see
    `_ramp_geometry_quality_text()`/`_ramp_entrance_source_text()`/
    `_ramp_centerline_source_text()`/`_ramp_top_source_text()`).
    `GEOMETRY QUALITY` is `EXACT` iff both ids 0 and 2 contributed,
    matching `tag_fusion.py`'s own EXACT/PROVISIONAL boundary.

    `RAMP HEADING` is `GuidanceTarget.approach_heading_deg`, **not**
    `RampEstimate.heading_deg`: the former is available identically for
    `EXACT` and `PROVISIONAL` (it's computed straight from whichever
    tags are visible), while the latter requires a *complete*
    `RampEstimate` (both entrance and top sections) and would be `None`
    through exactly the PROVISIONAL case this HUD most needs to keep
    working for. `RAMP DIRECTION SOURCE` is `navigation_path.ramp_
    direction_source` verbatim (`_ramp_direction_source_text()`) --
    which tag combination `RAMP HEADING` actually came from this frame
    (`"TAGS 0+2"`/`"TAGS 0+1"`/`"TAGS 1+2"`, or a single `"TAG n
    ORIENTATION"`); this is what `DESIRED TRAVEL DIRECTION` below reads
    once `ACTIVE PATH SECTION` is `RAMP` -- see `desired_path_
    direction()`.

    `STAGING DIRECTION SOURCE` is `navigation_path.staging_direction_
    source` verbatim -- `"RAMP CENTERLINE"` (the normal, highest-
    authority case) or `"HEADING FALLBACK"` (PROVISIONAL, only when the
    ramp centerline itself can't be formed) -- see `build_navigation_
    path()`. This is a **different** axis from `TARGET`/`ENTRANCE
    QUALITY` above: a frame can have an `EXACT` entrance (ids 0 and 2
    both visible) yet still need the heading fallback for staging
    direction if the ramp vector's horizontal component happens to be
    degenerate.

    `TARGET BEARING` (`GuidanceTarget.target_bearing_deg`) is the raw
    bearing straight to `GuidanceTarget.target_point_camera_m` --
    guidance.py's own, separately-computed, ground-plane-snapped
    staging point (see `build_navigation_path()`'s module comment for
    why this path draws a *different* staging point). Kept here purely
    as a secondary debugging value; it is **not** what the rover-
    direction arrow renders, and it is expected to disagree with
    `DESIRED TRAVEL DIRECTION` below whenever the approach curve bends.
    `DESIRED TRAVEL DIRECTION` is `desired_path_direction(navigation_
    path, navigation_path.active_section)`, converted to degrees -- the
    **authoritative** direction the rover-direction arrow actually
    draws (see `_draw_rover_direction_arrow_inplace()`). During
    `APPROACH` (the only section this milestone ever reports) this is
    the white curve's own tangent leaving the rover, not a bearing to
    staging or entrance, not `approach_heading_deg`, and not any tag's
    yaw/pitch -- a curved approach legitimately points somewhere other
    than straight at staging while still following the plan correctly."""
    lines = [
        f"TARGET: {guidance_target.quality.name}",
        f"SOURCE TAGS: {list(guidance_target.supporting_tag_ids)}",
        f"CONFIDENCE: {guidance_target.confidence:.2f}",
        f"ENTRANCE QUALITY: {guidance_target.quality.name}",
        f"ENTRANCE SOURCE: "
        f"{_entrance_source_text(guidance_target.quality, guidance_target.supporting_tag_ids)}",
        f"VISIBLE RAMP TAGS: {list(ramp_estimate.supporting_tag_ids)}",
        f"RAMP ENTRANCE SOURCE: {_ramp_entrance_source_text(ramp_estimate)}",
        f"CENTERLINE SOURCE: {_ramp_centerline_source_text(ramp_estimate)}",
        f"TOP SOURCE: {_ramp_top_source_text(ramp_estimate)}",
        f"GEOMETRY QUALITY: {_ramp_geometry_quality_text(ramp_estimate)}",
    ]

    rover_point, staging_point = navigation_path.flexible_approach_segment
    staging_point_again, entrance_point = navigation_path.fixed_staging_segment
    rover_to_staging_m = _segment_distance_m(rover_point, staging_point)
    staging_to_entrance_m = _segment_distance_m(staging_point_again, entrance_point)

    active_section_text = (
        navigation_path.active_section.name
        if navigation_path.active_section is not None
        else "N/A"
    )
    next_waypoint_text = navigation_path.next_mandatory_waypoint or "N/A"
    approach_path_type = "BEZIER" if navigation_path.approach_points is not None else "N/A"
    approach_path_length_m = (
        _polyline_length_m(navigation_path.approach_points)
        if navigation_path.approach_points is not None
        else None
    )
    final_heading_error_deg = _final_approach_heading_error_deg(navigation_path)
    desired_direction_deg = (
        _direction_heading_deg(
            desired_path_direction(navigation_path, navigation_path.active_section)
        )
        if navigation_path.active_section is not None
        else None
    )

    lines += [
        "",
        f"TARGET BEARING: {_degrees_text(guidance_target.target_bearing_deg)}",
        f"RAMP HEADING: {_degrees_text(guidance_target.approach_heading_deg)}",
        f"RAMP DIRECTION SOURCE: {navigation_path.ramp_direction_source or 'N/A'}",
        "STAGING DIRECTION SOURCE: "
        f"{navigation_path.staging_direction_source or 'N/A'}",
        "",
        f"ACTIVE PATH SECTION: {active_section_text}",
        f"NEXT MANDATORY WAYPOINT: {next_waypoint_text}",
        f"APPROACH PATH: {approach_path_type}",
        f"DESIRED TRAVEL DIRECTION: {_degrees_text(desired_direction_deg)}",
        f"ROVER TO STAGING: {_metres_text(rover_to_staging_m)}",
        f"APPROACH PATH LENGTH: {_metres_text(approach_path_length_m)}",
        f"FINAL APPROACH HEADING ERROR: {_degrees_text(final_heading_error_deg)}",
        "STAGING TO ENTRANCE: "
        f"{f'{staging_to_entrance_m:.3f} m' if staging_to_entrance_m is not None else 'N/A'}",
    ]
    if ramp_estimate.deployed_length_m is not None:
        lines.append(f"RAMP LENGTH: {ramp_estimate.deployed_length_m:.2f} m")
    if ramp_estimate.valid and ramp_estimate.width_m > 0.0:
        lines.append(f"RAMP WIDTH: {ramp_estimate.width_m:.2f} m")
    return lines


def _draw_translucent_panel_inplace(
    frame_bgr: np.ndarray,
    origin: tuple[int, int],
    lines: list[str],
    *,
    alpha: float = 0.55,
    line_height: int = 22,
    font_scale: float = 0.55,
    text_color: tuple[int, int, int] = _HUD_TEXT_COLOR_BGR,
) -> None:
    """Draw a semi-transparent dark rectangle sized to fit *lines*, then
    the lines themselves on top -- keeps HUD text readable in bright
    scenes without fully occluding the video behind it. Draws nothing
    for an empty *lines* list."""
    if not lines:
        return
    x, y = origin
    text_widths = [
        cv2.getTextSize(line, cv2.FONT_HERSHEY_SIMPLEX, font_scale, 1)[0][0]
        for line in lines
        if line
    ]
    panel_width = max(text_widths, default=120) + 20
    panel_height = len(lines) * line_height + 14
    top_left = (x - 10, y - 18)
    bottom_right = (top_left[0] + panel_width, top_left[1] + panel_height)

    overlay = frame_bgr.copy()
    cv2.rectangle(overlay, top_left, bottom_right, _HUD_BG_COLOR_BGR, -1)
    cv2.addWeighted(overlay, alpha, frame_bgr, 1.0 - alpha, 0.0, dst=frame_bgr)

    for i, line in enumerate(lines):
        if not line:
            continue
        cv2.putText(
            frame_bgr, line, (x, y + i * line_height),
            cv2.FONT_HERSHEY_SIMPLEX, font_scale, text_color, 1, cv2.LINE_AA,
        )


def draw_navigation_hud(
    frame_bgr: np.ndarray,
    guidance_target: GuidanceTarget,
    ramp_estimate: RampEstimate,
    navigation_path: NavigationPath,
    *,
    origin: tuple[int, int] = (20, 40),
) -> np.ndarray:
    """Return a copy of *frame_bgr* with `navigation_hud_lines()`'s
    compact block drawn top-left over a semi-transparent panel -- the
    single, clean replacement for the old, much larger overlapping
    per-tag/ramp/guidance text blocks in the default (non-debug) view.
    Never mutates *frame_bgr*.
    """
    annotated: np.ndarray = frame_bgr.copy()
    lines = navigation_hud_lines(guidance_target, ramp_estimate, navigation_path)
    _draw_translucent_panel_inplace(annotated, origin, lines)
    return annotated


_LEGEND_ENTRIES: tuple[tuple[str, tuple[int, int, int]], ...] = (
    ("RAMP CENTERLINE", _SEGMENT_RAMP_COLOR_BGR),
    ("FINAL ALIGNMENT", _SEGMENT_ALIGNMENT_COLOR_BGR),
    ("APPROACH", _SEGMENT_APPROACH_COLOR_BGR),
    ("ENTRANCE", _NAV_ENTRANCE_COLOR_BGR),
    ("TOP", _NAV_TOP_COLOR_BGR),
    ("LOOKAHEAD", _NAV_LOOKAHEAD_COLOR_BGR),
)


def draw_navigation_legend(
    frame_bgr: np.ndarray, *, origin: tuple[int, int] | None = None
) -> np.ndarray:
    """Return a copy of *frame_bgr* with a small color-key legend drawn
    (one dot + label per line) -- purely a label key, no geometry.
    Defaults to the bottom-left corner. Never mutates *frame_bgr*."""
    annotated: np.ndarray = frame_bgr.copy()
    height = annotated.shape[0]
    x, y = origin if origin is not None else (14, height - 120)
    for i, (label, color) in enumerate(_LEGEND_ENTRIES):
        row_y = y + i * 18
        cv2.circle(annotated, (x, row_y - 4), 5, color, -1)
        cv2.putText(
            annotated, label, (x + 14, row_y),
            cv2.FONT_HERSHEY_SIMPLEX, 0.4, _HUD_TEXT_COLOR_BGR, 1, cv2.LINE_AA,
        )
    return annotated


def _inside_box(point: tuple[int, int], x0: int, y0: int, size: int) -> bool:
    return x0 <= point[0] <= x0 + size and y0 <= point[1] <= y0 + size


def draw_top_down_guidance_inset(
    frame_bgr: np.ndarray,
    navigation_path: NavigationPath,
    *,
    size: int = 160,
    margin: int = 12,
    scale_m_per_px: float = 0.05,
) -> np.ndarray:
    """Return a copy of *frame_bgr* with a small top-down (camera-frame
    X-Z plane) schematic inset drawn in the top-right corner, showing
    *navigation_path*'s same three segments -- fixed ramp centerline,
    fixed staging alignment, flexible rover approach (the full curve,
    `approach_points`, not a straight line) -- using the exact same
    points as the main overlay (this function takes no separate
    `GuidanceTarget`/`RampEstimate` and computes nothing of its own).
    The debug LOOKAHEAD point, when available, is drawn too, and the
    same rover-direction arrow the main view draws (`desired_path_
    direction()`'s value for `navigation_path.active_section`), so this
    inset can never disagree with the main camera overlay about which
    way the rover should currently travel.

    As the rover moves, only the rover->staging approach curve's shape
    should visibly change; the staging->entrance->top structure is fixed
    relative to the ramp (see `build_navigation_path()`). Once `Path
    Section.RAMP` is active, the approach curve and the staging segment
    are both omitted here too, matching `draw_navigation_path()` -- see
    that function's docstring.

    This is a **simple, fixed-scale OpenCV schematic** (`scale_m_per_px`
    metres per pixel around a fixed origin) -- not a second projection
    or vision pipeline, and not the pinhole model `_project_point()`
    uses for the main camera view. A point further than the inset's
    visible radius (``size / 2 * scale_m_per_px`` metres) is simply not
    drawn, the same "skip rather than fabricate" convention as
    everywhere else in this module.

    Always draws the panel background and the rover origin marker, even
    when `navigation_path.quality` is `INVALID` -- only the target-
    derived points are conditionally skipped. Never mutates *frame_bgr*.
    """
    annotated: np.ndarray = frame_bgr.copy()
    height, width = annotated.shape[:2]
    inset_x0 = width - size - margin
    inset_y0 = margin

    inset_bottom_right = (inset_x0 + size, inset_y0 + size)
    overlay = annotated.copy()
    cv2.rectangle(overlay, (inset_x0, inset_y0), inset_bottom_right, _HUD_BG_COLOR_BGR, -1)
    cv2.addWeighted(overlay, 0.65, annotated, 0.35, 0.0, dst=annotated)
    cv2.rectangle(annotated, (inset_x0, inset_y0), inset_bottom_right, _HUD_TEXT_COLOR_BGR, 1)

    origin_px = (inset_x0 + size // 2, inset_y0 + size - 14)

    def to_inset_px(point_m: np.ndarray) -> tuple[int, int]:
        # Schematic X-Z plane only: +X right, +Z forward (drawn as "up").
        px = origin_px[0] + int(round(float(point_m[0]) / scale_m_per_px))
        py = origin_px[1] - int(round(float(point_m[2]) / scale_m_per_px))
        return px, py

    cv2.drawMarker(annotated, origin_px, _ROVER_ORIGIN_COLOR_BGR, cv2.MARKER_TRIANGLE_UP, 8, 2)

    if navigation_path.quality is not TargetQuality.INVALID:
        is_provisional = navigation_path.quality is TargetQuality.PROVISIONAL
        fixed_color = _SEGMENT_PROVISIONAL_COLOR_BGR if is_provisional else None
        in_ramp_mode = navigation_path.active_section is PathSection.RAMP

        if navigation_path.rover_point_camera_m is not None and navigation_path.active_section:
            direction = desired_path_direction(navigation_path, navigation_path.active_section)
            if direction is not None:
                arrow_tip = (
                    navigation_path.rover_point_camera_m
                    + _ROVER_DIRECTION_ARROW_LENGTH_M * direction
                )
                arrow_color = (
                    (fixed_color or _SEGMENT_RAMP_COLOR_BGR)
                    if in_ramp_mode
                    else _SEGMENT_APPROACH_COLOR_BGR
                )
                cv2.arrowedLine(
                    annotated, origin_px, to_inset_px(arrow_tip),
                    arrow_color, 1, tipLength=0.35,
                )

        staging_point = navigation_path.staging_point_camera_m
        staging_px = to_inset_px(staging_point) if staging_point is not None else None
        # Once RAMP is active, the approach curve and the staging segment
        # both represent a path back toward staging/entrance -- neither
        # is drawn anymore (see draw_navigation_path()); only landmark
        # dots and the ramp centerline remain.
        if not in_ramp_mode:
            if navigation_path.approach_points is not None:
                approach_pixels = [
                    to_inset_px(point) for point in navigation_path.approach_points
                ]
                for a_px, b_px in zip(approach_pixels, approach_pixels[1:], strict=False):
                    if _inside_box(a_px, inset_x0, inset_y0, size) or _inside_box(
                        b_px, inset_x0, inset_y0, size
                    ):
                        cv2.line(annotated, a_px, b_px, _SEGMENT_APPROACH_COLOR_BGR, 1, cv2.LINE_AA)
            if staging_px is not None and _inside_box(staging_px, inset_x0, inset_y0, size):
                staging_color = fixed_color or _SEGMENT_ALIGNMENT_COLOR_BGR
                cv2.circle(annotated, staging_px, 3, staging_color, -1)
        if navigation_path.lookahead_point_camera_m is not None:
            lookahead_px = to_inset_px(navigation_path.lookahead_point_camera_m)
            if _inside_box(lookahead_px, inset_x0, inset_y0, size):
                cv2.circle(annotated, lookahead_px, 2, _NAV_LOOKAHEAD_COLOR_BGR, -1)

        _staging_point, entrance_point = navigation_path.fixed_staging_segment
        entrance_px = to_inset_px(entrance_point) if entrance_point is not None else None
        if entrance_px is not None and _inside_box(entrance_px, inset_x0, inset_y0, size):
            cv2.circle(annotated, entrance_px, 3, _NAV_ENTRANCE_COLOR_BGR, -1)
            if (
                not in_ramp_mode
                and staging_px is not None
                and _inside_box(staging_px, inset_x0, inset_y0, size)
            ):
                alignment_color = fixed_color or _SEGMENT_ALIGNMENT_COLOR_BGR
                cv2.line(annotated, staging_px, entrance_px, alignment_color, 1, cv2.LINE_AA)

        _entrance_point, top_point = navigation_path.fixed_ramp_segment
        top_px = to_inset_px(top_point) if top_point is not None else None
        if top_px is not None and _inside_box(top_px, inset_x0, inset_y0, size):
            cv2.circle(annotated, top_px, 3, _NAV_TOP_COLOR_BGR, -1)
            if entrance_px is not None and _inside_box(entrance_px, inset_x0, inset_y0, size):
                ramp_color = fixed_color or _SEGMENT_RAMP_COLOR_BGR
                cv2.line(
                    annotated, entrance_px, top_px, ramp_color, 2 if in_ramp_mode else 1,
                    cv2.LINE_AA,
                )

    return annotated


def draw_docking_state(
    frame_bgr: np.ndarray,
    state: DockingState,
    command: DockingCommand,
) -> np.ndarray:
    """Return a copy of *frame_bgr* with *state* and *command* overlaid as text."""
    raise NotImplementedError(
        "draw_docking_state() is not implemented yet -- see module TODOs."
    )
