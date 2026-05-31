---
name: project-monday-demo-fixes
description: 14 critical fixes applied 2026-05-30 for live delivery demo 2026-06-01
metadata:
  type: project
---

Full audit and fix session completed 2026-05-30. Two audit passes, 14 fixes total.

## Fixes applied

| # | File | What was wrong | Fix |
|---|---|---|---|
| 1 | setup.json | `follow_sidewalk_enabled: false` — Noah was blind to the path | Set `true` |
| 2 | compass_calibration.js | First-cal alpha 0.7 could slam heading ±8° mid-mission | Alpha 0.3, MAX_OFFSET_CHANGE_DEG=3.0 clamp |
| 3 | dock_white_rabbit.js | IMU guard `&&` — passed partial sensor data | Changed to `\|\|` |
| 4 | follow_the_light.js | IMU guard `&&` — same | Changed to `\|\|` |
| 5 | run_mission.js | Dock return heading alignment had NO timeout — infinite yaw | 30s timeout, voice "Alignment timeout. Searching for the light." |
| 6 | run_mission.js | No RealSense warmup warning | Voice says "Eyes warming up. Navigating by stars." |
| 7 | run_mission.js | No GPS validity check — null coords caused wrong math | Skip tick if lat/lng null or zero |
| 8 | setup.json | `stale_detection_ms: 1200` — too aggressive | Increased to `2000` |
| 9 | setup.json | `object_max_distance_m: 2.0` — saw obstacles only 2m away | Increased to `3.5` |
| 10 | run_mission.js | `avoidance_timed_out` shortcut could fire delivery off the dock | Guarded by `seq > 0` |
| 11 | deliver_package.js | `seq -= 2` could go negative | `Math.max(1, seq - 2)` |
| 12 | follow_the_light.js | `docking_ramp` state had NO timeout — infinite ramp climb | 30s ramp timeout |
| 13 | yaw_white_rabbit_for_package_delivery.js | Same `seq -= 2` issue on Arduino-missing path | `Math.max(1, seq - 2)` |
| 14 | undock_white_rabbit.js | Lingering timeout could fire twice on re-entry | `clearTimeout` safety in `undocked_completed` |

## Still medium-risk (monitor during demo)
- Drive-through waypoint validation — if next waypoint is 0,0 it's skipped silently
- RealSense freeze fallback — if detection freezes mid-block, countdown could stall

## Remaining known architecture notes
- Compass auto-calibration fires after 3m travel, every 30s — gentle now (3° max change)
- Vision confidence must stay ≥ 0.6 for sidewalk steering to engage
- IRLock search spins for 60s before declaring `docking_failed`
- Dock return heading alignment: 30s max then proceeds blind to IRLock
