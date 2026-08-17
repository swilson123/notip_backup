# Ramp calibration guide

**Current deployed hardware is the three-tag centerline layout** (id 0 =
entrance-center, id 1 = middle-center, id 2 = top-center, all mounted
directly on the ramp centerline) -- see "Prototype quick-start" below,
which is what `scripts/test_ramp_geometry.py` actually uses today.

The "Full calibration" checklist further down this file describes
`config/ramp.yaml`/`vision_docking.tag_fusion.TagFusion`'s *original*
two-rigid-section, five-tag model (entrance: ids 0-1; upper: ids 2-4).
That code is left in place as generic, reusable infrastructure -- see
`tag_fusion.py`'s module docstring, "Why the ramp is modeled as two
rigid sections, not one rigid body" -- but it is **not** calibrated for,
or wired into, the current three-tag hardware. Skip straight to the
quick-start below unless you are specifically reviving that older model
for a future five-tag-style ramp.

This is a **measurement checklist**, not a calibration tool -- there is
no automatic calibration in this milestone. See
`vision_docking.config.load_ramp_config()`/`load_ramp_prototype_config()`
for exactly what is/isn't required for each respective file to load
(structure is always required; individual measurements may stay `null`
until you have them).

**This file is only about ramp *geometry* reconstruction
(`config/ramp.yaml`/`config/ramp_prototype.yaml`).** The separate
virtual staging-point target (`vision_docking.guidance`,
`config/staging.yaml`: each ramp-centerline tag's mounting-yaw offset
and the camera's ground-plane height) is calibrated independently --
see the "Guidance target generation" section of
[`README.md`](../README.md) for that.

## Prototype quick-start (three-tag centerline model)

`config/ramp_prototype.yaml`, loaded by `vision_docking.config.
load_ramp_prototype_config()` into `tag_fusion.py`'s
`estimate_ramp_from_three_tags()`/`ThreeTagRampEstimator`, assumes a
fixed physical layout instead of per-tag calibration:

* id 0 is mounted directly at the ramp entrance -- **its own position
  is the entrance center**, no offset or rotation needed (until
  `entrance_offset_m` is measured).
* id 2 is mounted exactly at the ramp's top center -- **it is the top
  center point**, not an offset from it (until `top_offset_m` is
  measured).
* id 1 sits at the centerline's middle. **The primary ramp centerline is
  the single straight 3D line from the entrance center to the top
  center** whenever both are visible; id 1's position is projected onto
  that line purely as a diagnostic -- how far off-axis it sits and
  where along the line its projection falls -- and never moves or bends
  the centerline itself, even with a noisy middle-tag pose or the
  middle ramp section changing pitch. See `tag_fusion.py`'s module
  docstring, "Three-tag centerline model" section, for the full
  visibility-case hierarchy (what happens when one or more of ids 0-2
  aren't currently visible).

Needs only 3 values, all in `config/ramp_prototype.yaml`:

* `ramp_width_m` -- overall rail-to-rail width, metres, or `null` if not
  yet measured (no landmark reconstruction to fall back on in this
  model).
* `entrance_offset_m` / `top_offset_m` -- leave at `0.0` for now; see
  `tag_fusion.py`'s `estimate_ramp_from_three_tags()` docstring for what
  these will do once measured.
* `nominal_entrance_to_top_horizontal_m` -- the nominal horizontal
  entrance-to-top distance, metres, or `null` if not yet measured; used
  *only* to reconstruct whichever of entrance/top isn't currently
  visible, always as a provisional (not exact) estimate.

No per-tag XYZ position, no tag mounting rotation, and no origin/axis
convention choice are required for this model -- it reads each
relevant tag's own camera-relative position directly. Validate with:

```bash
python scripts/test_ramp_geometry.py
```

## Full calibration (historical five-tag model): units and conventions

* **All translations are in metres. All rotations are in degrees.**
* **Rotation order:** intrinsic Tait-Bryan Z-Y-X -- write each rotation
  as `[yaw, pitch, roll]`, applied yaw-then-pitch-then-roll.
* **Which tag-frame convention:** use the same *corrected*/intuitive
  tag-local frame that `vision_docking.pose`'s `TagPose.yaw_deg`/
  `pitch_deg`/`roll_deg` already report -- **not** the raw backend frame
  (`TagPose.rotation`). Practically: run `scripts/test_apriltag_pose.py`
  and read a tag's `yaw`/`pitch`/`roll` directly off the "corrected"
  overlay line (not the "raw pose" block) as your reference for what
  "0/0/0" and "positive" mean for a tag held facing you, upright,
  un-rotated.
* Every measurement below is **one section's local frame relative to
  itself**, or **one tag relative to its section** -- never relative to
  the camera. The camera-relative math is `tag_fusion.py`'s job, not
  something you need to compute by hand.

## Step 1 -- Choose the entrance section's origin and axes

Pick any convenient, physically identifiable point and orientation for
the entrance assembly's (ids 0, 1) own local frame. It does **not** have
to sit at either tag, and does not have to match the upper section's
frame. A reasonable choice: the entrance section's own geometric
center, with +X pointing from left to right (as you face the ramp from
outside, about to enter it), +Y pointing up, +Z pointing along the
direction of travel into the ramp (matching the "intuitive" tag-frame
convention above, so a tag mounted flush and facing straight down the
ramp reads yaw/pitch/roll near zero relative to this frame).

**Record:** a sentence or diagram (outside this YAML file, e.g. a photo
with the origin/axes marked) describing exactly where you put this
origin and which physical direction each axis points. Future
measurements are meaningless without this reference.

## Step 2 -- Choose the upper section's origin and axes

Same exercise, independently, for the upper assembly (ids 2, 3, 4). A
reasonable choice: centered between tags 2 and 3, same axis convention
as the entrance section (+X left-to-right, +Y up, +Z along the ramp's
direction of travel at the top).

**Record:** same as step 1, for the upper section.

## Step 3 -- Measure each tag's mounting transform

For **each** of the 5 tags, relative to *its own section's* origin/axes
(entrance section for ids 0-1, upper section for ids 2-4):

* **Tag center position** (`config/ramp.yaml`'s `tag_mounts[id].
  translation_m`): the `[x, y, z]` position of that tag's printed
  center, in the section's local frame, metres.
* **Tag orientation** (`tag_mounts[id].rotation_deg`): `[yaw, pitch,
  roll]` of the tag relative to the section's axes, degrees, per the
  convention above.

Do this for ids 0, 1 (entrance section) and ids 2, 3, 4 (upper section).

## Step 4 -- Measure the entrance landmarks

Relative to the entrance section's own origin/axes (step 1):

* **`entrance_center_m`**: the point the rover should aim to cross when
  entering the ramp.
* **`entrance_left_m`** / **`entrance_right_m`**: the left and right
  outside-edge points of the entrance (rail-to-rail or track-to-track
  outer extent, whichever is the true physical boundary).

## Step 5 -- Measure the upper landmarks

Relative to the upper section's own origin/axes (step 2):

* **`top_center_m`**: the ramp's top-center landmark.
* **`top_left_m`** / **`top_right_m`**: the left and right outside-edge
  points at the top of the ramp.

## Step 6 -- Measure the overall ramp width

* **`width_m`**: the ramp's overall width, left-outside-edge to
  right-outside-edge, metres. Used only as a cross-check against the
  width reconstructed from the entrance/upper edge landmarks above
  (`config/ramp.yaml`'s `tolerances.width_tolerance_fraction`) -- it is
  fine to leave this `null` if you don't have an independent
  measurement; the reconstructed width is still reported either way.

## Step 7 -- Enter everything into `config/ramp.yaml`

Replace each `null` with the measured `[x, y, z]` triple (or scalar, for
`width_m`). Leave anything you haven't measured yet as `null` --
`vision_docking.config.load_ramp_config()` still loads the file
successfully; `vision_docking.tag_fusion.TagFusion` will simply report
`RampSectionEstimate.valid=False`/`RampEstimate.valid=False` with a
`reason` naming exactly what's still missing, for anything that
specifically needs a measurement you haven't entered yet.

## Step 8 -- Validate against the live viewer

Run `python scripts/test_ramp_geometry.py` with the tags visible.
Sanity-check:

* Each tag's individually-drawn axis triad and position roughly matches
  where you'd expect it, physically.
* `entrance_center_m`/`top_center_m` (once both sections have at least
  one measured mount) land visually where you'd expect on the ramp.
* `width_m` (once edge landmarks are entered) is close to a tape-measure
  check of the real ramp width.
* `deployed_length_m` changes sensibly as the entrance assembly is
  physically extended/retracted (if applicable to your hardware).

If any of these look wrong, the most likely cause is a mixed-up sign or
axis in one tag's `rotation_deg`/`translation_m` -- re-check that one
tag's mount against the origin/axis convention you recorded in steps 1-2
before re-measuring everything.
