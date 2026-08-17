# vision_docking -- Current Status

Concise engineering status, based strictly on what has actually been built
and tested in this repository -- not aspirational. See `INTEGRATION.md`
section 12 ("BEFORE DEPLOYING ON THE ROVER") for the calibration gaps
behind several of the "needs rover validation" items below.

## WORKING / PHYSICALLY TESTED

- AprilTag (tag36h11) detection against a physical camera and printed
  tags, via `pupil-apriltags` (`detector.py`).
- Per-tag 3D pose estimation against physical tags, using the measured
  `pose_tag_size_m` (`pose.py`). Camera coordinate convention (`+X` right,
  `+Y` down, `+Z` forward) is verified against physical hardware -- see
  `pose.py`'s own docstring.
- RealSense D435i frame capture and intrinsics reporting
  (`camera.py`, `RealSenseCamera`), at 1280x720@30fps.
- The live debug viewer (`scripts/test_ramp_geometry.py`) has been run
  against a physical camera and physical tags, showing detected tags,
  reconstructed ramp geometry, and the navigation HUD.

## IMPLEMENTED / NEEDS ROVER VALIDATION

Built and unit-tested (synthetic data, no physical rover), but not yet
validated against a moving rover on the physical ramp:

- Three-tag ramp centerline reconstruction (`tag_fusion.py`,
  `ThreeTagRampEstimator`) -- EXACT case (both tags 0 and 2 visible) and
  the PROVISIONAL fallback cases that don't depend on the currently-unset
  `nominal_entrance_to_top_horizontal_m` (see `INTEGRATION.md` section 12).
- Staging-point generation (`guidance.py`, `GuidanceTargetGenerator`) and
  the EXACT/PROVISIONAL quality hierarchy it implements.
- Temporal tag-pose hold layer (`tag_tracking.py`, `TagPoseTracker`,
  LIVE/HELD/LOST states, `hold_timeout_s = 0.20`).
- Ordered navigation path construction (`visualization.py`,
  `build_navigation_path()`): `ROVER -> STAGING -> ENTRANCE -> TOP`,
  `APPROACH` / `FINAL_ALIGNMENT` / `RAMP` path sections, the Bezier
  approach curve, and `desired_path_direction()`.
- RAMP-mode path-progress commitment (`advance_path_progress()`,
  `PathProgressState`) -- continuing straight using remaining centerline
  tags as earlier tags are passed. Unit-tested against synthetic tag
  sequences only.
- The `VisionDockingPipeline` / `DockingResult` integration facade
  (`pipeline.py`) added for this handoff -- verified end-to-end with a
  fake AprilTag backend (no tags -> invalid; two-endpoint-tag EXACT
  geometry with correct staging distance; repeated-frame LIVE persistence;
  single-frame tag dropout correctly reported as HELD, not LOST) and
  `mypy --strict` clean. Not yet run against a real camera + real tags in
  this exact wrapped form (only the underlying modules it orchestrates
  have been run against real hardware, via the debug viewer).

## NOT YET IMPLEMENTED

- Any steering, throttle, or actuation logic. `docking_controller.py`
  (`DockingController.compute_command()`) is a stub that raises
  `NotImplementedError`, and is not included in this handoff package.
- Any docking/mission state machine. `state_machine.py`
  (`DockingStateMachine.update()`) is a stub that raises
  `NotImplementedError`, and is not included in this handoff package.
- Camera intrinsics calibration/save/load. `calibration.py`'s
  `calibrate()` / `save_intrinsics()` / `load_intrinsics()` all raise
  `NotImplementedError`, and it is not included in this handoff package.
  `RealSenseCamera` currently always reports the RealSense SDK's own
  active-profile intrinsics instead.
- A camera-to-rover extrinsic transform. The prototype assumes the
  camera's optical origin/forward axis are equivalent to the rover's
  reference point/forward direction.
- Measured tag mounting positions/orientations on the physical ramp
  (`config/tags.yaml`'s `position_m`/`rotation_deg` are all placeholder
  zeros).
- A measured nominal entrance-to-top horizontal distance
  (`nominal_entrance_to_top_horizontal_m` is `null` in both
  `config/staging.yaml` and `config/ramp_prototype.yaml`), which currently
  disables several single-tag PROVISIONAL fallback cases entirely.
- The rover's real camera mounting height (`camera_height_m: 0.4064` in
  `config/staging.yaml` is explicitly a laptop-prototype measurement).
- Minimum-turn-radius / Bezier-feasibility checking for the `APPROACH`
  path.
- Any physical validation of the `RAMP` section's traversal logic on a
  rover actually climbing the ramp.
