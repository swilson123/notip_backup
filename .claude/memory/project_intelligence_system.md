---
name: project-intelligence-system
description: Claude as Jiminy Cricket — Noah's conscience and advisor at key decision moments
metadata:
  type: project
---

Noah has Claude as his Jiminy Cricket. At key decision moments — path blocked, stuck
detected, avoidance start, fallback delivery triggered — the intelligence system
generates multi-perspective thinking and can apply parameter edits live.

## How it works
- `white_rabbit.intelligence.consider(situation)` — called at decision moments
- Generates alternative approaches, scores by priority, stores in `lib/memory/perspectives.json`
- When internet available, Claude reviews Noah's logs and live state, enriches the list
- Parameter edits applied live if `auto_apply_params: true` in setup.json
- Perspectives persist across reboots — Noah carries his thinking

## When Jiminy Cricket speaks (call sites)
- `run_mission.js` — path blocked detection: `intelligence.consider('path_blocked')`
- `memory_watchdog.js` — stuck detected: `intelligence.consider('stuck_detected')`
- `deliver_package.js` — fallback delivery: `intelligence.consider('fallback_delivery_triggered')`

## Editable parameters (Claude can suggest changes within bounds)
- nav_tuning: rs_block_timeout_ms, avoidance_timeout_ms, mission_yaw_start/stop_deg, yaw speeds, two_wheel_steering_gain
- realsense_vision: confidence_threshold, object_emergency_stop_m, path_center_deadband_m, carrot_distance_m, speed_scale_min

## setup.json config
```json
"intelligence": {
    "enabled": true,
    "claude_enabled": true,
    "auto_apply_params": true,
    "consult_cooldown_ms": 60000,
    "api_key": ""
}
```
