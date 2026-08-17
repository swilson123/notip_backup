# Architecture

## Pipeline

`vision-docking` is a strictly layered pipeline. Data flows one
direction only; each layer communicates with the next exclusively
through the typed data models in `vision_docking/models.py`:

```
Camera
  │  (BGR color frame: np.ndarray, timestamp: float)
  ▼
[grayscale conversion -- caller's responsibility, not a pipeline module]
  │  (grayscale frame: np.ndarray, timestamp: float)
  ▼
AprilTag Detection            (camera.py -> detector.py)
  │  TagDetection[]
  ▼
Pose Estimation                (detector.py -> pose.py)
  │  TagPose[]  -- camera-relative, NOT ramp-relative (see below)
  ▼
  ├─────────────────────────────┬─────────────────────────────┐
  ▼                             ▼
Multi-Tag Fusion               Guidance Target Generation (ids 0-4, pose.py -> guidance.py)
  │  (pose.py -> tag_fusion.py)  │  GuidanceTarget  -- virtual staging point + bearing/
  │  RampEstimate                │  distance/heading-error, EXACT/PROVISIONAL/INVALID,
  │                               │  NOT steering (see below)
  ▼                             ▼
  └─────────────────────────────┴─────────────────────────────┘
                                ▼
                      Docking Controller    (guidance.py -> docking_controller.py)
                        │  DockingCommand
                        ▼
                      Vehicle Commands    (handed to NoTip's vehicle-command layer, outside this package)
```

**`guidance.py` does not consume `RampEstimate`.** Multi-Tag Fusion and
Guidance Target Generation are two independent consumers of the same
`TagPose[]`, not a chain -- see "Guidance target generation" below for
why.

`camera.py` hands out BGR frames (what OpenCV/display code wants);
`detector.py`'s `TagDetector.detect()` takes a grayscale frame instead
of converting internally, so that color-space conversion stays visible
at the call site (see `scripts/test_apriltags.py`) rather than hidden
inside detection -- this is a deliberate departure from a strict
one-module-per-arrow reading of the diagram above, justified by keeping
`detector.py` free of an implicit "which channel order/space did this
array come in" assumption.

`pose.py`'s `TagPoseEstimator.estimate()` takes the grayscale frame
*too* (not just the `TagDetection[]` the diagram's arrow implies) --
`pupil-apriltags` only exposes pose estimation as an option on its own
`Detector.detect()` call, with no public "estimate the pose of this
already-decoded detection" entry point, so `pose.py` keeps its own
lazily-constructed `pupil_apriltags.Detector` (never `detector.py`'s --
see the no-sibling-imports rule below) and re-detects-with-pose,
grouped by each detection's configured physical size (`pupil_apriltags`
accepts only one size per call, so any tag whose configured size
differs from the rest -- e.g. a future tag added at a different
physical scale -- still needs its own group).
See `pose.py`'s module docstring for the full reasoning. The resulting
`TagPose[]` this layer hands to `tag_fusion.py` is **camera-relative**,
not ramp-relative -- a tag's own yaw is not the ramp's heading whenever
that tag is mounted at an angle to the ramp face; reconciling per-tag
poses into ramp geometry is exactly what `tag_fusion.py` does next.

### Multi-tag fusion: three-tag centerline model (current hardware)

**Current deployed hardware is three tags directly on the ramp
centerline** -- id 0 = entrance-center, id 1 = middle-center, id 2 =
top-center, all the same large physical size. There are no more
left/right tag pairs and no midpoint reconstruction: each tag's own
(possibly offset-corrected) position *is* the landmark it represents.
`tag_fusion.py`'s `estimate_ramp_from_three_tags()`/
`ThreeTagRampEstimator`, configured from `config/ramp_prototype.yaml`
(`RampPrototypeConfig`), is what `scripts/test_ramp_geometry.py`
actually uses today.

Geometry authority, in descending order of how much is directly
observed: with ids 0 and 2 both visible, entrance/top come straight
from their own translations and the centerline is exact; with only two
of the three tags visible, the visible endpoint tag is authoritative
and the missing one is reconstructed from the *empirically observed*
direction between the two visible tags plus a configured nominal
entrance-to-top distance; with only one tag visible, that tag's own
`TagPose.pitch_deg` heading provides a provisional direction to project
from. Id 1 (middle) is never allowed to pull an already-authoritative
entrance/top sideways -- when ids 0 and 2 are both visible, id 1 is
purely a consistency-check diagnostic (`RampEstimate.
middle_perpendicular_distance_m`/`middle_distance_along_centerline_m`),
never a second path segment, even if the middle ramp section's own
vertical pitch changes. See `tag_fusion.py`'s module docstring,
"Three-tag centerline model" section, for the complete seven-case
hierarchy.

`tag_fusion.py` also still contains its *original* two-rigid-section,
five-tag model (`TagFusion.fuse()`, `RampConfig`/`config/ramp.yaml`) --
an entrance assembly (tags 0-1) and an upper assembly (tags 2-4),
estimated as two independent rigid-body transforms
(`RampSectionEstimate`, `combine_section_transforms()`) and combined
only at the very last step in `build_ramp_estimate()`. That code is
left in place as generic, reusable infrastructure -- not calibrated
for, or wired into, the current three-tag hardware; see `tag_fusion.py`'s
module docstring, "Why the ramp is modeled as two rigid sections, not
one rigid body," and `docs/ramp_calibration.md` for the historical
five-tag measurement checklist. Both models produce the same
`RampEstimate` shape and expose the same `.fuse(tag_poses, timestamp)
-> RampEstimate` interface, so a caller could swap between them without
changing anything else -- but only the three-tag model is in active use.

All transforms in the five-tag model are homogeneous 4x4 rigid
transforms, named `T_into_from` (`p_into = T_into_from @ [p_from, 1]`),
composed strictly left-to-right and never mixed with their own inverse
without an explicit `invert_transform()` call -- see `tag_fusion.py`'s
module docstring for the full convention. `tag_fusion.py` stops at
`RampEstimate` and a pure `compute_staging_point_m()` helper -- no
steering, heading correction, or velocity command is computed here; that
remains `docking_controller.py`'s job.

### Guidance target generation: a virtual point, not steering

`guidance.py`'s `compute_guidance_target()`/`GuidanceTargetGenerator`
turn tag poses directly into a `GuidanceTarget` -- a stateless,
per-frame geometric transform with **no wheel command, no velocity, no
PID/Pure-Pursuit/Stanley controller, and no rover integration**. This
module does **not** consume a `RampEstimate` at all: `guidance.py`
never imports `tag_fusion.py` or reads its output, and computes its
own hierarchy of staging estimates directly from `TagPose[]`.
`tag_fusion.py` and the rest of the vision pipeline are untouched.

That hierarchy is exposed as `GuidanceTarget.quality`
(`TargetQuality.EXACT`/`PROVISIONAL`/`INVALID`), tried strictly in that
order over the same three ramp-centerline tags (id 0 = entrance, id 1 =
middle, id 2 = top) `tag_fusion.py` uses:

* **`EXACT`** -- ids 0 and 2 both visible. The entrance is tag 0's own
  position, and the approach heading is the ***empirically observed***
  horizontal direction from tag 0 toward tag 2 -- not either tag's own
  rotation reading. This is deliberate: two tags' positions agree with
  each other regardless of either one's heading reading, whereas a
  single tag's own heading is measurement-noisy in a way that would
  otherwise let the entrance visibly drift sideways as the camera moved.
* **`PROVISIONAL`** -- tried only once `EXACT` fails outright. Two-tag
  sub-cases rank highest: id 0 + id 1 (entrance from tag 0, heading from
  the empirically observed tag0->tag1 direction) or id 1 + id 2
  (top from tag 2, entrance projected backward along the empirically
  observed tag1->tag2 direction using a configured nominal
  entrance-to-top distance). Single-tag sub-cases rank below those: id
  0 alone (entrance from tag 0, heading from tag 0's own corrected
  `TagPose.pitch_deg` -- `corrected_heading = pitch_deg -
  mount_heading_offset_deg`, `config/staging.yaml`'s `tags`), id 2 alone,
  or id 1 alone (both projecting an entrance backward using the same
  nominal distance, halved for id 1). Every projected-entrance sub-case
  is explicitly named and documented as an *estimate*, not a
  measurement, since the ramp's real entrance-to-top distance can
  change (e.g. ramp extension). `GuidanceTarget.reason` is prefixed
  `"PROVISIONAL: ..."` and says so explicitly.
* **`INVALID`** -- no ramp-centerline tag usable at all (or a
  configuration needed by the case that would otherwise apply is
  missing) -- no target is generated, `reason` names exactly why.

`GuidanceTarget.supporting_tag_ids` always lists exactly which tag IDs
produced the current target. `guidance.py` is deliberately kept a pure,
stateless function even across tier transitions -- it does not smooth
or rate-limit a `PROVISIONAL`-to-`EXACT` jump between frames; see
`guidance.py`'s module docstring for why a bounded transition filter is
left to a future, inherently-stateful `docking_controller.py` instead.

**Which `TagPose` field drives heading:** every *single-tag* heading
calculation above reads `TagPose.pitch_deg` -- **not** `yaw_deg`. This
repository's own tested Euler decomposition
(`pose.rotation_matrix_to_euler_deg()`, cross-checked against
`tests/test_pose.py`'s known-rotation cases) shows that rotation about
the camera's *vertical* axis (horizontal panning -- what a ramp-heading
correction physically needs) is reported in `TagPose.pitch_deg`;
`TagPose.yaw_deg` instead measures rotation about the camera's
*optical* axis (in-plane tag spin), which is unrelated to which way a
tag faces and must never feed a heading calculation. This is purely a
naming mismatch in `pose.py`'s Euler-angle convention, not a statement
about the ramp's own vertical incline -- `guidance.py` never reads that
by any name (see below). Because of this, every name in `guidance.py`'s
own vocabulary says "heading," never "yaw": `approach_heading_deg`,
`mount_heading_offset_deg`, `corrected_heading_deg`. The `EXACT` tier
and the two-tag `PROVISIONAL` sub-cases instead use an empirically
observed two-point direction and read no tag's heading or mount
correction at all. See `guidance.py`'s module docstring for the full
derivation.

The staging point's height comes from a separately configured ground
plane (`config/staging.yaml`'s `camera_to_ground.camera_height_m`) --
the camera's own fixed mounting height, **never** any tag's measured
vertical position, for any tier. `entrance_ground_point_camera_m`
is the entrance/reference point with its height replaced by this
configured value; `target_point_camera_m =
entrance_ground_point_camera_m - staging_distance_m *
horizontal_direction`, where `horizontal_direction = (sin(heading), 0,
cos(heading))` is built purely from the corrected approach heading
above -- never from `TagPose.yaw_deg`/`roll_deg`, and never from
`top_center - entrance_center` (there is no `RampEstimate` here to
derive that from). This is what keeps the target on the ground and
unaffected by the ramp's own vertical incline or any tag's own tilt --
none of those are ever read by this module.

`GuidanceTarget.confidence` is `1.0` for `EXACT`, a fixed lower value
for the two-tag `PROVISIONAL` sub-cases, and a lower value still (equal
across all three) for the single-tag `PROVISIONAL` sub-cases, down to
`0.0` with no usable tags at all -- strictly decreasing, so a
`PROVISIONAL` result's confidence value is always below `EXACT`'s. No
per-tag agreement/outlier checks are applied (unlike `tag_fusion.py`'s
section combination). `GuidanceTarget.quality` reflects only whether a
target was *geometrically computable* at each tier (relevant tags
usable and the ground plane configured). The rover body frame is
assumed to coincide with the camera frame for now, so
`heading_error_deg` is presently a copy of `target_bearing_deg`; see
`guidance.py`'s module docstring for exactly why that's a documented,
swappable assumption rather than a permanent
one.

`state_machine.py` sits alongside `docking_controller.py`: both read the
current `RampEstimate` each cycle. `state_machine.py` owns the mutable
`DockingState` (the current `DockingPhase`, missed-frame count, etc.);
`docking_controller.py` reads that state to decide *how* to move, but
never mutates it.

`visualization.py` is not part of this pipeline. It only ever consumes
the data models above to render debug overlays; nothing in the pipeline
imports it back.

## Module dependency graph

```
models.py               <- imported by every module below; imports nothing
                            from this package itself.
config.py                <- imports models.py only.
camera.py                <- imports models.py only.
detector.py               <- imports models.py only.
pose.py                   <- imports models.py only.
tag_fusion.py             <- imports models.py only.
guidance.py               <- imports models.py only.
state_machine.py          <- imports models.py only.
docking_controller.py     <- imports models.py only.
calibration.py            <- imports models.py only.
visualization.py          <- imports models.py only.
```

No module other than `models.py` imports another sibling module in this
package. A top-level script or example is what wires multiple stages
together (see `examples/run_docking_pipeline.py`) -- this is what keeps
the graph acyclic as the project grows: any future edge added between
two pipeline modules should be viewed with suspicion, since it likely
means a type belongs in `models.py` instead.

`tag_fusion.py` follows this rule even for its own small, private
configuration-shaped types (`TagMount`, `SectionLandmarks`): they are
structurally similar to, but a deliberately separate declaration from,
`config.py`'s `TagMountConfig`/`EntranceSectionConfig`/
`UpperSectionConfig` -- `tag_fusion.py` never imports `config.py`, so a
caller (`examples/run_docking_pipeline.py`, `scripts/
test_ramp_geometry.py`) is what converts a loaded `RampConfig` into
`tag_fusion.py`'s own plain constructor arguments, exactly as already
happens for `AprilTagDetector`/`TagPoseEstimator`/`RealSenseCamera`. This
small duplication is intentional, not an oversight -- see this project's
established precedent of duplicating small utilities (e.g. each
module's own lazy-import guard, or `pose.py`'s/`tag_fusion.py`'s
independently-implemented tag-frame correction) rather than sharing them
through a forbidden sibling import.

`guidance.py` follows the exact same pattern with `RampTagMount`/
`GroundPlane`/`ProvisionalCalibration`/`StagingCalibration`,
deliberately separate from `config.py`'s `RampTagMountConfig`/
`CameraToGroundConfig`/`ProvisionalConfig`/`StagingConfig` --
`scripts/test_ramp_geometry.py`'s `build_staging_calibration()` is the
conversion point.

## Dependency injection

Every class in this package takes its configuration and collaborators
as explicit constructor arguments. None of them read
`vision_docking/config.py`'s YAML files themselves, and none of them
hold module-level/global mutable state. This is deliberate:

* it keeps every class testable in isolation, with fake/synthetic inputs
  and no filesystem or hardware dependency;
* it keeps `config.py` the single place YAML actually gets parsed,
  rather than scattering `open(...)` calls throughout the pipeline;
* it is what makes swapping an implementation (e.g. a simulated
  `CameraSource` instead of `RealSenseCamera` for offline testing)
  possible without touching any consumer.

## Interfaces (Protocols)

`camera.py`'s `CameraSource` and `detector.py`'s `TagDetector` are
defined as `typing.Protocol`s, not concrete base classes. Consumers
depend on the Protocol, not a specific implementation -- this is the
project's Dependency Inversion seam for the two components most likely
to need alternate implementations (real vs. simulated camera; AprilTag
library choice).

## NoTip / vehicle integration

This package has no notion of ROS, Mission Planner, or Pixhawk, and
never will. The only integration surface with the rover's own software
is `DockingCommand` (produced by `docking_controller.py`) -- a plain,
vehicle-agnostic velocity command. A thin adapter living in the NoTip
rover codebase (not here) is responsible for translating a
`DockingCommand` into whatever actuation interface that codebase
already uses.
