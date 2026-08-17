"""Virtual staging-point generation, with graceful degradation under
partial AprilTag visibility.

    ... -> Pose Estimation -> Guidance Target -> ...

Turns camera-relative `TagPose` values into a `GuidanceTarget`: a
virtual staging point some fixed distance before the ramp entrance, on
the rover's ground plane, plus the bearing/distance/heading-error a
rover would need to travel to reach it.

This is deliberately **not** steering. There is no wheel command, no
throttle, no PID/Pure-Pursuit/Stanley controller, and no rover
integration here -- this module's only job is to answer "where, in the
camera frame, is the point the rover should aim for."

This module does **not** consume a `RampEstimate` at all. Every field
below comes directly from `TagPose` values -- this module never imports
or reads `tag_fusion.py`'s output. `tag_fusion.py` and the rest of the
vision pipeline are untouched by this module.

Physical layout: three ramp-centerline tags -- id 0 = entrance-center
(the authoritative entrance tag), id 1 = middle-center, id 2 =
top-center. There are no more bottom/upper tag pairs, and no
pair-spacing-based reconstruction; every tag directly represents a
point on the centerline. See `tag_fusion.py`'s module docstring,
"Three-tag centerline model" section, for the equivalent ramp-geometry
hierarchy this module's own EXACT/PROVISIONAL tiers deliberately mirror
(this module answers a narrower question -- just the entrance position
and approach heading needed for a staging point -- but uses the same
tag-visibility priority and the same "prefer an empirically observed
two-point direction over any single tag's own heading" principle).

The EXACT/PROVISIONAL/INVALID hierarchy
------------------------------------------------------------------------
The rover must be able to start approaching the staging area even when
the entrance tag (id 0) isn't currently visible -- e.g. while still far
away, or momentarily occluded. `compute_guidance_target()` tries three
tiers, in this strict priority order, and never lets a lower tier
override a higher one that's currently available:

    1. `TargetQuality.EXACT` -- ids 0 **and** 2 both visible: the
       entrance is *directly observed* at tag 0, and the approach
       heading comes from the *empirically observed* horizontal
       direction from tag 0 toward tag 2 (the two points' own positions
       agree with each other regardless of either tag's own heading
       reading, unlike a single tag's noisy heading -- see
       "Single-tag reconstruction is PROVISIONAL, not EXACT" below).
       Confidence is always `1.0`. This is the *only* case this module
       treats as `EXACT` -- it requires the same {0, 2} pair
       `tag_fusion.py`'s `RampEstimate` uses to mean EXACT geometry, so
       the two modules' notions of "exact" stay aligned.
    2. `TargetQuality.PROVISIONAL` -- tried **only when tier 1 produced
       nothing at all** (ids 0 and 2 aren't simultaneously visible).
       Two families of sub-case, tried in this order:
           a. Two ramp-centerline tags visible (just not both 0 and 2):
              id 0 + id 1, or id 1 + id 2. The entrance is either
              directly observed (id 0 + id 1: entrance from tag 0
              itself) or reconstructed backward from tag 2 using a
              configured nominal entrance-to-top distance (id 1 + id
              2). Either way the heading is still the *empirically
              observed* direction between the two visible points, never
              a single tag's own heading -- `_TWO_TAG_PROVISIONAL_
              CONFIDENCE`.
           b. Exactly one ramp-centerline tag visible: id 0 alone, id 2
              alone, or id 1 alone, in that priority order. The
              entrance is directly observed only for id 0 alone; for id
              2 alone or id 1 alone it is projected backward using the
              configured nominal entrance-to-top distance (halved for
              id 1, since it sits at the centerline's midpoint). All
              three use that one tag's own mount-corrected heading --
              the least reliable direction source this module has --
              `_SINGLE_TAG_PROVISIONAL_CONFIDENCE`, always below every
              sub-case of (a).
       Because the true entrance-to-top distance can change (ramp
       extension), any projection through the nominal distance is
       always approximate; if it isn't configured, the sub-cases that
       need it simply don't fire -- never fabricated.
    3. `TargetQuality.INVALID` -- no tier produced anything, or the
       ground plane isn't configured.

Since tier 2 is only ever attempted after tier 1 fails outright, a
currently-valid `EXACT` result can never be overridden by a
`PROVISIONAL` one, and the moment ids 0 and 2 become visible again, the
very next frame's call immediately produces `EXACT` again -- there is
no extra state or hysteresis needed for that part of the transition.
See "Bounded transition" below for the one part of the requested
transition behavior this module deliberately does *not* implement.

Single-tag reconstruction is PROVISIONAL, not EXACT
------------------------------------------------------------------------
Even though id 0 alone gives a *directly observed* entrance position,
this module still reports that case as `PROVISIONAL`, never `EXACT`:
the approach heading in that case is necessarily driven by that one
tag's own *corrected heading* (`TagPose.pitch_deg`, mount-corrected),
and heading is measurement-noisy in a way an empirically observed
direction between two real tag positions is not (two tags' positions
agree with each other regardless of either one's heading reading; one
tag's own heading reading can drift from frame to frame even though
nothing about the ramp's real orientation changed). `EXACT` is reserved
for the one case where *both* the entrance position and the approach
heading are as reliable as this module can make them -- ids 0 and 2
both visible. `GuidanceTarget.reason`/`supporting_tag_ids` always
distinguish which case produced a given target (see `visualization.py`'s
`ENTRANCE SOURCE` HUD field). None of the single-tag or two-tag
fallbacks are *removed* by this rule -- they are still useful for
approaching the ramp before ids 0 and 2 are simultaneously visible --
only their claimed precision is honest about the difference.

Two-tag and single-tag PROVISIONAL priority
------------------------------------------------------------------------
In descending order of how much is actually observed (see
`compute_guidance_target()`'s call order, which mirrors this exactly):

    a. id 0 + id 1 visible (id 2 not): entrance = tag 0's own position
       (directly observed, same as `EXACT`); heading = the empirically
       observed tag 0 -> tag 1 direction. `_TWO_TAG_PROVISIONAL_
       CONFIDENCE`.
    b. id 1 + id 2 visible (id 0 not): heading = the empirically
       observed tag 1 -> tag 2 direction; entrance is then projected
       backward from tag 2's own position by the configured
       `provisional.nominal_entrance_to_top_horizontal_m`, along that
       heading. Same confidence as (a) -- both sub-cases rest on an
       empirically observed two-point direction, the thing this module
       always prefers over a single tag's heading.
    c. id 0 alone: entrance = tag 0's own position; heading = tag 0's
       own mount-corrected heading (no second point available).
       `_SINGLE_TAG_PROVISIONAL_CONFIDENCE`.
    d. id 2 alone: heading = tag 2's own mount-corrected heading;
       entrance projected backward from tag 2 by the full nominal
       entrance-to-top distance. Same confidence as (c).
    e. id 1 alone: heading = tag 1's own mount-corrected heading;
       entrance projected backward from tag 1 by *half* the nominal
       entrance-to-top distance (id 1 is assumed to sit at the
       centerline's midpoint). Same confidence as (c) and (d).

Whichever sub-case applies, a projected (as opposed to directly
observed) entrance is always: ``reference_point -
nominal_entrance_to_top_horizontal_m * horizontal_direction`` (halved
for id 1 alone) -- the same subtraction-along-horizontal-direction
shape as the final staging-point formula below, just applied once more
to walk back from "somewhere on the ramp centerline" to "an approximate
entrance." This never uses any tag's own *vertical* position or the
ramp's incline to determine this -- see "Horizontal direction and the
ground plane" below; that section's reasoning applies identically here.

Architecture: no sibling imports
------------------------------------------------------------------------
Like every other pipeline module (see `docs/architecture.md`), this one
imports only from `models.py`. Its own small `RampTagMount`/
`GroundPlane`/`ProvisionalCalibration`/`StagingCalibration` types are
structurally similar to, but a deliberately separate declaration from,
`config.py`'s `RampTagMountConfig`/`CameraToGroundConfig`/
`ProvisionalConfig`/`StagingConfig` -- a caller
(`scripts/test_ramp_geometry.py`) converts one into the other, exactly
as already happens for `AprilTagDetector`/`TagPoseEstimator`/
`RealSenseCamera`/`TagFusion`.

Which `TagPose` field actually holds "horizontal facing direction"
------------------------------------------------------------------------
Every horizontal-heading calculation in this module reads
`TagPose.pitch_deg` -- **not** `TagPose.yaw_deg` -- and the internal
vocabulary is named accordingly (`approach_heading_deg`,
`mount_heading_offset_deg`, `corrected_heading_deg`; never "yaw"
anywhere in this module's own code or types). This is a deliberate,
settled decision, not a placeholder: this repository's own tested
Euler decomposition (`pose.rotation_matrix_to_euler_deg()`, confirmed
against `tests/test_pose.py`'s known-rotation cases) shows that
rotation about the camera's **vertical** axis -- i.e. panning a tag
left/right, the physically-intuitive meaning of "heading," and what a
ramp-heading correction actually needs -- is reported in `TagPose.
pitch_deg`. `TagPose.yaw_deg` instead measures rotation about the
camera's *optical* axis (in-plane spin, like a clock hand), which is
unrelated to which way a tag physically faces and must never feed a
heading calculation here.

This is purely a **naming mismatch in `pose.py`'s Euler-angle
convention**, not a physical property of pitch: nothing here treats a
tag's or the ramp's true vertical tilt/incline as a heading input.
`TagPose.pitch_deg`'s *field name* happens to carry horizontal panning
under this repository's tested Z-Y-X decomposition and camera-mounting
convention; the physical concept "vertical ramp incline" is a
completely separate thing (see "Horizontal direction and the ground
plane" below -- ramp pitch/incline is never read by this module at
all, by any name). Do not let the shared word "pitch" conflate the
two: `TagPose.pitch_deg` (the Euler component this module sources
headings from) and "ramp pitch" (the vertical incline this module
never touches) refer to different concepts that merely share a name
for an unrelated historical reason.

Mounting-heading correction, and when it applies at all
------------------------------------------------------------------------
Each tag may be mechanically mounted at a fixed angle relative to the
ramp's true approach heading. ``corrected_heading_deg =
tag_pose.pitch_deg - mount.mount_heading_offset_deg``
(`StagingCalibration.tags[id].mount_heading_offset_deg`,
`config/staging.yaml`) removes that fixed offset before the value
represents the ramp approach heading. This correction is used **only**
by the single-tag PROVISIONAL sub-cases (c/d/e above) -- whenever an
*empirically observed* direction between two real tag positions is
available (`EXACT`, and PROVISIONAL sub-cases a/b), that direction is
used directly and no per-tag mount correction is needed at all, since
it comes from real geometry rather than either tag's own reported
rotation. There is no longer a multi-tag circular-mean combination step
-- with one tag per landmark, at most one heading source is ever
selected per call.

Horizontal direction and the ground plane
------------------------------------------------------------------------
The horizontal ramp-approach direction is built **purely** from the
corrected heading of whichever tier/tags are in use: ``(sin(heading),
0, cos(heading))`` -- never from `TagPose.yaw_deg`, never from
`TagPose.roll_deg`, never from any tag's own vertical tilt, and never
from ``top_center - entrance_center`` (there is no `RampEstimate` here
to derive that from in the first place). Its vertical (camera Y)
component is always exactly `0.0`.

The staging point's height comes from a separately configured ground
plane (`StagingCalibration.ground_plane.camera_height_m`,
`config/staging.yaml`'s `camera_to_ground.camera_height_m`) -- the
camera's own fixed mounting height above the ground, **not** any tag's
measured vertical position, for *any* tier. `entrance_ground_point_
camera_m` is the (possibly provisional) entrance's horizontal (X, Z)
position with its vertical component replaced by this configured
height; `target_point_camera_m` is computed from *that*, so the ramp's
vertical incline and any tag's own height can never move the staging
point vertically -- only the entrance's horizontal position, the
corrected approach heading, the configured ground plane, and the
configured staging distance can. This is also why a middle-tag height
change (e.g. the middle ramp section changing pitch) can never move an
`EXACT` staging point sideways: `EXACT` never reads id 1 at all.

Staging point formula
------------------------------------------------------------------------
::

    target_point_camera_m = (
        entrance_ground_point_camera_m - staging_distance_m * horizontal_direction
    )

`horizontal_direction` points from the entrance toward the ramp (the
same sign convention `tag_fusion.py`'s `horizontal_approach_direction`
used), so subtracting a positive multiple of it moves the target to the
approach side of the entrance, not behind it. This exact formula is
shared by both `EXACT` and `PROVISIONAL` tiers -- only how
`entrance_ground_point_camera_m`/the heading feeding
`horizontal_direction` were obtained differs between them.

The staging point is fixed relative to the ramp, not to the camera
------------------------------------------------------------------------
The formula above is a camera-frame *expression* of a ramp-local
relationship, not an independent camera-relative calculation. Define a
ramp-local frame with origin at the entrance, `forward` its horizontal
approach direction, and `up` vertical; then the staging point is simply

::

    staging_local = origin + (-staging_distance_m) * forward   # == [0, 0, -staging_distance_m]

a single fixed offset that never depends on the camera. Transforming
that offset into camera coordinates for a given frame's camera pose
(rotation `R`, translation `t`, i.e. `T_camera_ramp`) gives

::

    staging_camera = R @ staging_local + t
                    = (R @ origin + t) + (-staging_distance_m) * (R @ forward)
                    = entrance_ground_point_camera_m - staging_distance_m * horizontal_direction

which is exactly `target_point_camera_m` above -- `entrance_ground_
point_camera_m` *is* `R @ origin + t` (the entrance transformed into
camera coordinates) and `horizontal_direction` *is* `R @ forward` (the
heading transformed the same way). Both quantities are re-derived from
this frame's own tag observations, so they rotate and translate
*together*, consistently, under whatever the camera's actual pose is;
their difference (`staging - entrance`, in ramp-local terms) is
therefore invariant to `R` and `t` alike, and always has magnitude
exactly `staging_distance_m`. Concretely: moving or rotating the camera
changes `entrance_ground_point_camera_m` and `horizontal_direction`
individually (that's expected -- the camera-frame *coordinates* of a
fixed ramp point must change as the camera moves), but never changes
the ramp-relative relationship between the staging point and the
entrance. Nothing here is computed independently from camera-relative
target bearing, and no rover/camera position ever feeds into
`staging_distance_m` itself.

This is precisely why no separate explicit ramp-local-frame object is
needed anywhere in this codebase: the formula above already *is* that
transform, just written in terms of the camera-frame quantities this
module computes every frame anyway. `visualization.py`'s `NavigationPath`
relies on this invariant directly -- its `entrance_ground_point_camera_m`
(never the elevated, raw tag-midpoint fiducial -- see that module's
docstring) and `staging_point_camera_m` are exactly `entrance_ground_
point_camera_m` and `target_point_camera_m` from this module, so its
horizontal staging-to-entrance distance is always `staging_distance_m`,
regardless of the camera's pose that frame.

Raw target bearing (this milestone)
------------------------------------------------------------------------
`GuidanceTarget.target_bearing_deg` answers a **different** question
than `approach_heading_deg` above: not "which way is the ramp facing"
but "relative to where the rover is right now, which way is the
staging point." The two are independent and must never be confused or
combined -- a rover can sit well off to one side of the ramp's
centerline while the ramp itself faces it squarely (`approach_heading_
deg` ~= 0) with a large, nonzero `target_bearing_deg`, or vice versa.
See `tests/test_guidance.py`'s independence test for a worked example.

Formula, using this repository's documented camera coordinate
convention (`pose.py`'s module docstring: +X right, +Y down, +Z
forward -- verified against the backend, not assumed)::

    target_bearing_deg = degrees(atan2(lateral_error_m, forward_error_m))
    lateral_error_m = target_point_camera_m[0]   # camera +X, right
    forward_error_m = target_point_camera_m[2]   # camera +Z, forward

The vertical (camera Y) component is never read here, for the same
reason it's never read anywhere else in this module (see "Horizontal
direction and the ground plane" above). **Positive means the target is
to the rover's right, negative means to its left, 0 means straight
ahead** -- the same sign convention as `RampEstimate.heading_deg` and
`approach_heading_deg`.

**Rover position == camera origin, for this prototype.**
`target_point_camera_m` is already camera-relative, and this module has
no separate notion of a rover body frame offset from the camera (no
measured camera-to-rover mounting position yet) -- so the bearing above
is computed as if the rover's own current position were exactly the
camera's optical center. This is an explicit, documented simplification
(see `GuidanceTarget.target_bearing_deg`'s docstring too), not an
oversight; a future milestone that measures the physical camera-to-
rover offset would translate `target_point_camera_m` into a rover body
frame first, but this formula would still apply unchanged after that.

This works **identically** for `EXACT` and `PROVISIONAL` targets -- the
formula only ever reads `target_point_camera_m`, which both tiers
populate via the exact same formula above; bearing generation itself
has no notion of which tag combination produced its input.  `INVALID`
targets never reach this code path at all -- `target_bearing_deg` is
`None` alongside every other geometric field (see `_invalid_target()`).

**Near-zero horizontal distance:** if `distance_to_target_m` is below
`_AT_TARGET_TOLERANCE_M`, the rover is (numerically) already at the
target and the direction to travel is undefined -- `atan2` would still
return *some* finite angle, but it would be an artifact of measurement
noise rather than a meaningful direction, and nothing here should
pretend otherwise. This case is handled explicitly rather than left to
chance: `target_bearing_deg` is reported as `0.0` by convention (never
a divide-by-zero, never an unstable or NaN result -- `atan2` itself
never raises even at the literal origin, but a noisy near-origin case
deserves a deliberate answer, not an incidental one), and `reason` notes
that the value wasn't actually measured. This is a per-frame numerical
safety guard, not an operational "arrival" tolerance for a future
docking state machine -- that decision is separate, later work.

**Targets behind the rover are not rejected.** If `forward_error_m` is
negative, `atan2` naturally returns a bearing approaching +/-180 degrees
rather than raising or behaving unpredictably -- this is deliberately
left as-is (not clamped, not treated as invalid) so the raw geometry can
be observed on real hardware before any future milestone decides how a
controller should react to a target that's behind the rover.

**Raw, unfiltered, on purpose.** `target_bearing_deg` is computed fresh
every call from the current frame's tag poses alone -- no EMA, moving-
average, or median filter; no rate limiting or hysteresis; no PID/
Stanley/Pure-Pursuit; no wheel-angle conversion. This milestone exists
specifically to let the *raw* signal be observed on physical hardware
before any smoothing or control law gets layered on top, in a future
`docking_controller.py` milestone.

Confidence and validity
------------------------------------------------------------------------
`GuidanceTarget.confidence` is `1.0` for `EXACT` (ids 0+2);
`_TWO_TAG_PROVISIONAL_CONFIDENCE` for the two-tag `PROVISIONAL`
sub-cases (ids 0+1 or 1+2); `_SINGLE_TAG_PROVISIONAL_CONFIDENCE` for
the single-tag `PROVISIONAL` sub-cases (id 0, 1, or 2 alone), always
below every two-tag value; `0.0` when `quality` is `INVALID`. No
per-tag agreement/outlier checks anywhere (unlike `tag_fusion.py`'s
section combination). `GuidanceTarget.valid` is `True` iff a target
point could be computed at all (some tier's entrance usable *and* the
ground plane configured).

Bounded transition: deliberately not implemented here
------------------------------------------------------------------------
This was specced to also want "a short bounded transition/filter" when
jumping from a `PROVISIONAL` target to a newly-available `EXACT` one, to
avoid a large single-frame jump. This module does **not** implement
that: it is a deliberately stateless, per-frame pure function (see
`compute_guidance_target()`), and a rate-limiter/slew-rate filter needs
memory of previous frames to do anything. Introducing that here would
mean this module is no longer stateless, which cuts against every other
pipeline module's design (see `docs/architecture.md`) and against how
this module has been built and tested so far. The transition *is*
immediate and correct (the tier hierarchy re-evaluates fresh every
frame, so `EXACT` takes over the instant it's available, never
overridden by a stale `PROVISIONAL` value) -- bounding how fast a
downstream consumer is allowed to *react* to that jump is a natural fit
for `docking_controller.py`'s future steering loop, which will need
per-frame state anyway (e.g. for a PID controller's integral term), and
is deferred there rather than added here.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .models import GuidanceTarget, TagPose, TargetQuality

_ENTRANCE_TAG_ID = 0
_MIDDLE_TAG_ID = 1
_TOP_TAG_ID = 2

# PROVISIONAL, two ramp-centerline tags visible (id0+id1 or id1+id2) --
# both sub-cases rest on an empirically observed two-point direction,
# ranked above every single-tag PROVISIONAL case, but always below
# EXACT's 1.0.
_TWO_TAG_PROVISIONAL_CONFIDENCE = 0.6

# PROVISIONAL, exactly one ramp-centerline tag visible (id 0, 1, or 2
# alone) -- the least reliable direction source this module has, since
# it depends on that one tag's own heading reading with no second point
# to check it against.
_SINGLE_TAG_PROVISIONAL_CONFIDENCE = 0.3

# Below this horizontal distance, target_bearing_deg is reported as 0.0
# by convention instead of trusting atan2 on a near-zero, noise-dominated
# vector -- see this module's docstring, "Raw target bearing" section.
# A numerical-stability guard, not an operational arrival tolerance.
_AT_TARGET_TOLERANCE_M = 0.01

# Below this horizontal separation, an empirically observed direction
# between two tag positions is treated as degenerate (near-zero) rather
# than trusted -- mirrors tag_fusion.py's _MIN_VECTOR_LENGTH_M.
_MIN_HORIZONTAL_SEPARATION_M = 1e-9


# ---------------------------------------------------------------------------
# Configuration shapes (this module's own -- see the "no sibling
# imports" docstring section above)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RampTagMount:
    """One ramp-centerline tag's (ids 0-2) known mounting-heading
    offset, degrees (see this module's docstring for why this is a
    "heading," sourced from `TagPose.pitch_deg`, not `yaw_deg`). Used
    only by the single-tag PROVISIONAL sub-cases -- the EXACT tier and
    the two-tag PROVISIONAL sub-cases use an empirically observed
    two-point direction instead, which needs no mount correction."""

    mount_heading_offset_deg: float


@dataclass(frozen=True)
class GroundPlane:
    """The camera's fixed height above the ground plane, metres --
    `None` until measured (no target, of either tier, can be generated
    without it)."""

    camera_height_m: float | None


@dataclass(frozen=True)
class ProvisionalCalibration:
    """Calibration for the `PROVISIONAL` tier's entrance-projection
    sub-cases. `None` until a nominal value is chosen -- without it, the
    id1+id2, id-2-alone, and id-1-alone sub-cases can't fire (see this
    module's docstring for why the true distance can't just be
    assumed)."""

    nominal_entrance_to_top_horizontal_m: float | None


@dataclass(frozen=True)
class StagingCalibration:
    """Calibration for staging-point generation."""

    staging_distance_m: float
    tags: dict[int, RampTagMount]
    ground_plane: GroundPlane
    provisional: ProvisionalCalibration


# ---------------------------------------------------------------------------
# Heading correction and empirical two-point direction
# ---------------------------------------------------------------------------


class _HeadingMount(Protocol):
    """Structural type satisfied by `RampTagMount` -- lets
    `_corrected_heading_deg()` work with any type having this field
    without a forced, semantically-meaningless common base class."""

    @property
    def mount_heading_offset_deg(self) -> float: ...


def _corrected_heading_deg(tag_pose: TagPose, mount: _HeadingMount) -> float:
    """Subtract *mount*'s known mounting-heading offset from
    *tag_pose*'s own observed `pitch_deg` -- **not** `yaw_deg`; see this
    module's docstring for why `pitch_deg` is the field that actually
    carries horizontal panning under this repository's tested Euler
    convention -- so what remains represents the ramp approach heading
    rather than however the tag happens to be mechanically rotated in
    its mount."""
    return tag_pose.pitch_deg - mount.mount_heading_offset_deg


def _empirical_heading_deg(from_point: np.ndarray, to_point: np.ndarray) -> float | None:
    """Horizontal heading (degrees) of the *empirically observed*
    direction from *from_point* toward *to_point* -- preferred over any
    single tag's own corrected heading whenever two real ramp-centerline
    positions are available (see this module's docstring). `None` if the
    horizontal separation is degenerate (near-zero)."""
    vector = to_point - from_point
    horizontal_x = float(vector[0])
    horizontal_z = float(vector[2])
    if math.hypot(horizontal_x, horizontal_z) <= _MIN_HORIZONTAL_SEPARATION_M:
        return None
    return math.degrees(math.atan2(horizontal_x, horizontal_z))


def _horizontal_direction_from_heading_deg(heading_deg: float) -> np.ndarray:
    """Purely horizontal unit vector for a corrected ramp-approach
    heading: ``(sin(heading), 0, cos(heading))`` -- see this module's
    docstring for why this, and only this, defines the horizontal
    direction."""
    heading_rad = math.radians(heading_deg)
    direction: np.ndarray = np.array([math.sin(heading_rad), 0.0, math.cos(heading_rad)])
    return direction


# ---------------------------------------------------------------------------
# Tier 1: EXACT (ids 0 and 2, BOTH visible only)
# ---------------------------------------------------------------------------


def _reconstruct_exact(
    poses_by_id: dict[int, TagPose],
) -> tuple[np.ndarray | None, float | None, tuple[int, ...], float]:
    """Return ``(entrance_center_m, approach_heading_deg,
    supporting_tag_ids, confidence)`` -- the *only* case this module
    treats as `EXACT`. ``(None, None, (), 0.0)`` unless both ids 0 and 2
    are currently visible. Needs no mount configuration at all -- the
    heading is the empirically observed tag-0-to-tag-2 direction, not
    either tag's own rotation reading."""
    entrance_pose = poses_by_id.get(_ENTRANCE_TAG_ID)
    top_pose = poses_by_id.get(_TOP_TAG_ID)
    if entrance_pose is None or top_pose is None:
        return None, None, (), 0.0

    heading = _empirical_heading_deg(entrance_pose.translation, top_pose.translation)
    if heading is None:
        return None, None, (), 0.0

    return entrance_pose.translation.copy(), heading, (_ENTRANCE_TAG_ID, _TOP_TAG_ID), 1.0


# ---------------------------------------------------------------------------
# Tier 2a: PROVISIONAL, two ramp-centerline tags (id0+id1 or id1+id2)
# ---------------------------------------------------------------------------


def _reconstruct_two_tag_provisional(
    poses_by_id: dict[int, TagPose],
    provisional: ProvisionalCalibration,
) -> tuple[np.ndarray | None, float | None, tuple[int, ...], float]:
    """PROVISIONAL tier, two ramp-centerline tags visible -- tried only
    once `_reconstruct_exact()` above has already failed (ids 0 and 2
    are never simultaneously visible when this runs). id 0 + id 1:
    entrance is tag 0's own position (directly observed); id 1 + id 2:
    entrance is projected backward from tag 2 using `provisional.
    nominal_entrance_to_top_horizontal_m`. Both use an empirically
    observed two-point direction, never a single tag's own heading.
    ``(None, None, (), 0.0)`` if neither sub-case has what it needs."""
    entrance_pose = poses_by_id.get(_ENTRANCE_TAG_ID)
    middle_pose = poses_by_id.get(_MIDDLE_TAG_ID)
    top_pose = poses_by_id.get(_TOP_TAG_ID)

    if entrance_pose is not None and middle_pose is not None:
        heading = _empirical_heading_deg(entrance_pose.translation, middle_pose.translation)
        if heading is not None:
            return (
                entrance_pose.translation.copy(),
                heading,
                (_ENTRANCE_TAG_ID, _MIDDLE_TAG_ID),
                _TWO_TAG_PROVISIONAL_CONFIDENCE,
            )

    if (
        middle_pose is not None
        and top_pose is not None
        and provisional.nominal_entrance_to_top_horizontal_m is not None
    ):
        heading = _empirical_heading_deg(middle_pose.translation, top_pose.translation)
        if heading is not None:
            direction = _horizontal_direction_from_heading_deg(heading)
            entrance = (
                top_pose.translation - provisional.nominal_entrance_to_top_horizontal_m * direction
            )
            return entrance, heading, (_MIDDLE_TAG_ID, _TOP_TAG_ID), _TWO_TAG_PROVISIONAL_CONFIDENCE

    return None, None, (), 0.0


# ---------------------------------------------------------------------------
# Tier 2b: PROVISIONAL, exactly one ramp-centerline tag visible
# ---------------------------------------------------------------------------


def _reconstruct_single_tag_provisional(
    poses_by_id: dict[int, TagPose],
    calibration: StagingCalibration,
) -> tuple[np.ndarray | None, float | None, tuple[int, ...], float]:
    """PROVISIONAL tier, exactly one ramp-centerline tag visible -- tried
    only once both tiers above have failed. Priority: id 0 alone, then
    id 2 alone, then id 1 alone (mirrors `tag_fusion.py`'s single-tag
    case priority). Each sub-case uses that one tag's own
    mount-corrected heading, and (for ids 1/2) `provisional.
    nominal_entrance_to_top_horizontal_m` to project an entrance
    estimate. ``(None, None, (), 0.0)`` if the one visible tag has no
    usable mount, or (for ids 1/2) the nominal distance isn't
    configured."""
    entrance_pose = poses_by_id.get(_ENTRANCE_TAG_ID)
    middle_pose = poses_by_id.get(_MIDDLE_TAG_ID)
    top_pose = poses_by_id.get(_TOP_TAG_ID)
    nominal = calibration.provisional.nominal_entrance_to_top_horizontal_m

    if entrance_pose is not None:
        mount = calibration.tags.get(_ENTRANCE_TAG_ID)
        if mount is not None:
            heading = _corrected_heading_deg(entrance_pose, mount)
            return (
                entrance_pose.translation.copy(),
                heading,
                (_ENTRANCE_TAG_ID,),
                _SINGLE_TAG_PROVISIONAL_CONFIDENCE,
            )

    if top_pose is not None and nominal is not None:
        mount = calibration.tags.get(_TOP_TAG_ID)
        if mount is not None:
            heading = _corrected_heading_deg(top_pose, mount)
            direction = _horizontal_direction_from_heading_deg(heading)
            entrance = top_pose.translation - nominal * direction
            return entrance, heading, (_TOP_TAG_ID,), _SINGLE_TAG_PROVISIONAL_CONFIDENCE

    if middle_pose is not None and nominal is not None:
        mount = calibration.tags.get(_MIDDLE_TAG_ID)
        if mount is not None:
            heading = _corrected_heading_deg(middle_pose, mount)
            direction = _horizontal_direction_from_heading_deg(heading)
            entrance = middle_pose.translation - (nominal / 2.0) * direction
            return entrance, heading, (_MIDDLE_TAG_ID,), _SINGLE_TAG_PROVISIONAL_CONFIDENCE

    return None, None, (), 0.0


# ---------------------------------------------------------------------------
# Diagnostics and the invalid-target constructor
# ---------------------------------------------------------------------------


def _ramp_tag_failure_reason(
    poses_by_id: dict[int, TagPose], calibration: StagingCalibration
) -> str:
    """Describes why none of the EXACT, two-tag PROVISIONAL, or
    single-tag PROVISIONAL tiers produced anything -- called only once
    all three have already failed."""
    visible_ids = tuple(sorted(set(poses_by_id) & {_ENTRANCE_TAG_ID, _MIDDLE_TAG_ID, _TOP_TAG_ID}))
    if not visible_ids:
        return "no ramp-centerline tags (ids 0-2) visible"

    entrance_visible = _ENTRANCE_TAG_ID in visible_ids
    nominal_configured = calibration.provisional.nominal_entrance_to_top_horizontal_m is not None
    if not entrance_visible and not nominal_configured:
        return (
            f"ramp-centerline tag(s) {visible_ids} visible but id {_ENTRANCE_TAG_ID} "
            "(entrance) is not, and provisional.nominal_entrance_to_top_horizontal_m is "
            "not configured -- refusing to fabricate an entrance"
        )

    usable_ids = tuple(tag_id for tag_id in visible_ids if tag_id in calibration.tags)
    if not usable_ids:
        return (
            f"ramp-centerline tag(s) {visible_ids} visible but missing "
            "mount_heading_offset_deg configuration"
        )

    return (
        f"ramp-centerline tag(s) {visible_ids} visible (usable: {usable_ids}) but "
        "insufficient to reconstruct an entrance"
    )


def _invalid_target(reason: str, timestamp: float) -> GuidanceTarget:
    return GuidanceTarget(
        entrance_center_m=None,
        entrance_ground_point_camera_m=None,
        target_point_camera_m=None,
        approach_heading_deg=None,
        target_bearing_deg=None,
        distance_to_target_m=None,
        lateral_error_m=None,
        forward_error_m=None,
        heading_error_deg=None,
        staging_distance_m=None,
        ground_plane_height_m=None,
        supporting_tag_ids=(),
        quality=TargetQuality.INVALID,
        confidence=0.0,
        valid=False,
        reason=reason,
        timestamp=timestamp,
    )


def _target_reason(quality: TargetQuality, supporting_tag_ids: tuple[int, ...]) -> str:
    if quality is TargetQuality.EXACT:
        return (
            "EXACT: entrance directly observed at tag 0, approach heading from the "
            "empirically observed tag 0 -> tag 2 direction"
        )
    if supporting_tag_ids == (_ENTRANCE_TAG_ID, _MIDDLE_TAG_ID):
        return (
            "PROVISIONAL: entrance directly observed at tag 0, approach heading from the "
            "empirically observed tag 0 -> tag 1 direction -- tag 2 not visible"
        )
    if supporting_tag_ids == (_MIDDLE_TAG_ID, _TOP_TAG_ID):
        return (
            "PROVISIONAL: entrance estimated backward from tag 2 using the empirically "
            "observed tag 1 -> tag 2 direction and a nominal entrance-to-top distance -- "
            "tag 0 not visible"
        )
    if supporting_tag_ids == (_ENTRANCE_TAG_ID,):
        return (
            "PROVISIONAL: entrance directly observed at tag 0, but approach heading is from "
            "tag 0's own single-tag heading -- sensitive to heading/pose noise, not a "
            "substitute for also observing tag 2"
        )
    if supporting_tag_ids == (_TOP_TAG_ID,):
        return (
            "PROVISIONAL: entrance estimated from tag 2's own single-tag heading plus a "
            "nominal entrance-to-top distance -- tag 0 not visible"
        )
    return (
        "PROVISIONAL: entrance estimated from tag 1's own single-tag heading plus half a "
        "nominal entrance-to-top distance -- tag 0 not visible"
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def compute_guidance_target(
    tag_poses: list[TagPose],
    calibration: StagingCalibration,
    *,
    timestamp: float = 0.0,
) -> GuidanceTarget:
    """Return the `GuidanceTarget` implied by *tag_poses* and
    *calibration*, trying `EXACT` (ids 0+2) then the two-tag
    `PROVISIONAL` fallback then the single-tag `PROVISIONAL` fallback,
    each only if every higher tier produced nothing at all -- see this
    module's docstring for the full hierarchy and formulas.
    """
    poses_by_id = {pose.tag_id: pose for pose in tag_poses}

    entrance_point, heading, supporting_tag_ids, confidence = _reconstruct_exact(poses_by_id)
    quality = TargetQuality.EXACT

    if entrance_point is None or heading is None:
        quality = TargetQuality.PROVISIONAL
        entrance_point, heading, supporting_tag_ids, confidence = _reconstruct_two_tag_provisional(
            poses_by_id, calibration.provisional
        )

    if entrance_point is None or heading is None:
        entrance_point, heading, supporting_tag_ids, confidence = (
            _reconstruct_single_tag_provisional(poses_by_id, calibration)
        )

    if entrance_point is None or heading is None:
        return _invalid_target(_ramp_tag_failure_reason(poses_by_id, calibration), timestamp)

    if calibration.ground_plane.camera_height_m is None:
        return _invalid_target(
            "ground plane not configured (camera_to_ground.camera_height_m is null)", timestamp
        )

    ground_height = calibration.ground_plane.camera_height_m
    entrance_ground_point = np.array([entrance_point[0], ground_height, entrance_point[2]])
    horizontal_direction = _horizontal_direction_from_heading_deg(heading)
    target_point_camera_m = (
        entrance_ground_point - calibration.staging_distance_m * horizontal_direction
    )

    lateral_error_m = float(target_point_camera_m[0])
    forward_error_m = float(target_point_camera_m[2])
    distance_to_target_m = math.hypot(lateral_error_m, forward_error_m)

    at_target = distance_to_target_m < _AT_TARGET_TOLERANCE_M
    if at_target:
        # Direction is undefined when the rover is (numerically) already
        # at the target -- see "Near-zero horizontal distance" above.
        target_bearing_deg = 0.0
    else:
        target_bearing_deg = math.degrees(math.atan2(lateral_error_m, forward_error_m))
    # Rover body frame == camera frame for now -- see module docstring.
    heading_error_deg = target_bearing_deg

    reason = _target_reason(quality, supporting_tag_ids)
    if at_target:
        reason = (
            f"{reason}; rover is within {_AT_TARGET_TOLERANCE_M:g}m of the staging point "
            "horizontally -- target_bearing_deg reported as 0.0 by convention, not measured"
        )

    return GuidanceTarget(
        entrance_center_m=entrance_point,
        entrance_ground_point_camera_m=entrance_ground_point,
        target_point_camera_m=target_point_camera_m,
        approach_heading_deg=heading,
        target_bearing_deg=target_bearing_deg,
        distance_to_target_m=distance_to_target_m,
        lateral_error_m=lateral_error_m,
        forward_error_m=forward_error_m,
        heading_error_deg=heading_error_deg,
        staging_distance_m=calibration.staging_distance_m,
        ground_plane_height_m=ground_height,
        supporting_tag_ids=supporting_tag_ids,
        quality=quality,
        confidence=confidence,
        valid=True,
        reason=reason,
        timestamp=timestamp,
    )


class GuidanceTargetGenerator:
    """Thin, stateless wrapper around `compute_guidance_target()`.

    Mirrors `tag_fusion.py`'s estimator classes (`TagFusion`,
    `ThreeTagRampEstimator`) -- a small class holding just the
    calibration, with a `.generate()` method doing the real work via the
    pure function above (independently testable without constructing
    this class at all).
    """

    def __init__(self, calibration: StagingCalibration) -> None:
        self._calibration = calibration

    def generate(self, tag_poses: list[TagPose], timestamp: float = 0.0) -> GuidanceTarget:
        """Return the current `GuidanceTarget` reconstructed from *tag_poses*."""
        return compute_guidance_target(tag_poses, self._calibration, timestamp=timestamp)
