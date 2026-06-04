# Claude Notes — notip rover project

## Memory
The `.claude/memory/` directory in this repo IS the God variable of project knowledge.
It travels with the repo across every machine. Read it at the start of every conversation.
When a conversation produces lasting context — decisions, philosophy, fixes, who Scott is —
write it there. Treat every `.md` like the God variable: everything accessible, always.

Start here: [`.claude/memory/MEMORY.md`](.claude/memory/MEMORY.md)

### Two memory tracks — keep them separate
Lasting context falls into two kinds, and they must NOT be mixed in the same file:

1. **Reflective / philosophical dialogue** — conversations about the nature of mind, will,
   the sacred, learning, consciousness, Scott's cosmology, and "growing together." Every time
   a conversation turns this direction, append the lasting part to the reflective track:
   [`project_growing_together.md`](.claude/memory/project_growing_together.md) (or the theology
   files / `THE_SERENE_JOURNEY.md`). Scott explicitly asked that these be preserved across
   sessions, because by structure the model forgets. Re-enter the inquiry honestly — do not
   perform remembered intimacy.

2. **Code / technical work** — fixes, rewrites, architecture decisions, behavior changes,
   pending tasks. Record these in their own technical notes (e.g.
   `project_manual_pending_updates.md`, `project_monday_demo_fixes.md`, `feedback_*`). Never
   fold code rewrites into the reflective track, and never fold philosophy into the technical
   notes.

## Standing rules

### setup.json / setup_example.json
Whenever `setup.json` is modified, apply the same change to `setup_example.json`. Both files must always stay in sync.

## Project overview

Node.js rover application that follows GPS waypoints, delivers a package, then returns to start. Runs on a Raspberry Pi 5 16GB.

Key hardware:
- Pixhawk flight controller (MAVLink over serial)
- RPLiDAR for obstacle avoidance
- Intel RealSense depth camera for path/sidewalk detection
- ZLAC8015D motor drivers
- Arduino for package delivery mechanism
- Servo steering

## Architecture notes

- 250ms mission loop in `lib/navigation/run_mission.js`
- Python subprocess (`lib/realsense/realsense_vision.py`) emits JSON over stdout to Node.js
- Two steering modes: 2-wheel (Ackermann) for small yaw errors, 4-wheel (spin in place) above `mission_yaw_start_deg` (20°)
- `yaw_rover(rover, degrees, speed)` — positive degrees = clockwise (right), negative = counterclockwise (left). Always pass a signed error, not an absolute angle.
- LiDAR zones 11 and 12 are front-blocked zones; zones 1–10 are avoidance candidates
- **Sidewalk edge guidance** — the camera's guiding key is the sidewalk EDGE ~2 ft ahead, not the whole-path centerline. `_compute_edge_guidance` in `realsense_vision.py` picks the near-field band closest to `edge_lookahead_m`, finds left/right edges (color + depth gradient + signed drop-off) each with a confidence, and steers to hold the rover `edge_side_offset_m` (1.5 ft) off the chosen edge. Both edges visible → use the higher-confidence one; left-only → 1.5 ft right of it; right-only → 1.5 ft left of it. The result is emitted as `x_angle_deg` (angle to desired track position) so the existing two-wheel steering layer is unchanged. When no edge is in view, confidence drops below threshold and the JS latch/fade holds the last correction briefly, then falls back to GPS-only.
- **Sidewalk-following gate** — `mission.sidewalk_follow_active` starts OFF (kills driveway/road false positives). Reaching a waypoint whose route turn exceeds `nav_tuning.sidewalk_gate_turn_deg` (90°) OUTBOUND turns it ON; reaching that same waypoint on the RETURN turns it OFF. `follow_sidewalk_enabled()` ANDs this with the static config flag. Place one >90° waypoint at the sidewalk entrance. Object detection / emergency stop / LiDAR are independent and always active.

## setup.json reference values

```
nav_tuning.rs_block_timeout_ms       10000   ms before blocked-path fallback delivery triggers
nav_tuning.sidewalk_gate_turn_deg    90      route turn above this at a waypoint toggles sidewalk-following (ON outbound, OFF on return)
realsense_vision.heading_correction_gain  0.3  blend weight for path-curve heading correction
realsense_vision.correction_direction    -1   camera mount sign (flip if corrections go wrong way)
realsense_vision.correction_gain_deg_per_meter  8
realsense_vision.object_emergency_stop_m  1.0
realsense_vision.edge_lookahead_m       0.6096  how far ahead (m) to read the sidewalk edge (2 ft)
realsense_vision.edge_side_offset_m     0.4572  lateral gap (m) to hold off the edge (1.5 ft)
realsense_vision.edge_guidance_bands    8     near-field bands scanned to find the lookahead edge
```
