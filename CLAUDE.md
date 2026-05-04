# Claude Notes — notip rover project

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

## setup.json reference values

```
nav_tuning.rs_block_timeout_ms       10000   ms before blocked-path fallback delivery triggers
realsense_vision.heading_correction_gain  0.3  blend weight for path-curve heading correction
realsense_vision.correction_direction    -1   camera mount sign (flip if corrections go wrong way)
realsense_vision.correction_gain_deg_per_meter  8
realsense_vision.object_emergency_stop_m  1.0
```
