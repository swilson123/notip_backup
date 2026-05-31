---
name: project-yellow-brick-road
description: Noah's mission language and the core navigation challenge — following the sidewalk
metadata:
  type: project
---

The trickiest part of Noah's mission is **following the yellow brick road** — the sidewalk.
Vision-guided sidewalk following via RealSense is the heart of the outbound journey.

## The full mission arc
1. **Undock** — climb down the rabbit hole (ramp) and clear the dock
2. **Outbound** — follow the yellow brick road (RealSense sidewalk steering) guided by the stars (GPS waypoints)
3. **Deliver** — 180° turn, drop the package, Jiminy Cricket speaks at fallback moments
4. **Return** — follow the stars back toward the light (IRLock beacon)
5. **Dock** — find the light, align heading, climb back up the rabbit hole

## What makes the yellow brick road work
- `follow_sidewalk_enabled: true` in setup.json (was false before 2026-05-30 fix)
- RealSense confidence ≥ 0.6 triggers sidewalk centerline steering
- Confidence tiers: 0.92 (both edges), 0.85 (one color+depth), 0.65 (one edge), <0.35 (GPS only)
- `stale_detection_ms: 2000` — 2s grace before falling back to GPS-only
- Vision latches for 1500ms and fades over 1000ms for smooth transitions
- GPS crosstrack correction always runs underneath as a floor

## Pre-flight checklist (must complete before every demo)
- [ ] GPS lock 30+ seconds before arming
- [ ] RealSense live 15 seconds before mission start — Noah says "Eyes warming up. Navigating by stars." if armed too soon
- [ ] Compass calibrated at demo site — verify `imu.compass_offset_deg` in setup.json
- [ ] All waypoints have valid lat/lng (no 0,0 entries)
- [ ] IRLock beacon placed where camera sees it at dock approach distance
- [ ] Path clear of obstacles taller than 5 inches, 3.5m on either side
- [ ] `mission_count > 0` confirmed before arming
- [ ] `follow_sidewalk_enabled: true` confirmed in setup.json

## Key setup.json vision values (as of 2026-05-30)
```json
"follow_sidewalk_enabled": true,
"confidence_threshold": 0.6,
"stale_detection_ms": 2000,
"object_max_distance_m": 3.5,
"object_emergency_stop_m": 1.0,
"carrot_distance_m": 1.5
```
