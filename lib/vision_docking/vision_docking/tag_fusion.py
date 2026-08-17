"""Multi-tag fusion layer: dynamic ramp geometry reconstruction.

    ... -> Pose Estimation -> Multi-Tag Fusion -> Ramp Estimate -> ...

Turns camera-relative `TagPose` values into a `RampEstimate` describing
the physical docking ramp -- entrance center/edges, top center/edges,
centerline, deployed length, heading, pitch -- all still camera-relative
(not rover/world-relative; that transform doesn't exist yet).

Why the ramp is modeled as two rigid sections, not one rigid body
------------------------------------------------------------------------
**This section describes the full, calibrated `TagFusion` model's
original 5-tag hardware assumption -- not the physical ramp's current
3-tag layout** (see "Three-tag centerline model" below, which is what
`scripts/test_ramp_geometry.py` actually wires up today). `TagFusion`/
`RampConfig`/`config/ramp.yaml` are left exactly as originally designed,
generic rigid-transform infrastructure that isn't itself hard-coded to
five tags -- reusable if/when a full per-tag mounting calibration for
the 3-tag ramp is undertaken -- but that calibration hasn't been
redone, so treat this section as historical/aspirational, not a
description of the currently-deployed hardware:

The physical ramp was originally two wheel tracks with inside railings,
in two parts that move independently:
    * the **entrance assembly** (tags 0, 1 -- bottom-left/bottom-right
      inside rail), which can extend by different amounts, tilt, and
      reorient relative to the rest of the ramp, and
    * the **upper assembly** (tags 2, 3, 4 -- middle-left, middle-right,
      top-center), whose three tags' relative geometry to *each other*
      is fixed (they're bolted to the same rigid section).
Treating all five tags as one rigid body would silently average over
that real physical motion and produce a wrong, made-up ramp shape the
moment the entrance deploys to a different length or angle than whatever
was true when a single fixed offset was measured. So this module
estimates each section's own pose independently (`RampSectionEstimate`,
once for the entrance, once for the upper assembly) and only combines
them at the very last step, into `entrance_center_m`/`top_center_m`/etc,
never into one fused rigid-body rotation.

Unknown/insufficient tags: never fabricated. A section with zero
visible+mounted tags, or whose visible tags disagree beyond
`config/ramp.yaml`'s tolerances with no majority, or whose confidence
falls under `min_confidence`, is `valid=False` with a `reason` -- never
a stale or guessed transform. See `combine_section_transforms()` and
`build_ramp_estimate()`.

Architecture: no sibling imports
------------------------------------------------------------------------
This module consumes only repository-owned `TagPose` values (via
`models.py`) -- never `pyrealsense2`, OpenCV image frames,
`pupil-apriltags`, `visualization.py`, or rover controls. Per this
project's no-sibling-imports rule (see `docs/architecture.md`), it also
never imports `config.py`, `pose.py`, or any other sibling module:
    * Configuration comes in as plain values through `TagFusion`'s
      constructor (`TagMount`/`SectionLandmarks` below, this module's
      own small types -- structurally similar to, but distinct from,
      `config.py`'s `TagMountConfig`/`EntranceSectionConfig`/
      `UpperSectionConfig` -- a caller converts one into the other,
      exactly as already happens for `AprilTagDetector`/
      `TagPoseEstimator`/`RealSenseCamera`).
    * The tag-local-frame correction this module needs (see below) is a
      small, independently-tested, self-contained copy of `pose.py`'s
      `correct_tag_frame()` rather than an import of it.

Transform convention (read this before touching any of the math below)
------------------------------------------------------------------------
Every rigid transform in this module is a 4x4 homogeneous matrix, named
``T_<into-frame>_<from-frame>``, meaning "the transform that carries a
point *expressed in* ``<from-frame>``'s coordinates *into*
``<into-frame>``'s coordinates": ``p_into = T_into_from @ [p_from, 1]``.
Composition reads left to right along a chain of frames:
``T_camera_section = T_camera_tag @ T_tag_section``.

    * ``T_camera_tag``: comes directly from a `TagPose` -- its
      `.translation` and its rotation (see below for *which* rotation).
    * ``T_section_tag``: how a tag is mounted, as a human would
      naturally *measure* it -- "tag N sits at this translation/
      rotation relative to the section's own origin/axes"
      (`config/ramp.yaml`'s `tag_mounts`, this module's `TagMount`).
    * ``T_tag_section``: `T_section_tag`'s inverse -- what the
      composition above actually needs. Computed by `invert_transform()`
      every time; never hand-measured, never assumed pre-inverted.
    * ``T_camera_section = T_camera_tag @ T_tag_section``: one tag's
      independent estimate of where its whole mounting section is,
      relative to the camera. See `estimate_transform_camera_section()`.

This module never mixes a `T_a_b` with a `T_b_a` in the same expression
without an explicit `invert_transform()` call in between -- every
composition here is validated (`validate_transform()`) before use.

Which tag rotation feeds `T_camera_tag`
------------------------------------------------------------------------
`TagPose.rotation` is the pose backend's **raw** tag-local frame (see
`pose.py`'s module docstring) -- not the *corrected*/intuitive frame
`TagPose.yaw_deg`/`pitch_deg`/`roll_deg` describe. This module's
`T_camera_tag` uses the **corrected** frame (via a local, self-contained
copy of `pose.correct_tag_frame()`, see `_corrected_tag_rotation()`)
specifically so that `config/ramp.yaml`'s `tag_mounts[...].rotation_deg`
values can be measured/entered in the same intuitive convention a human
would use with a protractor (and the same one `pose.py`'s `yaw_deg`
already uses) -- not the raw, axis-flipped backend convention.

Confidence and outlier rejection
------------------------------------------------------------------------
Deliberately simple and deterministic, not a fitted/learned model:
    * A single supporting tag always gets a fixed, reduced confidence
      (`_SINGLE_TAG_CONFIDENCE`) -- enough to be usable (e.g. tag 4 seen
      alone from far away) but visibly lower than multi-tag agreement.
    * Two or more tags: the largest *pairwise-agreeing* subset (every
      member within the configured tolerance of every other member) is
      accepted; the rest are rejected as outliers. A subset only counts
      if it is a strict majority of the tags considered (more than half)
      -- with exactly 2 disagreeing tags there is no principled way to
      prefer one over the other, so that case is invalid, not an
      arbitrary pick. Confidence scales linearly from 1.0 (perfect
      agreement) down to 0.5 at the tolerance boundary, times a fixed
      penalty if any outlier was rejected. See `combine_section_
      transforms()`.
    * A result is only reported `valid=True` if its confidence also
      meets `config/ramp.yaml`'s `min_confidence`.

Three-tag centerline model (simplified, calibration-light)
------------------------------------------------------------------------
Everything above (`TagMount`, `estimate_transform_camera_section()`,
`combine_section_transforms()`, `TagFusion`) is the **full** model: it
needs each tag's measured mounting transform relative to its section
(`config/ramp.yaml`). This module *also* provides a much simpler,
additive reconstruction path -- `RampPrototypeConfig`, `estimate_ramp_
from_three_tags()`, `ThreeTagRampEstimator` -- to validate that the
reconstructed ramp *looks* right before investing in that calibration.
Both paths produce the same `RampEstimate` type and coexist permanently;
switching from one to the other later is just swapping which estimator a
caller constructs (`TagFusion` and `ThreeTagRampEstimator` both expose
`.fuse(tag_poses, timestamp) -> RampEstimate`).

**Physical layout: three tags, all directly on the ramp centerline --
no more left/right pairs.** id 0 sits at the entrance, id 1 at the
middle, id 2 at the top; each tag's own (possibly offset-corrected)
position *is* the corresponding centerline landmark, not a pair
midpoint. `estimate_ramp_from_three_tags()` reads each tag's camera-
relative `TagPose.translation` directly -- no mounting transform, no
manually measured tag rotation, and no `T_camera_tag @ T_tag_section`
composition anywhere in this path (the same simplicity the earlier
pair-midpoint prototype already had). `entrance_offset_m`/`top_offset_m`
shift the entrance/top point along the entrance-to-top centerline
direction, for the (currently zero/no-op) case where a tag's center is
mounted some fixed distance from the true physical entrance/top point
(e.g. id 0 is not literally at ground level) -- verify the sign
convention once these become nonzero.

**Geometry authority -- id 0 is entrance, id 2 is top, id 1 is
supporting evidence only:**

    * **ids 0 + 2 visible** (id 1 optional): the strongest case.
      `entrance_center_m` = id 0's own position (+ offset),
      `top_center_m` = id 2's own position (+ offset); the centerline is
      exactly the straight line between them, `heading_deg`/
      `pitch_deg`/`deployed_length_m` all derived from it as usual. If
      id 1 is *also* visible, it is projected onto this already-fixed
      centerline as a pure diagnostic (`_project_onto_centerline()`,
      unchanged from the previous prototype) -- id 1 can **never** move
      `entrance_center_m`/`top_center_m` sideways, regardless of its own
      vertical height or pitch relative to the lower section (see
      "Middle" in this module's task-level documentation -- the middle
      section of a real ramp can hinge/change pitch independently of
      the lower section; only the *horizontal* centerline direction is
      assumed shared, and even that assumption is never used to move
      the authoritative id-0/id-2 points, only to sanity-check id 1).
    * **id 0 + id 1 visible, id 2 not**: entrance is authoritative (id
      0). The centerline direction is estimated *empirically* from the
      horizontal (X, Z) vector id 0 -> id 1 (more accurate than any
      single tag's own rotation reading) -- `top_center_m` is then
      reconstructed by extrapolating that direction forward from id 0
      by `nominal_entrance_to_top_horizontal_m` (its vertical component
      copied from id 0's own, a "assume flat beyond what's observed"
      simplification). `None` (not fabricated) if that nominal distance
      isn't configured.
    * **id 1 + id 2 visible, id 0 not**: top is authoritative (id 2),
      mirror of the case above -- entrance is reconstructed backward
      from id 1 by `nominal_entrance_to_top_horizontal_m`.
    * **only id 0 visible**: entrance is authoritative; there is no
      second point to derive a direction from, so the centerline
      direction falls back to id 0's own corrected heading (`TagPose.
      pitch_deg`, uncorrected by any mounting offset in this simplified
      path -- see the per-case docstring below) -- a `PROVISIONAL`
      direction, never a substitute for an empirically observed one.
      `top_center_m` is then reconstructed the same way as the two-tag
      fallback case, using the full nominal distance.
    * **only id 1 visible**: `PROVISIONAL`, using id 1's own corrected
      heading and *half* `nominal_entrance_to_top_horizontal_m` in each
      direction (id 1 is assumed to sit at the centerline's midpoint).
    * **only id 2 visible**: mirror of the id-0-alone case -- top is
      authoritative, entrance is reconstructed backward using id 2's own
      heading and the full nominal distance.
    * **none visible**: `INVALID`.

Whichever case applies, `RampEstimate.supporting_tag_ids` and `reason`
always distinguish exactly which id(s) actually produced the result --
see `visualization.py`'s ramp-source HUD diagnostics, derived from
these fields, never from a separate quality field on `RampEstimate`
itself (deliberately not added -- EXACT vs. PROVISIONAL is already
fully recoverable from `{0, 2} <= set(supporting_tag_ids)` and `valid`).

The primary ramp centerline is **always** the straight 3D line from the
entrance center to the top center, and only that line -- id 1 never
contributes to its position or direction when both id 0 and id 2 are
available, even when id 1's own pose has small errors.
`_project_onto_centerline()` instead projects id 1's position onto this
line as a pure diagnostic: how far off-axis it sits (`RampEstimate.
middle_perpendicular_distance_m`) and where along the line its
projection falls (`RampEstimate.middle_distance_along_centerline_m`),
both `None` whenever the centerline itself isn't defined (either
endpoint missing) or id 1 isn't visible. A perpendicular distance beyond
`_MIDDLE_AXIS_TOLERANCE_M` only lowers confidence and adds a `reason`
note -- it never bends the centerline itself.
"""
from __future__ import annotations

import itertools
import logging
import math
from dataclasses import dataclass

import numpy as np

from .models import RampEstimate, RampSectionEstimate, TagPose

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class RampGeometryError(Exception):
    """Base class for every error this module raises."""


class InvalidTransformError(RampGeometryError):
    """Raised when a 4x4 rigid transform (or its rotation/translation
    components) fails validation: wrong shape, non-finite, a rotation
    block that isn't orthonormal with determinant +1, or a bottom row
    that isn't exactly ``[0, 0, 0, 1]``."""


# ---------------------------------------------------------------------------
# Configuration shapes (this module's own -- see the "no sibling
# imports" docstring section above for why these aren't config.py's
# TagMountConfig/EntranceSectionConfig/UpperSectionConfig)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TagMount:
    """A tag's fixed mounting pose (``T_section_tag``), as measured in
    its ramp section's own local frame, metres/degrees.

    `translation_m`/`rotation_deg` are `None` when not yet measured --
    such a tag is simply excluded from section estimation (see
    `TagFusion`), never causing a crash or a fabricated value.
    """

    translation_m: tuple[float, float, float] | None
    rotation_deg: tuple[float, float, float] | None


@dataclass(frozen=True)
class SectionLandmarks:
    """Known landmark points in one ramp section's own local frame,
    metres. `None` fields mean "not yet measured/configured" -- the
    `RampEstimate` field that depends on it is simply `None` too."""

    center_m: tuple[float, float, float] | None
    left_m: tuple[float, float, float] | None
    right_m: tuple[float, float, float] | None


# ---------------------------------------------------------------------------
# Rigid transform primitives
# ---------------------------------------------------------------------------

_ROTATION_ORTHONORMALITY_TOLERANCE = 1e-4
_HOMOGENEOUS_BOTTOM_ROW = np.array([0.0, 0.0, 0.0, 1.0])


def validate_transform(transform: np.ndarray, *, name: str = "transform") -> None:
    """Validate that *transform* is a well-formed 4x4 homogeneous rigid
    transform: right shape, every element finite, rotation block
    orthonormal with determinant +1 (a proper rotation, not a
    reflection), and bottom row exactly ``[0, 0, 0, 1]`` (within
    floating-point tolerance).

    Raises:
        InvalidTransformError: any of the above does not hold.
    """
    if transform.shape != (4, 4):
        raise InvalidTransformError(f"{name} must have shape (4, 4), got {transform.shape}")
    if not np.all(np.isfinite(transform)):
        raise InvalidTransformError(f"{name} must be finite, got {transform}")

    bottom_row = transform[3, :]
    if not np.allclose(bottom_row, _HOMOGENEOUS_BOTTOM_ROW, atol=1e-6):
        raise InvalidTransformError(f"{name}'s bottom row must be [0, 0, 0, 1], got {bottom_row}")

    rotation = transform[:3, :3]
    if not np.allclose(rotation @ rotation.T, np.eye(3), atol=_ROTATION_ORTHONORMALITY_TOLERANCE):
        raise InvalidTransformError(
            f"{name}'s rotation block is not orthonormal (R @ R.T != I): {rotation}"
        )
    determinant = float(np.linalg.det(rotation))
    if not math.isclose(determinant, 1.0, abs_tol=_ROTATION_ORTHONORMALITY_TOLERANCE):
        raise InvalidTransformError(
            f"{name}'s rotation block must have determinant +1 (a proper rotation, "
            f"not a reflection), got {determinant}"
        )


def make_transform(rotation: np.ndarray, translation: np.ndarray) -> np.ndarray:
    """Build a validated 4x4 homogeneous rigid transform from a (3, 3)
    rotation and (3,) translation.

    Raises:
        InvalidTransformError: wrong shape, non-finite, or *rotation*
            isn't a proper rotation matrix.
    """
    if rotation.shape != (3, 3):
        raise InvalidTransformError(f"rotation must have shape (3, 3), got {rotation.shape}")
    if translation.shape != (3,):
        raise InvalidTransformError(f"translation must have shape (3,), got {translation.shape}")
    if not np.all(np.isfinite(rotation)) or not np.all(np.isfinite(translation)):
        raise InvalidTransformError("rotation and translation must both be finite")

    transform = np.eye(4, dtype=np.float64)
    transform[:3, :3] = rotation
    transform[:3, 3] = translation
    validate_transform(transform, name="constructed transform")
    return transform


def invert_transform(transform: np.ndarray) -> np.ndarray:
    """Return the inverse of a rigid transform, computed analytically
    (``R.T``, ``-R.T @ t``) rather than via a generic matrix inverse --
    exact for any transform that passes `validate_transform()`.

    Raises:
        InvalidTransformError: *transform* fails `validate_transform()`.
    """
    validate_transform(transform, name="transform")
    rotation = transform[:3, :3]
    translation = transform[:3, 3]
    inverse = np.eye(4, dtype=np.float64)
    inverse[:3, :3] = rotation.T
    inverse[:3, 3] = -rotation.T @ translation
    return inverse


def compose_transforms(*transforms: np.ndarray) -> np.ndarray:
    """Compose two or more validated rigid transforms left to right:
    ``compose_transforms(T_a_b, T_b_c) == T_a_c``.

    Raises:
        InvalidTransformError: fewer than 2 transforms given, or any
            given transform fails `validate_transform()`.
    """
    if len(transforms) < 2:
        raise InvalidTransformError("compose_transforms() needs at least 2 transforms")
    for i, transform in enumerate(transforms):
        validate_transform(transform, name=f"transforms[{i}]")
    result = transforms[0]
    for transform in transforms[1:]:
        result = result @ transform
    return result


def transform_point(transform: np.ndarray, point: np.ndarray) -> np.ndarray:
    """Apply a validated 4x4 rigid transform to a (3,) point, returning
    the transformed (3,) point.

    Raises:
        InvalidTransformError: *transform* fails `validate_transform()`,
            or *point* is not a finite (3,) array.
    """
    validate_transform(transform, name="transform")
    if point.shape != (3,):
        raise InvalidTransformError(f"point must have shape (3,), got {point.shape}")
    if not np.all(np.isfinite(point)):
        raise InvalidTransformError(f"point must be finite, got {point}")
    homogeneous = np.array([point[0], point[1], point[2], 1.0])
    transformed: np.ndarray = (transform @ homogeneous)[:3]
    return transformed


def rotation_matrix_from_euler_deg(yaw_deg: float, pitch_deg: float, roll_deg: float) -> np.ndarray:
    """Construct a rotation matrix from ``(yaw_deg, pitch_deg, roll_deg)``
    using the intrinsic Tait-Bryan Z-Y-X convention: ``Rz(yaw) @
    Ry(pitch) @ Rx(roll)``.

    This is the exact inverse operation of `vision_docking.pose.
    rotation_matrix_to_euler_deg()`; this module cannot import that
    function (no-sibling-imports rule), so it is re-derived and
    independently tested here rather than copied unchecked.

    Raises:
        InvalidTransformError: any input is non-finite.
    """
    if not all(math.isfinite(v) for v in (yaw_deg, pitch_deg, roll_deg)):
        raise InvalidTransformError(
            "yaw_deg/pitch_deg/roll_deg must all be finite, got "
            f"({yaw_deg}, {pitch_deg}, {roll_deg})"
        )
    yaw, pitch, roll = math.radians(yaw_deg), math.radians(pitch_deg), math.radians(roll_deg)
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cr, sr = math.cos(roll), math.sin(roll)
    rot_z = np.array([[cy, -sy, 0.0], [sy, cy, 0.0], [0.0, 0.0, 1.0]])
    rot_y = np.array([[cp, 0.0, sp], [0.0, 1.0, 0.0], [-sp, 0.0, cp]])
    rot_x = np.array([[1.0, 0.0, 0.0], [0.0, cr, -sr], [0.0, sr, cr]])
    rotation: np.ndarray = rot_z @ rot_y @ rot_x
    return rotation


def average_rotations(rotations: list[np.ndarray]) -> np.ndarray:
    """Combine multiple proper rotation matrices into the single
    rotation matrix closest to their arithmetic mean, via SVD-based
    orthogonal Procrustes projection -- a standard, simple way to average
    a small number of noisy rotation estimates while guaranteeing the
    result is itself a valid rotation (orthonormal, determinant +1).

    Raises:
        InvalidTransformError: *rotations* is empty.
    """
    if not rotations:
        raise InvalidTransformError("average_rotations() needs at least 1 rotation")
    if len(rotations) == 1:
        return rotations[0]
    mean = sum(rotations) / len(rotations)
    u, _singular_values, vt = np.linalg.svd(mean)
    result: np.ndarray = u @ vt
    if np.linalg.det(result) < 0:
        u = u.copy()
        u[:, -1] *= -1
        result = u @ vt
    return result


# Duplicated from pose.py's correct_tag_frame() -- this module must not
# import pose.py (no-sibling-imports rule), so this fixed, self-inverse
# correction is kept here as its own small, independently-tested copy
# rather than shared via import. See pose.py's module docstring for the
# empirical derivation of why this correction exists.
_TAG_FRAME_CORRECTION = np.diag([-1.0, -1.0, 1.0])


def _corrected_tag_rotation(rotation_raw: np.ndarray) -> np.ndarray:
    return rotation_raw @ _TAG_FRAME_CORRECTION


# ---------------------------------------------------------------------------
# Per-tag section estimate
# ---------------------------------------------------------------------------


def estimate_transform_camera_section(tag_pose: TagPose, mount: TagMount) -> np.ndarray:
    """Return one tag's independent estimate of ``T_camera_section``:
    where its mounting section is, relative to the camera, according to
    this single tag alone.

    Raises:
        InvalidTransformError: *mount* has a `None` `translation_m`/
            `rotation_deg` (callers must filter unmounted tags out
            first -- see `TagFusion`), or any intermediate transform
            fails validation.
    """
    if mount.translation_m is None or mount.rotation_deg is None:
        raise InvalidTransformError(
            "mount.translation_m/rotation_deg must both be set -- this tag has no "
            "configured mounting transform (see config/ramp.yaml's tag_mounts)"
        )
    t_camera_tag = make_transform(_corrected_tag_rotation(tag_pose.rotation), tag_pose.translation)
    t_section_tag = make_transform(
        rotation_matrix_from_euler_deg(*mount.rotation_deg), np.array(mount.translation_m)
    )
    t_tag_section = invert_transform(t_section_tag)
    return compose_transforms(t_camera_tag, t_tag_section)


# ---------------------------------------------------------------------------
# Combining multiple per-tag section estimates
# ---------------------------------------------------------------------------

_SINGLE_TAG_CONFIDENCE = 0.5
_OUTLIER_PENALTY = 0.9


def _agreement_confidence(disagreement_m: float, tolerance_m: float) -> float:
    """1.0 at perfect agreement, linearly down to 0.5 at the tolerance
    boundary -- a simple, deterministic mapping from "how much did
    independent estimates disagree" to "how much do we trust the
    combined result"."""
    if tolerance_m <= 0:
        return 1.0 if disagreement_m <= 0 else 0.0
    fraction = min(disagreement_m / tolerance_m, 1.0)
    return 1.0 - 0.5 * fraction


def _largest_agreement_clique(
    translations: list[np.ndarray], tolerance_m: float
) -> tuple[int, ...]:
    """Return indices (into *translations*) of the largest subset that
    are ALL pairwise within *tolerance_m* of each other, requiring that
    subset be a strict majority (more than half) of *translations* --
    otherwise there is no principled basis to prefer it over the rest.
    Ties (equal max-pairwise-distance) broken by iteration order.
    Brute-force -- fine for the small number of tags (<=3 per section)
    this module ever deals with. Returns `()` if no such subset exists
    (including when *translations* is empty)."""
    n = len(translations)
    for size in range(n, 0, -1):
        if size <= n - size:
            break
        best_combo: tuple[int, ...] = ()
        best_max_dist = float("inf")
        for combo in itertools.combinations(range(n), size):
            pairwise = [
                float(np.linalg.norm(translations[i] - translations[j]))
                for i, j in itertools.combinations(combo, 2)
            ]
            max_dist = max(pairwise) if pairwise else 0.0
            if max_dist <= tolerance_m and max_dist < best_max_dist:
                best_combo, best_max_dist = combo, max_dist
        if best_combo:
            return best_combo
    return ()


def combine_section_transforms(
    transforms_by_tag_id: dict[int, np.ndarray],
    *,
    tolerance_m: float,
    min_confidence: float,
    timestamp: float = 0.0,
) -> RampSectionEstimate:
    """Combine each tag's independent `T_camera_section` estimate
    (`estimate_transform_camera_section()`'s output, keyed by tag ID)
    into one `RampSectionEstimate` -- see this module's docstring for
    the outlier-rejection/confidence rules.

    Raises:
        InvalidTransformError: any given transform fails
            `validate_transform()`.
    """
    if not transforms_by_tag_id:
        return RampSectionEstimate(
            transform_camera_section=None,
            supporting_tag_ids=(),
            confidence=0.0,
            valid=False,
            reason="no visible/mounted tags for this section",
            timestamp=timestamp,
        )

    tag_ids = list(transforms_by_tag_id.keys())
    for tag_id in tag_ids:
        validate_transform(
            transforms_by_tag_id[tag_id], name=f"transform_camera_section (tag {tag_id})"
        )
    translations = [transforms_by_tag_id[tag_id][:3, 3] for tag_id in tag_ids]

    if len(tag_ids) == 1:
        valid = _SINGLE_TAG_CONFIDENCE >= min_confidence
        reason = f"single supporting tag (id={tag_ids[0]})"
        if not valid:
            reason += (
                f", confidence {_SINGLE_TAG_CONFIDENCE:.2f} below minimum {min_confidence:.2f}"
            )
        return RampSectionEstimate(
            transform_camera_section=transforms_by_tag_id[tag_ids[0]] if valid else None,
            supporting_tag_ids=(tag_ids[0],) if valid else (),
            confidence=_SINGLE_TAG_CONFIDENCE,
            valid=valid,
            reason=reason,
            timestamp=timestamp,
        )

    accepted_indices = _largest_agreement_clique(translations, tolerance_m)
    if not accepted_indices:
        pairwise = [
            round(float(np.linalg.norm(translations[i] - translations[j])), 4)
            for i, j in itertools.combinations(range(len(tag_ids)), 2)
        ]
        return RampSectionEstimate(
            transform_camera_section=None,
            supporting_tag_ids=(),
            confidence=0.0,
            valid=False,
            reason=(
                f"tags {tuple(tag_ids)} disagree beyond tolerance {tolerance_m:.3f}m "
                f"(pairwise distances {pairwise}m), no majority"
            ),
            timestamp=timestamp,
        )

    accepted_ids = tuple(tag_ids[i] for i in accepted_indices)
    rejected_ids = tuple(tag_ids[i] for i in range(len(tag_ids)) if i not in accepted_indices)
    accepted_translations = [translations[i] for i in accepted_indices]
    accepted_rotations = [transforms_by_tag_id[tag_ids[i]][:3, :3] for i in accepted_indices]

    max_pairwise = max(
        (
            float(np.linalg.norm(accepted_translations[a] - accepted_translations[b]))
            for a, b in itertools.combinations(range(len(accepted_translations)), 2)
        ),
        default=0.0,
    )
    confidence = _agreement_confidence(max_pairwise, tolerance_m)
    reason_parts = [
        f"tags {accepted_ids} agree within {tolerance_m:.3f}m (max pairwise {max_pairwise:.4f}m)"
    ]
    if rejected_ids:
        confidence *= _OUTLIER_PENALTY
        reason_parts.append(f"rejected outlier(s) {rejected_ids}")

    combined_translation = np.mean(accepted_translations, axis=0)
    combined_rotation = average_rotations(accepted_rotations)
    combined_transform = make_transform(combined_rotation, combined_translation)

    valid = confidence >= min_confidence
    if not valid:
        reason_parts.append(f"confidence {confidence:.2f} below minimum {min_confidence:.2f}")

    return RampSectionEstimate(
        transform_camera_section=combined_transform if valid else None,
        supporting_tag_ids=accepted_ids if valid else (),
        confidence=confidence,
        valid=valid,
        reason="; ".join(reason_parts),
        timestamp=timestamp,
    )


# ---------------------------------------------------------------------------
# Dynamic ramp reconstruction
# ---------------------------------------------------------------------------

_MIN_VECTOR_LENGTH_M = 1e-9


def _centerline_kinematics(
    entrance_center: np.ndarray | None, top_center: np.ndarray | None
) -> tuple[np.ndarray | None, np.ndarray | None, float | None, float | None, float | None]:
    """Return ``(centerline_direction, horizontal_approach_direction,
    deployed_length_m, heading_deg, pitch_deg)`` computed from
    *entrance_center* toward *top_center* -- shared by
    `build_ramp_estimate()` (full two-section model) and
    `estimate_ramp_from_midpoints()` (prototype midpoint model) so both
    compute heading/pitch/length identically. See `RampEstimate`'s
    docstring for the exact sign conventions. Returns all-`None` if
    either point is `None` or they're coincident."""
    if entrance_center is None or top_center is None:
        return None, None, None, None, None
    ramp_vector = top_center - entrance_center
    length = float(np.linalg.norm(ramp_vector))
    if length <= _MIN_VECTOR_LENGTH_M:
        return None, None, None, None, None

    centerline_direction = ramp_vector / length
    horizontal = np.array([ramp_vector[0], 0.0, ramp_vector[2]])
    horizontal_length = float(np.linalg.norm(horizontal))
    pitch_deg = math.degrees(math.atan2(-ramp_vector[1], horizontal_length))

    horizontal_approach_direction = None
    heading_deg = None
    if horizontal_length > _MIN_VECTOR_LENGTH_M:
        horizontal_approach_direction = horizontal / horizontal_length
        heading_deg = math.degrees(math.atan2(horizontal[0], horizontal[2]))

    return centerline_direction, horizontal_approach_direction, length, heading_deg, pitch_deg


def _landmark_in_camera(
    section: RampSectionEstimate, local_point: tuple[float, float, float] | None
) -> np.ndarray | None:
    if not section.valid or section.transform_camera_section is None or local_point is None:
        return None
    local_array = np.array(local_point, dtype=np.float64)
    return transform_point(section.transform_camera_section, local_array)


def _reconstruct_width_m(
    entrance: RampSectionEstimate,
    entrance_landmarks: SectionLandmarks,
    upper: RampSectionEstimate,
    upper_landmarks: SectionLandmarks,
    configured_width_m: float | None,
    width_tolerance_fraction: float,
) -> tuple[float, str | None]:
    """Return ``(width_m, warning)``: prefer the entrance-reconstructed
    width, then the upper-reconstructed width, then the configured
    value, then `0.0` as a last-resort sentinel. *warning* is `None`
    unless a reconstructed width disagreed with *configured_width_m*
    beyond *width_tolerance_fraction*."""
    candidates: list[tuple[str, float]] = []
    if (
        entrance.valid
        and entrance_landmarks.left_m is not None
        and entrance_landmarks.right_m is not None
    ):
        candidates.append((
            "entrance",
            float(
                np.linalg.norm(
                    np.array(entrance_landmarks.left_m) - np.array(entrance_landmarks.right_m)
                )
            ),
        ))
    if upper.valid and upper_landmarks.left_m is not None and upper_landmarks.right_m is not None:
        candidates.append((
            "upper",
            float(
                np.linalg.norm(np.array(upper_landmarks.left_m) - np.array(upper_landmarks.right_m))
            ),
        ))

    warning = None
    for source, value in candidates:
        if configured_width_m is not None and configured_width_m > 0:
            relative_error = abs(value - configured_width_m) / configured_width_m
            if relative_error > width_tolerance_fraction:
                warning = (
                    f"{source} reconstructed width {value:.4f}m disagrees with configured "
                    f"width_m={configured_width_m:.4f}m by {relative_error:.1%} "
                    f"(tolerance {width_tolerance_fraction:.1%})"
                )

    if candidates:
        return candidates[0][1], warning
    if configured_width_m is not None:
        return configured_width_m, None
    return 0.0, None


def build_ramp_estimate(
    entrance: RampSectionEstimate,
    upper: RampSectionEstimate,
    *,
    entrance_landmarks: SectionLandmarks,
    upper_landmarks: SectionLandmarks,
    width_m: float | None,
    width_tolerance_fraction: float,
    min_confidence: float,
    timestamp: float = 0.0,
) -> RampEstimate:
    """Combine an entrance and an upper `RampSectionEstimate` (plus each
    section's configured local landmark points) into one `RampEstimate`.

    Every field is computed independently of the overall `valid`
    verdict: e.g. `entrance_center_m` is populated whenever the entrance
    section itself is valid and its landmark is configured, regardless
    of whether the *upper* section (or the combined confidence) also
    clears the bar -- see this module's docstring on why partial
    results are reported, not hidden.
    """
    entrance_center = _landmark_in_camera(entrance, entrance_landmarks.center_m)
    entrance_left = _landmark_in_camera(entrance, entrance_landmarks.left_m)
    entrance_right = _landmark_in_camera(entrance, entrance_landmarks.right_m)
    top_center = _landmark_in_camera(upper, upper_landmarks.center_m)
    top_left = _landmark_in_camera(upper, upper_landmarks.left_m)
    top_right = _landmark_in_camera(upper, upper_landmarks.right_m)

    width, width_warning = _reconstruct_width_m(
        entrance, entrance_landmarks, upper, upper_landmarks, width_m, width_tolerance_fraction
    )

    supporting_tag_ids = tuple(
        sorted(set(entrance.supporting_tag_ids) | set(upper.supporting_tag_ids))
    )

    (
        centerline_direction,
        horizontal_approach_direction,
        deployed_length_m,
        heading_deg,
        pitch_deg,
    ) = _centerline_kinematics(entrance_center, top_center)

    if entrance.valid and upper.valid:
        confidence = min(entrance.confidence, upper.confidence)
        reason = (
            f"complete ramp geometry (entrance ids={entrance.supporting_tag_ids}, "
            f"upper ids={upper.supporting_tag_ids})"
        )
    elif entrance.valid:
        confidence = entrance.confidence
        reason = (
            f"entrance-only estimate (ids={entrance.supporting_tag_ids}); "
            f"upper invalid: {upper.reason}"
        )
    elif upper.valid:
        confidence = upper.confidence
        reason = (
            f"upper-only estimate (ids={upper.supporting_tag_ids}); "
            f"entrance invalid: {entrance.reason}"
        )
    else:
        confidence = 0.0
        reason = f"insufficient tags -- entrance: {entrance.reason}; upper: {upper.reason}"

    if width_warning:
        confidence *= _OUTLIER_PENALTY
        reason = f"{reason}; {width_warning}"

    valid = (entrance.valid or upper.valid) and confidence >= min_confidence
    if (entrance.valid or upper.valid) and not valid:
        reason = f"{reason} (confidence {confidence:.2f} below minimum {min_confidence:.2f})"

    return RampEstimate(
        entrance_center_m=entrance_center,
        middle_center_m=None,
        top_center_m=top_center,
        middle_perpendicular_distance_m=None,
        middle_distance_along_centerline_m=None,
        entrance_left_m=entrance_left,
        entrance_right_m=entrance_right,
        top_left_m=top_left,
        top_right_m=top_right,
        centerline_direction=centerline_direction,
        horizontal_approach_direction=horizontal_approach_direction,
        deployed_length_m=deployed_length_m,
        width_m=width,
        heading_deg=heading_deg,
        pitch_deg=pitch_deg,
        supporting_tag_ids=supporting_tag_ids,
        confidence=confidence,
        valid=valid,
        reason=reason,
        timestamp=timestamp,
    )


def compute_staging_point_m(
    ramp_estimate: RampEstimate, staging_distance_m: float
) -> np.ndarray | None:
    """Pure helper: ``entrance_center_m - staging_distance_m *
    horizontal_approach_direction`` -- a point *staging_distance_m*
    behind (outside) the entrance, along the ramp's horizontal approach
    direction.

    Not used anywhere in this module -- provided so a future steering/
    path-following layer has a ready-made, tested building block,
    per this milestone's scope (no steering logic here).

    Returns `None` if *ramp_estimate* lacks either `entrance_center_m` or
    `horizontal_approach_direction`.
    """
    if (
        ramp_estimate.entrance_center_m is None
        or ramp_estimate.horizontal_approach_direction is None
    ):
        return None
    return (
        ramp_estimate.entrance_center_m
        - staging_distance_m * ramp_estimate.horizontal_approach_direction
    )


# ---------------------------------------------------------------------------
# Three-tag centerline model (see this module's docstring section above)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ThreeTagRampConfig:
    """Minimal calibration for the three-tag centerline ramp model.

    Unlike `TagMount`/`SectionLandmarks`, this needs no per-tag mounting
    transform, no manually measured tag rotation, and no full transform
    tree -- `estimate_ramp_from_three_tags()` reads each relevant tag's
    camera-relative translation directly. `ramp_width_m` is `None` until
    measured (there are no edge landmarks in this model to reconstruct
    it from). `entrance_offset_m`/`top_offset_m` default to `0.0`
    (no-op) until measured. `nominal_entrance_to_top_horizontal_m` is
    `None` until measured -- see this module's docstring, "Geometry
    authority" list, for exactly which fallback cases need it; without
    it, a missing entrance/top endpoint is left `None` rather than
    fabricated.
    """

    ramp_width_m: float | None
    entrance_offset_m: float = 0.0
    top_offset_m: float = 0.0
    nominal_entrance_to_top_horizontal_m: float | None = None


_ENTRANCE_TAG_ID = 0
_MIDDLE_TAG_ID = 1
_TOP_TAG_ID = 2

# ids 0+2 (the strongest case) directly observe both authoritative
# endpoints -- full confidence, same as the full model's multi-tag
# agreement ceiling.
_EXACT_CONFIDENCE = 1.0
# ids 0+1 or ids 1+2 visible: one endpoint is authoritative (directly
# observed) but the other is reconstructed from an *empirically
# observed* two-point direction plus a configured nominal distance --
# more reliable than a single tag's own rotation reading, but still not
# a substitute for observing both 0 and 2 directly.
_TWO_TAG_FALLBACK_CONFIDENCE = 0.6


def _horizontal_direction_between(a: np.ndarray, b: np.ndarray) -> np.ndarray | None:
    """Return the horizontal (X, Z) unit vector from *a* toward *b* --
    an *empirically observed* direction from two real tag positions,
    always preferred over any single tag's own rotation reading (see
    this module's docstring, "Geometry authority" list). `None` if the
    horizontal separation between *a* and *b* is degenerate (near-zero)."""
    vector = b - a
    horizontal = np.array([vector[0], 0.0, vector[2]])
    length = float(np.linalg.norm(horizontal))
    if length <= _MIN_VECTOR_LENGTH_M:
        return None
    direction: np.ndarray = horizontal / length
    return direction


def _horizontal_direction_from_pitch_deg(pitch_deg: float) -> np.ndarray:
    """Purely horizontal unit vector for a tag's own observed
    `TagPose.pitch_deg` -- the same ``(sin(heading), 0, cos(heading))``
    convention `guidance.py`'s `_horizontal_direction_from_heading_deg()`
    uses (duplicated here, not imported -- this module's own no-sibling-
    imports rule). This is the **last-resort** PROVISIONAL direction,
    used only when exactly one ramp-centerline tag is visible and there
    is no second point to derive an empirical direction from -- see
    `_horizontal_direction_between()`, always preferred when available.
    No per-tag mounting-heading-offset correction is applied in this
    simplified path (unlike `guidance.py`'s own calibrated correction),
    matching this model's existing "no manually measured tag rotation"
    philosophy."""
    heading_rad = math.radians(pitch_deg)
    direction: np.ndarray = np.array([math.sin(heading_rad), 0.0, math.cos(heading_rad)])
    return direction


_MIDDLE_AXIS_TOLERANCE_M = 0.03


def _project_onto_centerline(
    entrance_center: np.ndarray | None,
    centerline_direction: np.ndarray | None,
    middle_center: np.ndarray | None,
) -> tuple[float | None, float | None, str | None]:
    """Project *middle_center* (id 1's own position) onto the
    entrance-to-top centerline (*entrance_center* + t *
    *centerline_direction*) as a pure diagnostic -- this never feeds
    back into the centerline itself; see this module's docstring,
    "Three-tag centerline model" section.

    Returns ``(perpendicular_distance_m, distance_along_centerline_m,
    warning)``, all `None` unless *entrance_center*,
    *centerline_direction*, and *middle_center* are all available.
    *warning* is set only if *perpendicular_distance_m* exceeds
    `_MIDDLE_AXIS_TOLERANCE_M`.
    """
    if entrance_center is None or centerline_direction is None or middle_center is None:
        return None, None, None
    offset = middle_center - entrance_center
    distance_along = float(np.dot(offset, centerline_direction))
    projected_point = entrance_center + distance_along * centerline_direction
    perpendicular_distance = float(np.linalg.norm(middle_center - projected_point))
    warning = None
    if perpendicular_distance > _MIDDLE_AXIS_TOLERANCE_M:
        warning = (
            f"id {_MIDDLE_TAG_ID} is {perpendicular_distance:.4f}m off the entrance-top "
            f"centerline (tolerance {_MIDDLE_AXIS_TOLERANCE_M:.4f}m)"
        )
    return perpendicular_distance, distance_along, warning


def estimate_ramp_from_three_tags(
    tag_poses: list[TagPose],
    config: ThreeTagRampConfig,
    *,
    min_confidence: float = 0.3,
    timestamp: float = 0.0,
) -> RampEstimate:
    """Three-tag centerline reconstruction: entrance/middle/top directly
    from ids 0/1/2's own positions -- see this module's docstring,
    "Three-tag centerline model" section, for the full visibility-case
    hierarchy (which endpoint is authoritative, which is reconstructed,
    and from what) and why this needs none of `TagFusion`'s per-tag
    mounting calibration.

    `RampEstimate.supporting_tag_ids` always reflects exactly which of
    ids 0/1/2 were visible and contributed -- `visualization.py`'s
    ENTRANCE/TOP/CENTERLINE-source and EXACT/PROVISIONAL HUD text is
    derived entirely from this (and `valid`), never from a separate
    quality field: `{0, 2} <= set(supporting_tag_ids)` means EXACT,
    anything else (that's still `valid`) means PROVISIONAL.
    """
    poses_by_id = {pose.tag_id: pose for pose in tag_poses}
    entrance_pose = poses_by_id.get(_ENTRANCE_TAG_ID)
    middle_pose = poses_by_id.get(_MIDDLE_TAG_ID)
    top_pose = poses_by_id.get(_TOP_TAG_ID)

    middle_center = middle_pose.translation.copy() if middle_pose is not None else None

    entrance_center: np.ndarray | None = None
    top_center: np.ndarray | None = None
    entrance_ids: tuple[int, ...] = ()
    top_ids: tuple[int, ...] = ()
    entrance_confidence = 0.0
    top_confidence = 0.0

    if entrance_pose is not None and top_pose is not None:
        # Strongest case: both authoritative endpoints directly
        # observed -- id 1, if also visible, never moves either one
        # (see _project_onto_centerline() below, called unconditionally
        # on the already-fixed centerline).
        entrance_center = entrance_pose.translation.copy()
        top_center = top_pose.translation.copy()
        entrance_ids = (_ENTRANCE_TAG_ID,)
        top_ids = (_TOP_TAG_ID,)
        entrance_confidence = _EXACT_CONFIDENCE
        top_confidence = _EXACT_CONFIDENCE

    elif entrance_pose is not None and middle_pose is not None:
        # id 0 authoritative for entrance; top reconstructed from the
        # empirically observed entrance->middle horizontal direction.
        entrance_center = entrance_pose.translation.copy()
        entrance_ids = (_ENTRANCE_TAG_ID,)
        entrance_confidence = _EXACT_CONFIDENCE
        direction = _horizontal_direction_between(
            entrance_pose.translation, middle_pose.translation
        )
        if direction is not None and config.nominal_entrance_to_top_horizontal_m is not None:
            top_center = entrance_center + config.nominal_entrance_to_top_horizontal_m * direction
            top_center[1] = entrance_center[1]
            top_ids = (_MIDDLE_TAG_ID,)
            top_confidence = _TWO_TAG_FALLBACK_CONFIDENCE

    elif middle_pose is not None and top_pose is not None:
        # id 2 authoritative for top; entrance reconstructed backward
        # from the empirically observed middle->top horizontal direction.
        top_center = top_pose.translation.copy()
        top_ids = (_TOP_TAG_ID,)
        top_confidence = _EXACT_CONFIDENCE
        direction = _horizontal_direction_between(middle_pose.translation, top_pose.translation)
        if direction is not None and config.nominal_entrance_to_top_horizontal_m is not None:
            entrance_center = top_center - config.nominal_entrance_to_top_horizontal_m * direction
            entrance_center[1] = top_center[1]
            entrance_ids = (_MIDDLE_TAG_ID,)
            entrance_confidence = _TWO_TAG_FALLBACK_CONFIDENCE

    elif entrance_pose is not None:
        # Only id 0 visible -- entrance authoritative; PROVISIONAL
        # direction from its own heading (no second point available).
        entrance_center = entrance_pose.translation.copy()
        entrance_ids = (_ENTRANCE_TAG_ID,)
        entrance_confidence = _SINGLE_TAG_CONFIDENCE
        if config.nominal_entrance_to_top_horizontal_m is not None:
            direction = _horizontal_direction_from_pitch_deg(entrance_pose.pitch_deg)
            top_center = entrance_center + config.nominal_entrance_to_top_horizontal_m * direction
            top_center[1] = entrance_center[1]
            top_ids = (_ENTRANCE_TAG_ID,)
            top_confidence = _SINGLE_TAG_CONFIDENCE

    elif middle_pose is not None:
        # Only id 1 visible -- PROVISIONAL, both endpoints reconstructed
        # half the nominal distance in each direction from id 1's own
        # heading (id 1 is assumed to sit at the centerline's midpoint).
        if config.nominal_entrance_to_top_horizontal_m is not None:
            half_distance = config.nominal_entrance_to_top_horizontal_m / 2.0
            direction = _horizontal_direction_from_pitch_deg(middle_pose.pitch_deg)
            assert middle_center is not None  # middle_pose is not None here
            entrance_center = middle_center - half_distance * direction
            entrance_center[1] = middle_center[1]
            top_center = middle_center + half_distance * direction
            top_center[1] = middle_center[1]
            entrance_ids = (_MIDDLE_TAG_ID,)
            top_ids = (_MIDDLE_TAG_ID,)
            entrance_confidence = _SINGLE_TAG_CONFIDENCE
            top_confidence = _SINGLE_TAG_CONFIDENCE

    elif top_pose is not None:
        # Only id 2 visible -- top authoritative; PROVISIONAL direction
        # from its own heading, mirroring the id-0-alone case.
        top_center = top_pose.translation.copy()
        top_ids = (_TOP_TAG_ID,)
        top_confidence = _SINGLE_TAG_CONFIDENCE
        if config.nominal_entrance_to_top_horizontal_m is not None:
            direction = _horizontal_direction_from_pitch_deg(top_pose.pitch_deg)
            entrance_center = top_center - config.nominal_entrance_to_top_horizontal_m * direction
            entrance_center[1] = top_center[1]
            entrance_ids = (_TOP_TAG_ID,)
            entrance_confidence = _SINGLE_TAG_CONFIDENCE

    # entrance_offset_m/top_offset_m shift the entrance/top points along
    # the entrance->top centerline direction ONLY -- computed here from
    # the raw (pre-offset) points, whichever case produced them, never
    # from id 1. Applying equal-and-opposite shifts along this direction
    # preserves the line's direction exactly, so recomputing kinematics
    # below on the shifted points yields the same direction, a longer
    # length.
    if entrance_center is not None and top_center is not None:
        preliminary_direction, _, _, _, _ = _centerline_kinematics(entrance_center, top_center)
        if preliminary_direction is not None:
            if config.entrance_offset_m:
                entrance_center = entrance_center - config.entrance_offset_m * preliminary_direction
            if config.top_offset_m:
                top_center = top_center + config.top_offset_m * preliminary_direction

    (
        centerline_direction,
        horizontal_approach_direction,
        deployed_length_m,
        heading_deg,
        pitch_deg,
    ) = _centerline_kinematics(entrance_center, top_center)

    middle_perpendicular_distance_m, middle_distance_along_centerline_m, middle_axis_warning = (
        _project_onto_centerline(entrance_center, centerline_direction, middle_center)
    )

    components: list[tuple[str, tuple[int, ...], float]] = []
    if entrance_center is not None:
        components.append(("entrance", entrance_ids, entrance_confidence))
    if middle_center is not None:
        components.append(("middle", (_MIDDLE_TAG_ID,), 1.0))
    if top_center is not None:
        components.append(("top", top_ids, top_confidence))

    supporting_tag_ids = tuple(sorted({tag_id for _, ids, _ in components for tag_id in ids}))
    confidence = min(c for _, _, c in components) if components else 0.0

    warnings = [w for w in (middle_axis_warning,) if w]
    if not components:
        reason = "insufficient tags: no entrance/middle/top ramp-centerline tag (ids 0-2) visible"
    else:
        reason = "three-tag centerline estimate: " + ", ".join(
            f"{name}(ids={ids})" for name, ids, _ in components
        )
        if warnings:
            confidence *= _OUTLIER_PENALTY
            reason += "; " + "; ".join(warnings)

    valid = bool(components) and confidence >= min_confidence
    if components and not valid:
        reason += f" (confidence {confidence:.2f} below minimum {min_confidence:.2f})"

    return RampEstimate(
        entrance_center_m=entrance_center,
        middle_center_m=middle_center,
        top_center_m=top_center,
        middle_perpendicular_distance_m=middle_perpendicular_distance_m,
        middle_distance_along_centerline_m=middle_distance_along_centerline_m,
        entrance_left_m=None,
        entrance_right_m=None,
        top_left_m=None,
        top_right_m=None,
        centerline_direction=centerline_direction,
        horizontal_approach_direction=horizontal_approach_direction,
        deployed_length_m=deployed_length_m,
        width_m=config.ramp_width_m if config.ramp_width_m is not None else 0.0,
        heading_deg=heading_deg,
        pitch_deg=pitch_deg,
        supporting_tag_ids=supporting_tag_ids,
        confidence=confidence,
        valid=valid,
        reason=reason,
        timestamp=timestamp,
    )


class ThreeTagRampEstimator:
    """Thin, stateful wrapper around `estimate_ramp_from_three_tags()`.

    Exposes the same `.fuse(tag_poses, timestamp) -> RampEstimate`
    interface as `TagFusion`, so a caller (e.g.
    `scripts/test_ramp_geometry.py`) can swap between this prototype
    three-tag centerline model and the full two-section calibrated model
    without changing any other code.
    """

    def __init__(self, config: ThreeTagRampConfig, *, min_confidence: float = 0.3) -> None:
        self._config = config
        self._min_confidence = min_confidence

    def fuse(self, tag_poses: list[TagPose], timestamp: float = 0.0) -> RampEstimate:
        """Return the current `RampEstimate` reconstructed from *tag_poses*."""
        return estimate_ramp_from_three_tags(
            tag_poses, self._config, min_confidence=self._min_confidence, timestamp=timestamp
        )


# ---------------------------------------------------------------------------
# TagFusion
# ---------------------------------------------------------------------------


class TagFusion:
    """Reconstructs the ramp's dynamic, camera-relative geometry from
    per-tag camera-relative poses.

    Constructor takes the deployment's known ramp geometry explicitly
    (mirroring `config/ramp.yaml`, loaded by `config.load_ramp_config()`)
    rather than reading configuration itself, keeping this class
    independently testable with synthetic `TagPose` inputs -- see this
    module's docstring for the full reasoning and transform convention.
    """

    def __init__(
        self,
        *,
        entrance_tag_ids: tuple[int, ...],
        entrance_landmarks: SectionLandmarks,
        upper_tag_ids: tuple[int, ...],
        upper_landmarks: SectionLandmarks,
        tag_mounts: dict[int, TagMount],
        width_m: float | None = None,
        entrance_agreement_tolerance_m: float = 0.05,
        upper_agreement_tolerance_m: float = 0.08,
        width_tolerance_fraction: float = 0.03,
        min_confidence: float = 0.3,
    ) -> None:
        self._entrance_tag_ids = entrance_tag_ids
        self._entrance_landmarks = entrance_landmarks
        self._upper_tag_ids = upper_tag_ids
        self._upper_landmarks = upper_landmarks
        self._tag_mounts = tag_mounts
        self._width_m = width_m
        self._entrance_agreement_tolerance_m = entrance_agreement_tolerance_m
        self._upper_agreement_tolerance_m = upper_agreement_tolerance_m
        self._width_tolerance_fraction = width_tolerance_fraction
        self._min_confidence = min_confidence

    def estimate_entrance(
        self, tag_poses: list[TagPose], timestamp: float = 0.0
    ) -> RampSectionEstimate:
        """Return the entrance assembly's (ids 0-1) `RampSectionEstimate`."""
        return self._estimate_section(
            tag_poses, self._entrance_tag_ids, self._entrance_agreement_tolerance_m, timestamp
        )

    def estimate_upper(
        self, tag_poses: list[TagPose], timestamp: float = 0.0
    ) -> RampSectionEstimate:
        """Return the upper assembly's (ids 2-4) `RampSectionEstimate`."""
        return self._estimate_section(
            tag_poses, self._upper_tag_ids, self._upper_agreement_tolerance_m, timestamp
        )

    def _estimate_section(
        self,
        tag_poses: list[TagPose],
        section_tag_ids: tuple[int, ...],
        tolerance_m: float,
        timestamp: float,
    ) -> RampSectionEstimate:
        poses_by_id = {pose.tag_id: pose for pose in tag_poses}
        transforms_by_tag_id: dict[int, np.ndarray] = {}
        for tag_id in section_tag_ids:
            pose = poses_by_id.get(tag_id)
            mount = self._tag_mounts.get(tag_id)
            if (
                pose is None
                or mount is None
                or mount.translation_m is None
                or mount.rotation_deg is None
            ):
                continue
            transforms_by_tag_id[tag_id] = estimate_transform_camera_section(pose, mount)
        return combine_section_transforms(
            transforms_by_tag_id,
            tolerance_m=tolerance_m,
            min_confidence=self._min_confidence,
            timestamp=timestamp,
        )

    def fuse(self, tag_poses: list[TagPose], timestamp: float = 0.0) -> RampEstimate:
        """Return the current `RampEstimate` reconstructed from *tag_poses*."""
        entrance = self.estimate_entrance(tag_poses, timestamp)
        upper = self.estimate_upper(tag_poses, timestamp)
        return build_ramp_estimate(
            entrance,
            upper,
            entrance_landmarks=self._entrance_landmarks,
            upper_landmarks=self._upper_landmarks,
            width_m=self._width_m,
            width_tolerance_fraction=self._width_tolerance_fraction,
            min_confidence=self._min_confidence,
            timestamp=timestamp,
        )
