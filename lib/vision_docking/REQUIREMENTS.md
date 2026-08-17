# vision_docking -- Requirements

## Supported / tested Python environments

- **Python**: `>=3.10` required (see `pyproject.toml`); **3.11
  recommended** for a Raspberry Pi 5 target (matches Raspberry Pi OS
  Bookworm's default Python; not itself tested on a Pi in this handoff --
  see `INTEGRATION.md` section 5).
- **Development/verification platform**: Windows, Python 3.11, this
  session. AprilTag detection could not be exercised against the real
  `pupil-apriltags` native library on this specific Windows machine (a
  pre-existing, environment-specific DLL-loading issue, unrelated to this
  package's code) -- verified instead with a fake backend; see
  `CURRENT_STATUS.md` and the final handoff report for exactly what was
  and was not run against real hardware.

## Python packages (runtime)

See `requirements.txt` for the installable list and `INTEGRATION.md`
section 4 for what each one is used by.

| Package | Required? |
|---|---|
| `numpy` | Always |
| `PyYAML` | Always |
| `opencv-python-headless` (or `opencv-python`, not both) | Always |
| `pupil-apriltags` | Effectively always -- no tag detection without it |
| `pyrealsense2` | Only if using this package's own `camera.RealSenseCamera` |

Not required at runtime, intentionally excluded: `pytest`, `pytest-cov`,
`mypy`, `ruff`, `reportlab`, or any other dev/test/tag-generation tooling
from the original repository.

## Hardware dependencies

- Intel RealSense D435i or D435iF (only camera this project has been built
  and tested against).
- Three printed tag36h11 AprilTags, physically mounted at the ramp
  entrance, middle, and top (ids 0, 1, 2 respectively), each printed at
  the size in `config/tags.yaml` (`overall_size_m: 0.1270`,
  `pose_tag_size_m: 0.09525`). All three currently use the identical size.

## Expected camera input format

- `frame_bgr`: a `(height, width, 3)`, `dtype=uint8` BGR image -- exactly
  what a `cv2` color capture or a RealSense color frame already provides,
  no pre-processing required. `VisionDockingPipeline.process_frame()`
  converts to grayscale internally.
- Tested resolution/frame rate: 1280x720 @ 30fps (`config/camera.yaml`).
  Other resolutions are not prohibited but are untested.

## Required intrinsics

A `vision_docking.models.CameraIntrinsics` describing the *exact* frame
passed in: `fx, fy, cx, cy, width, height`, and optionally `distortion`.
Must come from your camera's active stream profile at runtime -- never a
hard-coded/previously-recorded value (camera resolution changes and
unit-to-unit variation both invalidate a stale value). See
`INTEGRATION.md` section 3.

## Configuration files (all included in `config/`)

| File | Required by |
|---|---|
| `tags.yaml` | `VisionDockingPipeline.from_config_dir()` (always) |
| `staging.yaml` | `VisionDockingPipeline.from_config_dir()` (always) |
| `ramp_prototype.yaml` | `VisionDockingPipeline.from_config_dir()` (always) |
| `approach_path.yaml` | Optional -- built-in defaults used if absent |
| `tag_tracking.yaml` | Optional -- built-in default (`hold_timeout_s=0.20`) used if absent |
| `camera.yaml` | Only if constructing `vision_docking.camera.RealSenseCamera` directly (Pattern B) |

## Optional visualization dependencies

`opencv-python` (GUI-capable, not `-headless`) plus `pyrealsense2` plus a
connected camera, only if you want to run `scripts/test_ramp_geometry.py`,
this project's own live debug viewer. Not needed for
`VisionDockingPipeline` itself. See `INTEGRATION.md` section 11.
