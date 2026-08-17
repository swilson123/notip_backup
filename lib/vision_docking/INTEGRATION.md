# vision_docking -- Integration Guide

This document assumes you have never seen this repository before. It
explains exactly what this package does, what it deliberately does not do,
how to install and import it into an existing rover codebase, and what is
still unfinished. Read this before writing any integration code.

## 1. What this package does

Given one camera frame and the intrinsics that describe it, this package
runs a fixed pipeline and returns a single result object:

```
frame (BGR) + camera intrinsics
    -> AprilTag detection                 (detector.py)
    -> per-tag 3D pose estimation          (pose.py)
    -> short temporal pose hold            (tag_tracking.py)
    -> ramp centerline reconstruction      (tag_fusion.py)
    -> staging point + guidance target     (guidance.py)
    -> ordered navigation path & heading   (visualization.py)
    -> DockingResult                       (pipeline.py)
```

Concretely, it: detects tag36h11 AprilTags in the frame; estimates each
detected tag's 3D pose relative to the camera; reconstructs the ramp's
centerline from whichever of the three ramp tags (entrance/middle/top) are
currently visible; builds a fixed, ordered approach path (`ROVER -> STAGING
-> ENTRANCE -> ramp centerline -> TOP`, staging point mandatory); and
reports the current desired horizontal travel-direction correction for
whichever path section is currently active.

The entry point is `vision_docking.pipeline.VisionDockingPipeline.
process_frame()`. See section 7 for the minimal call.

## 2. What this package does NOT do

This package is perception + path guidance only. It explicitly does not:

- Send throttle, steering, or any other motor/servo command.
- Talk to a Pixhawk, MAVLink, or Mission Planner in any way.
- Perform global/RTK navigation, waypoint following, or general sidewalk/
  outdoor navigation away from the ramp.
- Own any vehicle safety state (e-stop, geofence, arming logic).
- Convert `desired_travel_direction_deg` into a wheel angle, PWM value, or
  any other actuation unit.

Three modules exist in the original repository that *look* like they might
do some of this, but do not -- and are **not included** in this handoff
package at all:

- `docking_controller.py` -- `DockingController.compute_command()` raises
  `NotImplementedError`. Its own docstring states it intentionally has no
  notion of ROS, Mission Planner, or Pixhawk.
- `state_machine.py` -- `DockingStateMachine.update()` raises
  `NotImplementedError`. It defines a separate, unimplemented `DockingPhase`
  concept, distinct from the `PathSection` enum this package actually uses.
- `calibration.py` -- `CameraCalibrator.calibrate()` / `save_intrinsics()` /
  `load_intrinsics()` all raise `NotImplementedError`.

Nothing in the working pipeline imports any of these three files. They are
omitted rather than shipped as dead weight; if you want them as a starting
point for the rover's own controller/state-machine work, ask for them
separately -- they are unmodified from the original repository.

## 3. Hardware assumptions

- Camera: Intel RealSense D435i (or D435iF). This is the only camera this
  project has been built and tested against.
- Tested resolution/frame rate during development: **1280x720 @ 30fps**
  (see `config/camera.yaml`).
- Tag family: **tag36h11**.
- Physical tag layout (3 tags, all identical size, all on the ramp
  centerline): **id 0 = entrance, id 1 = middle, id 2 = top**. There are no
  left/right tag pairs in this deployment.
- Configured tag size (`config/tags.yaml`, `known_tags`): every one of ids
  0/1/2 uses `overall_size_m: 0.1270` (5.000in printed card) and
  `pose_tag_size_m: 0.09525` (3.75in black-border pattern, the value
  actually fed to the pose solver). All three IDs currently resolve to the
  **same** pose size -- verified directly from the config file, not
  assumed.

**Do not hard-code the example intrinsics anywhere in this document or in
`examples/integration_example.py` as real values.** They exist only to let
the synthetic example run without a camera attached. At runtime, always
query your camera's **active** stream profile for `fx, fy, cx, cy, width,
height` (and distortion, if you use it) -- these values change with
resolution, and even nominally-identical D435i units vary unit to unit.
`vision_docking.camera.RealSenseCamera.get_intrinsics()` shows the exact
field mapping from a `pyrealsense2` stream profile if you need a reference
(see section 6, Pattern A).

## 4. Python / runtime dependencies

Exact runtime imports, verified against the actual source in this package:

| Package | Used by | Required? |
|---|---|---|
| `numpy` | almost every module | Always |
| `PyYAML` | `config.py` | Always (for `from_config_dir()` / any `load_*_config()`) |
| `opencv-python-headless` (provides `cv2`) | `pipeline.py` (BGR->gray), `visualization.py` (path/HUD math) | Always |
| `pupil-apriltags` | `detector.py`, `pose.py` -- imported lazily, only when a detector/pose estimator is constructed | Effectively always (no tag detection without it) |
| `pyrealsense2` | `camera.py` -- imported lazily, only when `RealSenseCamera` is constructed | Only if you use this package's own camera class (Pattern B, section 7) |

`opencv-python` (the GUI-capable build) is **not** a runtime dependency of
the pipeline itself -- it is only needed to run the optional debug viewer,
`scripts/test_ramp_geometry.py` (section 11). Do not install both
`opencv-python` and `opencv-python-headless` at the same time; they provide
the same `cv2` module and will conflict.

See `requirements.txt` for the minimal installable list, and
`REQUIREMENTS.md` for the full breakdown. Dev-only tooling from the
original repository (`pytest`, `mypy`, `ruff`) is intentionally **not**
included -- none of it is needed to import or run this package.

## 5. Installation (Raspberry Pi 5)

**Recommended Python version: 3.11** -- it matches Raspberry Pi OS
Bookworm's default system Python, and is well within this package's
`requires-python >= 3.10` floor. This has not been tested on the Pi in this
handoff session; the recommendation is based on Pi OS defaults and PyPI
wheel availability at the time of writing, not on-device confirmation.

```bash
python3 --version                     # confirm 3.10+ (3.11 recommended)
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

**Do not assume the Windows Python 3.11 workaround used on the original dev
machine applies here.** That workaround existed only because of a local
Windows-specific native-DLL loading issue with `pupil-apriltags` (see
section 10) and has no bearing on Linux/Raspberry Pi OS.

**Flag for the Pi specifically:** `pupil-apriltags` may not publish a
prebuilt wheel for `aarch64` (Raspberry Pi's CPU architecture) on PyPI. If
`pip install pupil-apriltags` falls back to building from source, you will
additionally need a C++ toolchain, `cmake`, and Eigen3 headers, e.g.:

```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake libeigen3-dev
```

This has **not been verified on real Raspberry Pi 5 hardware** in this
handoff -- treat it as a known risk to check early, not a confirmed
working path.

If you plan to feed frames from your own existing RealSense integration
(Pattern A, recommended -- see section 7), you do **not** need
`pyrealsense2` installed for this package at all; skip that extra.

## 6. Copy / import instructions

Recommended layout inside the rover repository (package import, not a
`sys.path` hack):

```
rover_repo/
    vision_docking/          <- copy handoff/vision_docking/ here verbatim
        __init__.py
        camera.py
        config.py
        detector.py
        guidance.py
        models.py
        pipeline.py
        pose.py
        tag_fusion.py
        tag_tracking.py
        visualization.py
    vision_docking_config/   <- copy handoff/config/ here (any name you like)
        tags.yaml
        staging.yaml
        ramp_prototype.yaml
        approach_path.yaml
        tag_tracking.yaml
        camera.yaml
    your_existing_rover_code/
        ...
```

Then, from anywhere in the rover codebase:

```python
from vision_docking.pipeline import VisionDockingPipeline

docking = VisionDockingPipeline.from_config_dir("vision_docking_config")
```

`from_config_dir()` only requires `tags.yaml`, `staging.yaml`, and
`ramp_prototype.yaml` to exist in that directory; `approach_path.yaml` and
`tag_tracking.yaml` are read if present and fall back to built-in defaults
if not. `camera.yaml` is not read by `from_config_dir()` at all -- it is
only relevant if you construct `vision_docking.camera.RealSenseCamera`
yourself (Pattern B).

## 7. Minimal integration example

See `examples/integration_example.py` for a runnable version of both
patterns below.

**Pattern A -- the rover already owns RealSense acquisition (recommended).**
`VisionDockingPipeline` never needs to own a camera; only a frame and its
intrinsics:

```python
from vision_docking.models import CameraIntrinsics
from vision_docking.pipeline import VisionDockingPipeline

docking = VisionDockingPipeline.from_config_dir("vision_docking_config")

while running:
    frame_bgr = existing_rover_camera.read()               # however you already get frames
    rs_intr = existing_rover_camera.get_intrinsics()        # your own camera's intrinsics object

    intrinsics = CameraIntrinsics(
        fx=rs_intr.fx, fy=rs_intr.fy, cx=rs_intr.ppx, cy=rs_intr.ppy,
        width=rs_intr.width, height=rs_intr.height,
        distortion=tuple(rs_intr.coeffs),
    )

    result = docking.process_frame(frame_bgr, intrinsics)
    if result.valid and result.desired_travel_direction_deg is not None:
        desired_direction_deg = result.desired_travel_direction_deg
        # -> hand this to your steering/controller code (section 8)
```

**Pattern B -- this package owns RealSense acquisition.** Only use this if
you do not already have a RealSense integration. `vision_docking.camera.
RealSenseCamera` is a thin, cleanly-supported wrapper already present in
this package; `examples/integration_example.py --mode realsense` exercises
it directly.

## 8. Main-loop example

Dropping this into an existing rover loop, without issuing any motor
command:

```python
docking = VisionDockingPipeline.from_config_dir("vision_docking_config")

def rover_tick(frame_bgr, intrinsics):
    result = docking.process_frame(frame_bgr, intrinsics)

    if not result.valid:
        # No usable guidance this frame -- result.reason explains why.
        # Your controller should hold/idle here, not steer blindly.
        return

    # result.active_path_section: "APPROACH" / "FINAL_ALIGNMENT" / "RAMP"
    # result.next_mandatory_waypoint: "STAGING" / "ENTRANCE" / "TOP" / None
    if result.desired_travel_direction_deg is not None:
        # <-- your existing steering/velocity controller consumes this
        #     angle here. This package stops at the angle; it does not
        #     compute a wheel angle, PWM duty cycle, or Pixhawk RC
        #     override. That conversion belongs to your rover's own
        #     controller code, which already knows the rover's steering
        #     geometry and actuation limits.
        your_rover_controller.steer_toward(result.desired_travel_direction_deg)
```

## 9. State / path semantics

- **Path sections** (`result.active_path_section`): `APPROACH` (rover is
  still en route to the staging point, following a curved Bezier path, not
  a straight bearing to the entrance), `FINAL_ALIGNMENT` (rover is at/near
  the staging point, aligning squarely with the ramp centerline before
  entering), `RAMP` (rover has committed to entering and is following the
  ramp centerline toward the top, using whichever centerline tags remain
  visible as earlier ones are passed).
- **Ordered path**: `ROVER -> STAGING -> ENTRANCE -> TOP`. The staging
  point is **mandatory**, not a shortcut-able waypoint -- it is defined as
  an exact horizontal extension of the reconstructed ramp centerline,
  `staging_distance_m` (currently `0.5` m, see `config/staging.yaml`) in
  front of the entrance.
- **EXACT vs. PROVISIONAL** (`result.quality`, `result.geometry_quality`):
  `EXACT` means both ramp endpoint tags (ids 0 and 2) directly contributed
  this frame. `PROVISIONAL` means a usable estimate exists but was
  projected from fewer tags (e.g. only tag 1, or only one endpoint) using a
  nominal distance -- **less trustworthy, not production-ready**, and
  currently disabled outright in some cases because the nominal distance
  is unmeasured (see section 12). `INVALID` means no usable estimate this
  frame.
- **LIVE / HELD / LOST** (`result.live_tag_ids` / `held_tag_ids` /
  `lost_tag_ids`): a tag not seen in the current frame is temporarily
  `HELD` (its last known pose is reused) for up to `hold_timeout_s`
  (`0.20` s, see `config/tag_tracking.yaml`) before becoming `LOST`. This
  smooths 1-2 frame detection flicker; it is not a substitute for a real
  occlusion-handling strategy.
- None of the above transitions have been validated against a physically
  moving rover -- see `CURRENT_STATUS.md`.

## 10. Failure behavior

This package fails **explicitly**, never by fabricating a direction:

| Situation | What you get |
|---|---|
| No tags visible | `result.valid = False`, `result.reason` explains why, `desired_travel_direction_deg = None` |
| Only one ramp tag visible | Depends on which tag and current config -- may be `PROVISIONAL` or `INVALID`; see section 12, `nominal_entrance_to_top_horizontal_m` is currently unset in both configs, which disables some single-tag PROVISIONAL cases entirely |
| Pose cannot be solved for a detected tag | That tag is simply excluded from this frame's fusion; not a crash |
| Ramp geometry is `PROVISIONAL` | `result.geometry_quality = "PROVISIONAL"` -- still returned, but callers should treat it as lower-confidence, per section 9 |
| Ramp/guidance geometry is `INVALID` | `result.valid = False` (or `ramp_valid = False`), no direction produced |
| A tag is temporarily `HELD` | Included in `result.held_tag_ids`; its pose is still used (see section 9) |
| Malformed camera input (wrong shape/dtype) or a missing optional dependency (e.g. `pupil-apriltags` not installed) | `process_frame()` **raises** `vision_docking.detector.TagDetectorError` or `vision_docking.pose.PoseEstimationError` -- these indicate a programming/environment problem, not a normal "no tags" frame, and are intentionally not swallowed |

## 11. Debug viewer

`scripts/test_ramp_geometry.py` is this project's own live validation tool
-- it opens a RealSense stream, runs the same underlying modules this
package's `pipeline.py` wraps, and draws an on-screen HUD (ramp geometry,
staging point, navigation path, desired direction arrow) using regular
(GUI-capable) OpenCV. It is included here **only as a reference /
debugging aid** for anyone who wants to see the same intermediate values
`VisionDockingPipeline` reports, drawn live. It is not part of the
recommended rover runtime architecture, and it requires `opencv-python`
(not `-headless`) plus `pyrealsense2` plus a connected camera to run.

## 12. BEFORE DEPLOYING ON THE ROVER

The following are known-incomplete or laptop-prototype-only items, taken
directly from the current config files and source comments -- not
theoretical concerns:

- **Tag mounting positions/orientations are not measured.** `config/
  tags.yaml`'s `position_m` / `rotation_deg` for all three tags (ids 0/1/2)
  are placeholder `[0.0, 0.0, 0.0]` values, each explicitly marked
  `TODO(vision-docking): not yet measured on the physical ramp`.
- **`nominal_entrance_to_top_horizontal_m` is `null`** in both `config/
  staging.yaml` and `config/ramp_prototype.yaml`. Until measured, several
  PROVISIONAL fallback cases (only tag 1 visible, or only one endpoint
  tag) produce **no** estimate rather than a guess -- this is intentional
  (see section 10) but means those fallback paths cannot be exercised at
  all until this value is set.
- **`camera_height_m: 0.4064`** in `config/staging.yaml` is explicitly
  commented "measured, laptop prototype" -- this is not the rover's real
  camera mounting height and must be re-measured once the camera is
  mounted on the rover.
- **`entrance_offset_m` / `top_offset_m`** in `config/ramp_prototype.yaml`
  are both `0.0` (no-op placeholders) pending measurement of any physical
  offset between a tag's mounted center and the true entrance/top point.
- **No camera-to-rover extrinsic transform exists.** This prototype
  assumes the camera's own optical origin and forward axis (`+Z`) are
  equivalent to the rover's reference point and forward direction. If the
  camera is mounted anywhere other than dead-center, forward-facing, on
  the rover, a calibration transform between camera frame and rover frame
  is needed and does not exist yet in this codebase.
- **No steering/actuation controller tuning exists** -- this package stops
  at `desired_travel_direction_deg`; all controller gain/response tuning
  is entirely the rover repository's responsibility and unstarted here.
- **Path-section transition thresholds** (`APPROACH` -> `FINAL_ALIGNMENT`
  -> `RAMP`) have only been exercised in unit tests and the debug viewer,
  not against a physically moving rover -- treat the exact distances/
  headings that trigger each transition as provisional until validated on
  hardware.
- **No minimum-turn-radius or Bezier-feasibility check exists.** The
  `APPROACH` section's curved path (`config/approach_path.yaml`) is
  generated purely for a reasonable-looking curve; nothing currently
  verifies the rover can physically follow it.
- **No physical validation of ramp traversal logic.** The `RAMP` section's
  "continue using remaining centerline tags as earlier ones are passed"
  behavior has been unit-tested against synthetic data only (see
  `CURRENT_STATUS.md`) -- it has not been run against a rover physically
  climbing the ramp.
