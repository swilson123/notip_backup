"""Configuration loading layer.

Reads `config/camera.yaml`, `config/tags.yaml`, `config/docking.yaml`,
`config/ramp.yaml`, `config/ramp_prototype.yaml`, and
`config/staging.yaml` into small, typed configuration dataclasses --
deliberately separate from `models.py`'s pipeline data models (a
`CameraConfig` is "how to build a camera source"; a `CameraIntrinsics`
is "what that camera source reported"). Every other module in this
package receives its configuration through explicit constructor
parameters (dependency injection) rather than importing and reading this
module's YAML files itself -- `config.py` is where that YAML gets read
exactly once, in whatever top-level script or example wires the pipeline
together. `tag_fusion.py` follows this rule too: it never imports this
module, and its own small `TagMount`/`SectionLandmarks` types (distinct
from, but structurally similar to, this module's `TagMountConfig`/
`EntranceSectionConfig`/`UpperSectionConfig`) are what its constructor
actually takes -- a caller reads `RampConfig` here and converts it into
those plain values, exactly as already happens for
`AprilTagDetector`/`TagPoseEstimator`/`RealSenseCamera`.

`load_ramp_config()` is deliberately permissive about *values* (every
physical measurement may be `null`/absent, since the ramp may not be
fully calibrated yet) but strict about *shape* (the YAML's structural
keys must all be present, and any measurement that *is* given must be
well-formed) -- see `RampConfig`'s docstring for exactly why, and
`docs/ramp_calibration.md` for the measurement guide.

`load_ramp_prototype_config()` parses the much smaller, additive
`config/ramp_prototype.yaml` for `tag_fusion.py`'s three-tag centerline
model (`RampPrototypeConfig`) -- entirely separate from, and not a
replacement for, `RampConfig`/`load_ramp_config()` above. See
`RampPrototypeConfig`'s docstring and `tag_fusion.py`'s module docstring
("Three-tag centerline model" section) for why both configurations and
both reconstruction paths coexist.

`load_staging_config()` parses `config/staging.yaml` (`StagingConfig`)
for `guidance.py`'s staging-point generation -- the three ramp-
centerline tags' (ids 0 entrance, 1 middle, 2 top) mounting-heading
offsets, the camera's fixed height above the ground plane, and the
provisional entrance-to-top distance estimate. "Heading" here means
horizontal panning, sourced from each tag's `TagPose.pitch_deg` -- see
`guidance.py`'s module docstring for why that field, not `yaw_deg`, is
the one this repository's tested Euler convention actually reports it
in. See `StagingConfig`'s docstring for the full reasoning; this is
independent of, and does not replace, `RampConfig`/`RampPrototypeConfig`
above.

`load_approach_path_config()` parses the small `config/approach_
path.yaml` (`ApproachPathConfig`) for `visualization.py`'s ROVER ->
STAGING curved-approach generator (a cubic Bezier in horizontal camera
X/Z space) -- purely prototype tuning constants (handle lengths, curve
sample density, debug lookahead distance), no ramp/staging geometry of
its own. See `ApproachPathConfig`'s docstring and `visualization.py`'s
"Navigation HUD" section comment for how these are used.

`load_tag_tracking_config()` parses the tiny `config/tag_tracking.yaml`
(`TagTrackingConfig`) for `tag_tracking.py`'s temporal pose-hold layer --
a single tuning value (`hold_timeout_s`), no ramp/staging/pose geometry
of its own. See `TagTrackingConfig`'s docstring and `tag_tracking.py`'s
module docstring for the full LIVE/HELD/LOST state machine this tunes.

TODO(vision-docking): implement `load_docking_config()` -- parse
    `config/docking.yaml` (see that file for the exact schema and field
    documentation) into `DockingConfig` below using `PyYAML`, validating
    required fields eagerly rather than failing lazily deep inside a
    pipeline module. `load_camera_config()` and `load_tags_config()`
    below are templates for it.
TODO(vision-docking): decide on a validation approach (plain
    hand-written checks vs. a schema library) once the config schema has
    stabilized past this initial skeleton.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# config/camera.yaml
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CameraConfig:
    """Parsed contents of `config/camera.yaml`. See that file for field docs."""

    model: str
    serial_number: str
    width: int
    height: int
    fps: int
    enable_depth: bool
    intrinsics_file: Path | None
    auto_exposure: bool
    manual_exposure: int
    frame_timeout_ms: int = 5000


# ---------------------------------------------------------------------------
# config/tags.yaml
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TagDetectorConfig:
    """Detector-tuning subsection of `config/tags.yaml`."""

    quad_decimate: float
    quad_sigma: float
    nthreads: int
    min_decision_margin: float
    refine_edges: bool = True
    decode_sharpening: float = 0.25
    debug: bool = False


@dataclass(frozen=True)
class KnownTag:
    """One entry in `config/tags.yaml`'s `known_tags` list.

    `overall_size_m` and `pose_tag_size_m` are deliberately distinct and
    must not be confused: `overall_size_m` is the complete printed
    artwork's size (including its required white border), while
    `pose_tag_size_m` is the width of the black tag36h11 border square
    only -- the value `pupil-apriltags` needs for pose estimation. See
    `scripts/generate_tags.py` (which derives both from the same source)
    and `generated_tags/README.md` for exactly how they're measured.
    """

    tag_id: int
    role: str
    overall_size_m: float
    pose_tag_size_m: float
    position_m: tuple[float, float, float]
    rotation_deg: tuple[float, float, float]


@dataclass(frozen=True)
class TagsConfig:
    """Parsed contents of `config/tags.yaml`. See that file for field docs."""

    family: str
    default_size_m: float
    detector: TagDetectorConfig
    known_tags: tuple[KnownTag, ...] = field(default_factory=tuple)


# ---------------------------------------------------------------------------
# config/docking.yaml
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DockingConfig:
    """Parsed contents of `config/docking.yaml`. See that file for field docs."""

    approach_distance_m: float
    alignment_distance_m: float
    final_approach_distance_m: float
    docked_distance_m: float
    max_heading_error_deg: float
    max_linear_velocity_mps: float
    max_angular_velocity_radps: float
    min_ramp_confidence: float
    max_missed_frames: int
    control_loop_hz: float


# ---------------------------------------------------------------------------
# config/ramp.yaml
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TagMountConfig:
    """One tag's fixed mounting pose, as measured in its ramp section's
    own local frame (`config/ramp.yaml`'s `tag_mounts`).

    `translation_m`/`rotation_deg` together define what `tag_fusion.py`
    calls ``T_section_tag`` -- the natural way to *measure* a mounting
    offset ("tag N sits at this position/orientation relative to the
    section's own origin/axes"), as opposed to ``T_tag_section`` (its
    inverse), which is what the transform-composition math actually
    needs; see that module's docstring for the full convention.
    `rotation_deg` uses the intrinsic Tait-Bryan Z-Y-X (yaw, then pitch,
    then roll) order, in the *corrected*/intuitive tag-local frame that
    `vision_docking.pose`'s `yaw_deg`/`pitch_deg`/`roll_deg` use -- not
    the raw backend tag frame `TagPose.rotation` uses.

    `translation_m`/`rotation_deg` are `None` when not yet measured --
    see `RampConfig`'s docstring; a tag with no mount is simply excluded
    from any section estimate that would otherwise use it.
    """

    tag_id: int
    section: str
    translation_m: tuple[float, float, float] | None
    rotation_deg: tuple[float, float, float] | None


@dataclass(frozen=True)
class EntranceSectionConfig:
    """Known geometry of the entrance assembly (ids 0-1), in that
    section's own local frame, metres.

    Each landmark is `None` until measured -- see `RampConfig`'s
    docstring and `docs/ramp_calibration.md`.
    """

    tag_ids: tuple[int, ...]
    entrance_center_m: tuple[float, float, float] | None
    entrance_left_m: tuple[float, float, float] | None
    entrance_right_m: tuple[float, float, float] | None


@dataclass(frozen=True)
class UpperSectionConfig:
    """Known geometry of the upper assembly (ids 2-4), in that section's
    own local frame, metres. Same `None`-until-measured convention as
    `EntranceSectionConfig`."""

    tag_ids: tuple[int, ...]
    top_center_m: tuple[float, float, float] | None
    top_left_m: tuple[float, float, float] | None
    top_right_m: tuple[float, float, float] | None


@dataclass(frozen=True)
class RampToleranceConfig:
    """Disagreement/validity tolerances for `tag_fusion.py`'s ramp
    reconstruction. See `config/ramp.yaml` for field docs; every field
    here has a documented default and so is optional in the YAML."""

    entrance_agreement_m: float
    upper_agreement_m: float
    width_tolerance_fraction: float
    min_confidence: float


@dataclass(frozen=True)
class RampConfig:
    """Parsed contents of `config/ramp.yaml`. See that file for field docs.

    Deliberately permissive: every physical measurement (`width_m`, each
    section's landmark points, each tag's mounting transform) may be
    `None` if not yet measured -- this loader's job is only to parse
    what's present and validate that whatever *is* present is
    well-formed (right shape, numeric, finite); it does not require the
    ramp to be fully calibrated in order to load successfully, so the
    rest of the package keeps importing/running normally either way.
    `tag_fusion.py` is what rejects (via `RampSectionEstimate.
    valid=False`/`reason`, never an exception) a specific calculation
    that turns out to need a measurement which is still `None` -- see
    that module's docstring.
    """

    width_m: float | None
    entrance_section: EntranceSectionConfig
    upper_section: UpperSectionConfig
    tag_mounts: dict[int, TagMountConfig]
    tolerances: RampToleranceConfig


@dataclass(frozen=True)
class RampPrototypeConfig:
    """Parsed contents of `config/ramp_prototype.yaml` -- the minimal
    calibration for `tag_fusion.py`'s three-tag centerline ramp model
    (`estimate_ramp_from_three_tags()`/`ThreeTagRampEstimator`), used to
    validate the reconstruction concept before doing the full per-tag
    mounting-transform calibration (`RampConfig`/`load_ramp_config()`,
    entirely unaffected by this).

    `ramp_width_m` is `None` until measured -- this simplified model has
    no edge landmarks to reconstruct it from, unlike `RampConfig.
    width_m`. `entrance_offset_m`/`top_offset_m` default to `0.0`
    (no-op) until measured. `nominal_entrance_to_top_horizontal_m` is
    `None` until measured -- used only to reconstruct whichever of
    entrance/top isn't currently visible (see `tag_fusion.py`'s module
    docstring, "Geometry authority" section); without it, a missing
    endpoint stays `None` rather than being fabricated.
    """

    ramp_width_m: float | None
    entrance_offset_m: float
    top_offset_m: float
    nominal_entrance_to_top_horizontal_m: float | None


# ---------------------------------------------------------------------------
# config/staging.yaml
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RampTagMountConfig:
    """One ramp-centerline tag's (ids 0-2: entrance/middle/top) known
    mounting-heading offset, degrees -- see `guidance.py`'s module
    docstring for the exact correction formula and sign convention, and
    for why this is a "heading" (horizontal panning) sourced from
    `TagPose.pitch_deg`, not `yaw_deg`. `0.0` means "mounted flush, no
    correction needed"."""

    mount_heading_offset_deg: float


@dataclass(frozen=True)
class CameraToGroundConfig:
    """The camera's fixed height above the ground plane, metres --
    `None` until measured. See `guidance.py`'s module docstring for why
    this (not AprilTag orientation) is what defines the ground plane a
    staging point is placed on."""

    camera_height_m: float | None


@dataclass(frozen=True)
class ProvisionalConfig:
    """Calibration for the `PROVISIONAL` staging-target tier (the
    entrance tag, id 0, isn't usable; entrance estimated from the
    middle/top tags instead). `nominal_entrance_to_top_horizontal_m` is
    `None` until a nominal value is chosen -- without it, no
    `PROVISIONAL` target is generated (the real entrance-to-top distance
    can vary with ramp extension, so this is always an approximation,
    never treated as exact -- see `guidance.py`'s module docstring)."""

    nominal_entrance_to_top_horizontal_m: float | None


@dataclass(frozen=True)
class StagingConfig:
    """Parsed contents of `config/staging.yaml` -- calibration for
    `guidance.py`'s staging-point generation.

    `tags` covers ids 0 (entrance), 1 (middle), and 2 (top) -- there are
    no more bottom/upper tag pairs or pair-spacing fields to configure.
    `camera_to_ground.camera_height_m` is `None` until measured; without
    it, no staging point (`EXACT` or `PROVISIONAL`) can be placed on the
    ground plane at all.
    """

    staging_distance_m: float
    tags: dict[int, RampTagMountConfig]
    camera_to_ground: CameraToGroundConfig
    provisional: ProvisionalConfig


# ---------------------------------------------------------------------------
# config/approach_path.yaml
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ApproachPathConfig:
    """Parsed contents of `config/approach_path.yaml` -- tuning for
    `visualization.py`'s ROVER -> STAGING curved-approach generator (a
    cubic Bezier in horizontal camera X/Z space, see that module's
    "Navigation HUD" section comment). Carries no ramp/staging geometry
    of its own -- that comes from `config/staging.yaml` and the
    reconstructed ramp centerline -- and has no bearing on steering,
    which is not implemented yet.

    `handle_fraction` is the fraction of the straight-line rover-to-
    staging distance used as the Bezier's control-handle length (shared
    by both ends), clamped to `[min_handle_m, max_handle_m]` so a very
    close or very far rover still produces a reasonable-looking curve.
    `sample_count` is how many points the curve is sampled into
    (including both endpoints). `lookahead_m` is how far along the
    sampled curve the debug LOOKAHEAD marker is placed -- geometry/
    visualization only, never used to issue a steering command.
    """

    handle_fraction: float
    min_handle_m: float
    max_handle_m: float
    sample_count: int
    lookahead_m: float


# ---------------------------------------------------------------------------
# config/tag_tracking.yaml
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TagTrackingConfig:
    """Parsed contents of `config/tag_tracking.yaml` -- tuning for
    `tag_tracking.py`'s `TagPoseTracker` temporal pose-hold layer (see
    that module's module docstring for the full LIVE/HELD/LOST state
    machine).

    `hold_timeout_s` is how long, in seconds, a tag's last observed pose
    is temporarily reused after it stops being directly detected, before
    that tag is reported LOST. Deliberately short and prototype-sized --
    enough to bridge a genuine 1-2 frame detection flicker, nowhere near
    long enough to paper over a real multi-second occlusion.
    """

    hold_timeout_s: float


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------


_CAMERA_REQUIRED_FIELDS = (
    "model",
    "serial_number",
    "width",
    "height",
    "fps",
    "enable_depth",
    "auto_exposure",
    "manual_exposure",
)


def load_camera_config(path: Path) -> CameraConfig:
    """Load and validate `config/camera.yaml` from *path*.

    `frame_timeout_ms` is optional in the YAML (defaults to
    `CameraConfig.frame_timeout_ms`'s default) since it was added after
    the original schema; every other field is required.
    """
    with open(path, encoding="utf-8") as f:
        raw: Any = yaml.safe_load(f)

    try:
        section = raw["camera"]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"{path}: missing top-level 'camera' key") from exc

    missing = [key for key in _CAMERA_REQUIRED_FIELDS if key not in section]
    if missing:
        raise ValueError(f"{path}: camera config missing required fields: {missing}")

    intrinsics_file = section.get("intrinsics_file")
    kwargs: dict[str, Any] = {
        "model": str(section["model"]),
        "serial_number": str(section["serial_number"]),
        "width": int(section["width"]),
        "height": int(section["height"]),
        "fps": int(section["fps"]),
        "enable_depth": bool(section["enable_depth"]),
        "intrinsics_file": Path(intrinsics_file) if intrinsics_file else None,
        "auto_exposure": bool(section["auto_exposure"]),
        "manual_exposure": int(section["manual_exposure"]),
    }
    if "frame_timeout_ms" in section:
        kwargs["frame_timeout_ms"] = int(section["frame_timeout_ms"])
    return CameraConfig(**kwargs)


_TAGS_REQUIRED_FIELDS = ("family", "default_size_m", "detector")
_TAGS_DETECTOR_REQUIRED_FIELDS = ("quad_decimate", "quad_sigma", "nthreads", "min_decision_margin")


def load_tags_config(path: Path) -> TagsConfig:
    """Load and validate `config/tags.yaml` from *path*.

    `detector.refine_edges`, `detector.decode_sharpening`, and
    `detector.debug` are optional (default to `TagDetectorConfig`'s
    defaults) since they were added after the original schema; every
    other `detector` field is required. Each `known_tags` entry requires
    `overall_size_m` and `pose_tag_size_m` (both positive, finite
    numbers -- see `KnownTag`'s docstring for what each means and
    `pose.py`'s module docstring for why the distinction matters) and a
    unique `id` -- `tag_fusion.py`'s `position_m`/`rotation_deg` fields
    are parsed too even though that layer doesn't read them yet, per
    this project's rule against consuming not-yet-designed-for fields
    early rather than dropping them from the schema.
    """
    with open(path, encoding="utf-8") as f:
        raw: Any = yaml.safe_load(f)

    try:
        section = raw["tags"]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"{path}: missing top-level 'tags' key") from exc

    missing = [key for key in _TAGS_REQUIRED_FIELDS if key not in section]
    if missing:
        raise ValueError(f"{path}: tags config missing required fields: {missing}")

    detector_section = section["detector"]
    detector_missing = [
        key for key in _TAGS_DETECTOR_REQUIRED_FIELDS if key not in detector_section
    ]
    if detector_missing:
        raise ValueError(
            f"{path}: tags.detector config missing required fields: {detector_missing}"
        )

    detector_kwargs: dict[str, Any] = {
        "quad_decimate": float(detector_section["quad_decimate"]),
        "quad_sigma": float(detector_section["quad_sigma"]),
        "nthreads": int(detector_section["nthreads"]),
        "min_decision_margin": float(detector_section["min_decision_margin"]),
    }
    if "refine_edges" in detector_section:
        detector_kwargs["refine_edges"] = bool(detector_section["refine_edges"])
    if "decode_sharpening" in detector_section:
        detector_kwargs["decode_sharpening"] = float(detector_section["decode_sharpening"])
    if "debug" in detector_section:
        detector_kwargs["debug"] = bool(detector_section["debug"])

    known_tags = tuple(_parse_known_tag(path, entry) for entry in section.get("known_tags", []))
    _check_no_duplicate_tag_ids(path, known_tags)

    return TagsConfig(
        family=str(section["family"]),
        default_size_m=float(section["default_size_m"]),
        detector=TagDetectorConfig(**detector_kwargs),
        known_tags=known_tags,
    )


def _as_float_triple(value: Any) -> tuple[float, float, float]:
    x, y, z = value
    return (float(x), float(y), float(z))


_KNOWN_TAG_REQUIRED_FIELDS = (
    "id",
    "role",
    "overall_size_m",
    "pose_tag_size_m",
    "position_m",
    "rotation_deg",
)


def _parse_known_tag(path: Path, entry: dict[str, Any]) -> KnownTag:
    missing = [key for key in _KNOWN_TAG_REQUIRED_FIELDS if key not in entry]
    if missing:
        raise ValueError(
            f"{path}: known_tags entry missing required fields: {missing} (entry={entry})"
        )

    tag_id = entry["id"]
    try:
        overall_size_m = float(entry["overall_size_m"])
        pose_tag_size_m = float(entry["pose_tag_size_m"])
        position_m = _as_float_triple(entry["position_m"])
        rotation_deg = _as_float_triple(entry["rotation_deg"])
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"{path}: known_tags id={tag_id!r} has a non-numeric field (entry={entry})"
        ) from exc

    _require_positive_finite(path, tag_id, "overall_size_m", overall_size_m)
    _require_positive_finite(path, tag_id, "pose_tag_size_m", pose_tag_size_m)

    return KnownTag(
        tag_id=int(tag_id),
        role=str(entry["role"]),
        overall_size_m=overall_size_m,
        pose_tag_size_m=pose_tag_size_m,
        position_m=position_m,
        rotation_deg=rotation_deg,
    )


def _require_positive_finite(path: Path, tag_id: Any, field_name: str, value: float) -> None:
    if not (math.isfinite(value) and value > 0):
        raise ValueError(
            f"{path}: known_tags id={tag_id!r} has an invalid {field_name}={value!r} "
            "-- must be a positive, finite number of metres."
        )


def _check_no_duplicate_tag_ids(path: Path, known_tags: tuple[KnownTag, ...]) -> None:
    seen: set[int] = set()
    for kt in known_tags:
        if kt.tag_id in seen:
            raise ValueError(f"{path}: duplicate known_tags id: {kt.tag_id}")
        seen.add(kt.tag_id)


_RAMP_REQUIRED_FIELDS = ("entrance_section", "upper_section", "tag_mounts")
_RAMP_ENTRANCE_REQUIRED_FIELDS = (
    "tag_ids", "entrance_center_m", "entrance_left_m", "entrance_right_m"
)
_RAMP_UPPER_REQUIRED_FIELDS = ("tag_ids", "top_center_m", "top_left_m", "top_right_m")
_RAMP_TAG_MOUNT_REQUIRED_FIELDS = ("section", "translation_m", "rotation_deg")
_RAMP_VALID_SECTIONS = ("entrance", "upper")

_DEFAULT_ENTRANCE_AGREEMENT_M = 0.05
_DEFAULT_UPPER_AGREEMENT_M = 0.08
_DEFAULT_WIDTH_TOLERANCE_FRACTION = 0.03
_DEFAULT_MIN_CONFIDENCE = 0.3


def load_ramp_config(path: Path) -> RampConfig:
    """Load `config/ramp.yaml` from *path*.

    Permissive by design -- see `RampConfig`'s docstring: every field
    that represents a physical measurement (`width_m`, section
    landmarks, tag mounting transforms) may be `null` in the YAML and
    loads as `None`. What *is* always required is the file's structural
    shape (`entrance_section`/`upper_section`/`tag_mounts` present, each
    with their expected sub-keys; every `tag_mounts` entry names a valid
    `section`) -- and, for any value that is *not* null, that it is
    well-formed (a 3-element numeric list, finite). `tolerances` is
    entirely optional; every field there falls back to a documented
    default if that field (or the whole `tolerances` section) is absent.
    """
    with open(path, encoding="utf-8") as f:
        raw: Any = yaml.safe_load(f)

    try:
        section = raw["ramp"]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"{path}: missing top-level 'ramp' key") from exc

    missing = [key for key in _RAMP_REQUIRED_FIELDS if key not in section]
    if missing:
        raise ValueError(f"{path}: ramp config missing required fields: {missing}")

    width_m = _as_optional_positive_float(path, "ramp.width_m", section.get("width_m"))
    entrance_section = _parse_entrance_section(path, section["entrance_section"])
    upper_section = _parse_upper_section(path, section["upper_section"])
    tag_mounts = _parse_tag_mounts(path, section["tag_mounts"])
    tolerances = _parse_ramp_tolerances(path, section.get("tolerances") or {})

    return RampConfig(
        width_m=width_m,
        entrance_section=entrance_section,
        upper_section=upper_section,
        tag_mounts=tag_mounts,
        tolerances=tolerances,
    )


def _as_optional_positive_float(path: Path, context: str, value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{path}: {context} must be a number or null, got {value!r}") from exc
    if not (math.isfinite(number) and number > 0):
        raise ValueError(f"{path}: {context} must be positive and finite, got {number}")
    return number


def _as_optional_float_triple(
    path: Path, context: str, value: Any
) -> tuple[float, float, float] | None:
    """Parse a nullable ``[x, y, z]`` YAML value.

    `None` (YAML `null`) means "not yet measured". A 3-element list with
    *any* `null` component (e.g. ``[0.0, null, 0.0]``) is also treated as
    fully unmeasured -- a half-measured point isn't usable geometry, and
    treating it as such would risk silently fabricating an axis.
    """
    if value is None:
        return None
    try:
        items = list(value)
    except TypeError as exc:
        raise ValueError(
            f"{path}: {context} must be a 3-element list or null, got {value!r}"
        ) from exc
    if len(items) != 3:
        raise ValueError(f"{path}: {context} must have exactly 3 elements, got {value!r}")
    if any(item is None for item in items):
        return None
    try:
        triple = (float(items[0]), float(items[1]), float(items[2]))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{path}: {context} must contain only numbers, got {value!r}") from exc
    if not all(math.isfinite(v) for v in triple):
        raise ValueError(f"{path}: {context} must be finite, got {triple}")
    return triple


def _parse_entrance_section(path: Path, section: dict[str, Any]) -> EntranceSectionConfig:
    missing = [key for key in _RAMP_ENTRANCE_REQUIRED_FIELDS if key not in section]
    if missing:
        raise ValueError(f"{path}: ramp.entrance_section missing required fields: {missing}")
    return EntranceSectionConfig(
        tag_ids=tuple(int(t) for t in section["tag_ids"]),
        entrance_center_m=_as_optional_float_triple(
            path, "ramp.entrance_section.entrance_center_m", section["entrance_center_m"]
        ),
        entrance_left_m=_as_optional_float_triple(
            path, "ramp.entrance_section.entrance_left_m", section["entrance_left_m"]
        ),
        entrance_right_m=_as_optional_float_triple(
            path, "ramp.entrance_section.entrance_right_m", section["entrance_right_m"]
        ),
    )


def _parse_upper_section(path: Path, section: dict[str, Any]) -> UpperSectionConfig:
    missing = [key for key in _RAMP_UPPER_REQUIRED_FIELDS if key not in section]
    if missing:
        raise ValueError(f"{path}: ramp.upper_section missing required fields: {missing}")
    return UpperSectionConfig(
        tag_ids=tuple(int(t) for t in section["tag_ids"]),
        top_center_m=_as_optional_float_triple(
            path, "ramp.upper_section.top_center_m", section["top_center_m"]
        ),
        top_left_m=_as_optional_float_triple(
            path, "ramp.upper_section.top_left_m", section["top_left_m"]
        ),
        top_right_m=_as_optional_float_triple(
            path, "ramp.upper_section.top_right_m", section["top_right_m"]
        ),
    )


def _parse_tag_mounts(path: Path, raw_mounts: dict[Any, Any]) -> dict[int, TagMountConfig]:
    mounts: dict[int, TagMountConfig] = {}
    for raw_tag_id, entry in raw_mounts.items():
        try:
            tag_id = int(raw_tag_id)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"{path}: ramp.tag_mounts has a non-integer tag id: {raw_tag_id!r}"
            ) from exc

        missing = [key for key in _RAMP_TAG_MOUNT_REQUIRED_FIELDS if key not in entry]
        if missing:
            raise ValueError(
                f"{path}: ramp.tag_mounts[{tag_id}] missing required fields: {missing}"
            )

        section_name = str(entry["section"])
        if section_name not in _RAMP_VALID_SECTIONS:
            raise ValueError(
                f"{path}: ramp.tag_mounts[{tag_id}].section must be one of "
                f"{_RAMP_VALID_SECTIONS}, got {section_name!r}"
            )

        mounts[tag_id] = TagMountConfig(
            tag_id=tag_id,
            section=section_name,
            translation_m=_as_optional_float_triple(
                path, f"ramp.tag_mounts[{tag_id}].translation_m", entry["translation_m"]
            ),
            rotation_deg=_as_optional_float_triple(
                path, f"ramp.tag_mounts[{tag_id}].rotation_deg", entry["rotation_deg"]
            ),
        )
    return mounts


def _parse_ramp_tolerances(path: Path, section: dict[str, Any]) -> RampToleranceConfig:
    entrance_agreement_m = float(section.get("entrance_agreement_m", _DEFAULT_ENTRANCE_AGREEMENT_M))
    upper_agreement_m = float(section.get("upper_agreement_m", _DEFAULT_UPPER_AGREEMENT_M))
    width_tolerance_fraction = float(
        section.get("width_tolerance_fraction", _DEFAULT_WIDTH_TOLERANCE_FRACTION)
    )
    min_confidence = float(section.get("min_confidence", _DEFAULT_MIN_CONFIDENCE))

    for name, value in (
        ("entrance_agreement_m", entrance_agreement_m),
        ("upper_agreement_m", upper_agreement_m),
        ("width_tolerance_fraction", width_tolerance_fraction),
    ):
        if not (math.isfinite(value) and value > 0):
            raise ValueError(
                f"{path}: ramp.tolerances.{name} must be positive and finite, got {value}"
            )
    if not (math.isfinite(min_confidence) and 0.0 <= min_confidence <= 1.0):
        raise ValueError(
            f"{path}: ramp.tolerances.min_confidence must be in [0, 1], got {min_confidence}"
        )

    return RampToleranceConfig(
        entrance_agreement_m=entrance_agreement_m,
        upper_agreement_m=upper_agreement_m,
        width_tolerance_fraction=width_tolerance_fraction,
        min_confidence=min_confidence,
    )


_DEFAULT_ENTRANCE_OFFSET_M = 0.0
_DEFAULT_TOP_OFFSET_M = 0.0


def load_ramp_prototype_config(path: Path) -> RampPrototypeConfig:
    """Load `config/ramp_prototype.yaml` from *path*.

    `ramp_width_m` may be `null` (unmeasured, no landmark-based fallback
    exists in this simplified model); `entrance_offset_m`/`top_offset_m`
    default to `0.0` if omitted; `nominal_entrance_to_top_horizontal_m`
    is required (structurally -- the key must be present) but may be
    `null` (disables PROVISIONAL missing-endpoint reconstruction, never
    fabricates one -- see `tag_fusion.py`'s module docstring).
    """
    with open(path, encoding="utf-8") as f:
        raw: Any = yaml.safe_load(f)

    try:
        section = raw["ramp"]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"{path}: missing top-level 'ramp' key") from exc

    if "nominal_entrance_to_top_horizontal_m" not in section:
        raise ValueError(
            f"{path}: ramp config missing required field: "
            "['nominal_entrance_to_top_horizontal_m']"
        )

    ramp_width_m = _as_optional_positive_float(
        path, "ramp.ramp_width_m", section.get("ramp_width_m")
    )
    nominal_entrance_to_top_horizontal_m = _as_optional_positive_float(
        path,
        "ramp.nominal_entrance_to_top_horizontal_m",
        section["nominal_entrance_to_top_horizontal_m"],
    )

    entrance_offset_m = float(section.get("entrance_offset_m", _DEFAULT_ENTRANCE_OFFSET_M))
    top_offset_m = float(section.get("top_offset_m", _DEFAULT_TOP_OFFSET_M))
    for name, value in (("entrance_offset_m", entrance_offset_m), ("top_offset_m", top_offset_m)):
        if not math.isfinite(value):
            raise ValueError(f"{path}: ramp.{name} must be finite, got {value}")

    return RampPrototypeConfig(
        ramp_width_m=ramp_width_m,
        entrance_offset_m=entrance_offset_m,
        top_offset_m=top_offset_m,
        nominal_entrance_to_top_horizontal_m=nominal_entrance_to_top_horizontal_m,
    )


_STAGING_REQUIRED_FIELDS = (
    "staging_distance_m",
    "tags",
    "camera_to_ground",
    "provisional",
)
_STAGING_REQUIRED_TAG_IDS = (0, 1, 2)


def load_staging_config(path: Path) -> StagingConfig:
    """Load `config/staging.yaml` from *path*.

    `tags` must configure exactly ids 0 (entrance), 1 (middle), and 2
    (top) -- a `mount_heading_offset_deg` each (see `guidance.py`'s
    module docstring for the correction this feeds); there are no more
    bottom/upper tag pairs or pair-spacing fields. `camera_to_ground.
    camera_height_m` may be `null` (disables ground-plane placement
    entirely); `provisional.nominal_entrance_to_top_horizontal_m` may
    also be `null` (disables the `PROVISIONAL` tier entirely -- see
    `ProvisionalConfig`'s docstring) -- all structurally required keys,
    permissively `null` values, same philosophy as
    `load_ramp_config()`/`load_ramp_prototype_config()`.
    """
    with open(path, encoding="utf-8") as f:
        raw: Any = yaml.safe_load(f)

    try:
        section = raw["staging"]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"{path}: missing top-level 'staging' key") from exc

    missing = [key for key in _STAGING_REQUIRED_FIELDS if key not in section]
    if missing:
        raise ValueError(f"{path}: staging config missing required fields: {missing}")

    try:
        staging_distance_m = float(section["staging_distance_m"])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{path}: staging.staging_distance_m must be a number") from exc
    if not (math.isfinite(staging_distance_m) and staging_distance_m > 0):
        raise ValueError(
            f"{path}: staging.staging_distance_m must be positive and finite, "
            f"got {staging_distance_m}"
        )

    tag_offsets = _parse_tag_mount_offsets(
        path, section["tags"], context="staging.tags",
        required_ids=_STAGING_REQUIRED_TAG_IDS,
    )
    tags = {
        tag_id: RampTagMountConfig(mount_heading_offset_deg=offset)
        for tag_id, offset in tag_offsets.items()
    }

    camera_to_ground = _parse_camera_to_ground(path, section["camera_to_ground"])
    provisional = _parse_provisional(path, section["provisional"])

    return StagingConfig(
        staging_distance_m=staging_distance_m,
        tags=tags,
        camera_to_ground=camera_to_ground,
        provisional=provisional,
    )


def _parse_tag_mount_offsets(
    path: Path, raw_tags: dict[Any, Any], *, context: str, required_ids: tuple[int, ...]
) -> dict[int, float]:
    offsets: dict[int, float] = {}
    for raw_tag_id, entry in raw_tags.items():
        try:
            tag_id = int(raw_tag_id)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{path}: {context} has a non-integer tag id: {raw_tag_id!r}") from exc

        if "mount_heading_offset_deg" not in entry:
            raise ValueError(
                f"{path}: {context}[{tag_id}] missing required fields: "
                "['mount_heading_offset_deg']"
            )

        try:
            mount_heading_offset_deg = float(entry["mount_heading_offset_deg"])
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"{path}: {context}[{tag_id}].mount_heading_offset_deg must be a number"
            ) from exc
        if not math.isfinite(mount_heading_offset_deg):
            raise ValueError(
                f"{path}: {context}[{tag_id}].mount_heading_offset_deg must be finite, "
                f"got {mount_heading_offset_deg}"
            )

        offsets[tag_id] = mount_heading_offset_deg

    missing_ids = [i for i in required_ids if i not in offsets]
    if missing_ids:
        raise ValueError(f"{path}: {context} missing required tag ids: {missing_ids}")

    return offsets


def _parse_provisional(path: Path, section: dict[str, Any]) -> ProvisionalConfig:
    if "nominal_entrance_to_top_horizontal_m" not in section:
        raise ValueError(
            f"{path}: staging.provisional missing required field: "
            "nominal_entrance_to_top_horizontal_m"
        )
    nominal = _as_optional_positive_float(
        path,
        "staging.provisional.nominal_entrance_to_top_horizontal_m",
        section["nominal_entrance_to_top_horizontal_m"],
    )
    return ProvisionalConfig(nominal_entrance_to_top_horizontal_m=nominal)


def _parse_camera_to_ground(path: Path, section: dict[str, Any]) -> CameraToGroundConfig:
    if "camera_height_m" not in section:
        raise ValueError(
            f"{path}: staging.camera_to_ground missing required field: camera_height_m"
        )
    camera_height_m = _as_optional_positive_float(
        path, "staging.camera_to_ground.camera_height_m", section["camera_height_m"]
    )
    return CameraToGroundConfig(camera_height_m=camera_height_m)


_APPROACH_PATH_REQUIRED_FIELDS = (
    "handle_fraction",
    "min_handle_m",
    "max_handle_m",
    "sample_count",
    "lookahead_m",
)


def load_approach_path_config(path: Path) -> ApproachPathConfig:
    """Load and validate `config/approach_path.yaml` from *path*.

    Unlike `load_ramp_config()`/`load_staging_config()`, nothing here is
    permissively `null` -- every field is a prototype tuning constant
    with no physical-measurement caveat, so all five are required and
    must be positive and finite (`sample_count` an integer `>= 2`,
    `max_handle_m >= min_handle_m`).
    """
    with open(path, encoding="utf-8") as f:
        raw: Any = yaml.safe_load(f)

    try:
        section = raw["approach_path"]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"{path}: missing top-level 'approach_path' key") from exc

    missing = [key for key in _APPROACH_PATH_REQUIRED_FIELDS if key not in section]
    if missing:
        raise ValueError(f"{path}: approach_path config missing required fields: {missing}")

    try:
        handle_fraction = float(section["handle_fraction"])
        min_handle_m = float(section["min_handle_m"])
        max_handle_m = float(section["max_handle_m"])
        sample_count = int(section["sample_count"])
        lookahead_m = float(section["lookahead_m"])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{path}: approach_path fields must be numbers") from exc

    for name, value in (
        ("handle_fraction", handle_fraction),
        ("min_handle_m", min_handle_m),
        ("max_handle_m", max_handle_m),
        ("lookahead_m", lookahead_m),
    ):
        if not (math.isfinite(value) and value > 0):
            raise ValueError(
                f"{path}: approach_path.{name} must be positive and finite, got {value}"
            )
    if max_handle_m < min_handle_m:
        raise ValueError(
            f"{path}: approach_path.max_handle_m ({max_handle_m}) must be >= "
            f"min_handle_m ({min_handle_m})"
        )
    if sample_count < 2:
        raise ValueError(f"{path}: approach_path.sample_count must be >= 2, got {sample_count}")

    return ApproachPathConfig(
        handle_fraction=handle_fraction,
        min_handle_m=min_handle_m,
        max_handle_m=max_handle_m,
        sample_count=sample_count,
        lookahead_m=lookahead_m,
    )


_TAG_TRACKING_REQUIRED_FIELDS = ("hold_timeout_s",)


def load_tag_tracking_config(path: Path) -> TagTrackingConfig:
    """Load and validate `config/tag_tracking.yaml` from *path*.

    Unlike `load_ramp_config()`/`load_staging_config()`, `hold_timeout_s`
    is not a permissively-nullable physical measurement -- it is a
    required, positive, finite tuning constant.
    """
    with open(path, encoding="utf-8") as f:
        raw: Any = yaml.safe_load(f)

    try:
        section = raw["tag_tracking"]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"{path}: missing top-level 'tag_tracking' key") from exc

    missing = [key for key in _TAG_TRACKING_REQUIRED_FIELDS if key not in section]
    if missing:
        raise ValueError(f"{path}: tag_tracking config missing required fields: {missing}")

    try:
        hold_timeout_s = float(section["hold_timeout_s"])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{path}: tag_tracking.hold_timeout_s must be a number") from exc
    if not (math.isfinite(hold_timeout_s) and hold_timeout_s > 0):
        raise ValueError(
            f"{path}: tag_tracking.hold_timeout_s must be positive and finite, "
            f"got {hold_timeout_s}"
        )

    return TagTrackingConfig(hold_timeout_s=hold_timeout_s)


def load_docking_config(path: Path) -> DockingConfig:
    """Load and validate `config/docking.yaml` from *path*."""
    raise NotImplementedError(
        "load_docking_config() is not implemented yet -- see module TODOs."
    )
