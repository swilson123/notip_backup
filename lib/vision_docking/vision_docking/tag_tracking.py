"""Temporal tag-pose hold layer -- smooths short per-frame detection
dropouts before they reach ramp geometry reconstruction or staging-point
generation.

    ... -> Pose Estimation -> Tag Tracking -> Multi-Tag Fusion / Guidance Target -> ...

Problem this solves
------------------------------------------------------------------------
`pose.py` reports, every frame, only the tags actually detected+posed
that frame -- there is no persistence anywhere below this layer. On
real hardware, the middle and top ramp-centerline tags (farther from
the camera, more prone to a missed corner or a decision-margin dip) can
flicker between detected and not-detected for a frame or two even while
physically stationary. Without this layer, that one-frame dropout looks
identical to "the tag moved out of view" to both `tag_fusion.py`'s
three-tag centerline model and `guidance.py`'s EXACT/PROVISIONAL
hierarchy -- dropping straight from EXACT geometry to a lower-confidence
fallback, or losing the top landmark entirely, for a dropout that never
actually happened physically.

This module tracks each configured tag ID's own small state machine and,
when appropriate, temporarily re-injects that tag's last known pose into
the pose list handed downstream via `resolved_poses()` -- so
`tag_fusion.py` and `guidance.py` continue to receive an ordinary
`list[TagPose]` and remain completely unaware this layer exists.
**Neither of those modules, nor any of their geometry, is modified by
this file.**

The three-state model
------------------------------------------------------------------------
For each tracked tag ID, `TagPoseTracker.update()` reports exactly one
`TrackedTag` (see `models.py`), whose `state` is one of:

    * `LIVE` -- a valid pose was observed *this* frame; that pose is
      used, and it becomes the new "last known" pose/timestamp.
    * `HELD` -- no valid pose was observed this frame, but the last
      known pose is younger than `TagHoldConfig.hold_timeout_s`; that
      stale pose is temporarily reused, verbatim (never modified,
      smoothed, or extrapolated -- see "No smoothing" below).
    * `LOST` -- no valid pose was observed this frame, and either the
      last known pose is now older than `hold_timeout_s`, or the tag has
      never been observed at all. No pose is reported for this tag.

`LIVE` always overrides a previously `HELD` pose the instant the tag is
observed again -- there is no cooldown or hysteresis on the way back up,
only on the way down (holding through a brief dropout). Timestamps, not
frame counts, drive the timeout, so this works correctly regardless of
the actual frame rate; a caller using frame indices instead of wall-clock
time can pass those as the `timestamp` argument just as validly, as long
as `hold_timeout_s` is expressed in the same unit.

No smoothing
------------------------------------------------------------------------
A `HELD` pose is the exact, unmodified `TagPose` last observed live --
never averaged, filtered, or extrapolated forward in time. This is a
deliberate, minimal first step: the goal is only to stop a 1-2 frame
dropout from being indistinguishable from "tag actually gone," not to
improve pose accuracy. A future milestone could add smoothing on top of
this layer without changing its state-machine contract.

Never holds indefinitely
------------------------------------------------------------------------
`hold_timeout_s` is a hard ceiling, not a suggestion: once a tag's last
observation is older than that, it reports `LOST` and contributes no
pose at all, on every subsequent call, until it is observed live again.
There is no unbounded "last known position" fallback anywhere in this
module. Repeated `HELD` frames do **not** refresh the timer -- the clock
runs from the last genuinely *live* observation, not from the last time
a pose was reported at all, so a tag cannot be held forever by a string
of back-to-back dropouts.

Raw detections remain available separately
------------------------------------------------------------------------
`TagPoseTracker.update()` never mutates or discards the caller's raw,
current-frame `list[TagPose]` -- it only reads it. The caller keeps that
raw list for debug rendering (`draw_tag_poses()`, `draw_tag_detections()`)
exactly as before; only the *separate*, resolved list `resolved_poses()`
builds from this module's own output is handed to `tag_fusion.py`/
`guidance.py`.

Architecture: no sibling imports
------------------------------------------------------------------------
Like every other pipeline module, this one imports only from `models.py`
(`TagPose`, `TrackedTag`, `TagTrackingState`). It does not import
`config.py`, `tag_fusion.py`, or `guidance.py` -- its own small
`TagHoldConfig` type is structurally similar to, but a deliberately
separate declaration from, `config.py`'s `TagTrackingConfig`; a caller
(`scripts/test_ramp_geometry.py`) converts one into the other, exactly as
already happens for `AprilTagDetector`/`TagPoseEstimator`/`TagFusion`.
"""
from __future__ import annotations

from dataclasses import dataclass

from .models import TagPose, TagTrackingState, TrackedTag


@dataclass(frozen=True)
class TagHoldConfig:
    """Calibration for `TagPoseTracker` -- see this module's docstring.

    `hold_timeout_s` is how long (in whatever unit the caller's
    `TagPose.timestamp`/`update()` timestamp argument uses -- seconds for
    a wall-clock timestamp, frames for a frame index) a tag's last
    observed pose is temporarily reused after it stops being directly
    detected, before that tag is reported `LOST`.
    """

    hold_timeout_s: float


def resolved_poses(tracked_tags: list[TrackedTag]) -> list[TagPose]:
    """Return the temporally-resolved `list[TagPose]` -- `LIVE` and
    `HELD` poses only, in *tracked_tags* order -- ready to hand to
    `tag_fusion.py`/`guidance.py` in place of a frame's raw detections.
    `LOST` tags contribute nothing, exactly as an undetected tag always
    has."""
    return [tracked.pose for tracked in tracked_tags if tracked.pose is not None]


class TagPoseTracker:
    """Stateful per-tag-ID temporal hold tracker -- the *only* stateful
    component in the otherwise-stateless vision pipeline before
    `docking_controller.py`. See this module's docstring for the full
    `LIVE`/`HELD`/`LOST` state machine.

    Tracks exactly the *configured* tag IDs passed at construction
    (`tag_ids`) -- `update()` always returns one `TrackedTag` per
    configured ID, in that order, regardless of what other tag IDs
    happen to appear in a given frame's `tag_poses` (those are simply
    not tracked here; a caller that also needs them still has its own
    raw `tag_poses` list to read from).
    """

    def __init__(self, tag_ids: tuple[int, ...], config: TagHoldConfig) -> None:
        self._tag_ids = tag_ids
        self._config = config
        self._last_pose: dict[int, TagPose] = {}
        self._last_seen_timestamp: dict[int, float] = {}

    def update(self, tag_poses: list[TagPose], timestamp: float) -> list[TrackedTag]:
        """Return this frame's `TrackedTag` for every configured tag ID,
        given the current frame's raw *tag_poses* and *timestamp*.

        Updates this tracker's own internal state (each configured tag's
        last known pose/timestamp) as a side effect -- call this exactly
        once per frame, with a *timestamp* that only increases from call
        to call.
        """
        observed = {pose.tag_id: pose for pose in tag_poses}

        results: list[TrackedTag] = []
        for tag_id in self._tag_ids:
            if tag_id in observed:
                pose = observed[tag_id]
                self._last_pose[tag_id] = pose
                self._last_seen_timestamp[tag_id] = timestamp
                results.append(TrackedTag(tag_id, pose, TagTrackingState.LIVE, timestamp))
                continue

            last_seen = self._last_seen_timestamp.get(tag_id)
            if last_seen is not None and (timestamp - last_seen) <= self._config.hold_timeout_s:
                results.append(
                    TrackedTag(tag_id, self._last_pose[tag_id], TagTrackingState.HELD, last_seen)
                )
            else:
                results.append(TrackedTag(tag_id, None, TagTrackingState.LOST, last_seen))

        return results
