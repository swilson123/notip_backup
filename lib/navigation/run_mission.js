const path_map_lib = require('../realsense/path_map');

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// Module-level log throttles so suppression / carrot logs don't spam the file.
let _last_carrot_log_ts = 0;
let _last_suppress_log_ts = {};
let _last_heart_log_ts = 0;
let _last_heart_pause_state = false;
let _last_heart_intent = null;
// Throttle sidewalk voice events — seeking toggles frequently; only announce
// once per 20 s so the rover isn't constantly narrating micro-corrections.
const SIDEWALK_VOICE_COOLDOWN_MS = 20000;
let _last_sidewalk_voice_ts = 0;

// The rover's voice. Each phase transition gets a named line so the mission
// reads as a narrated journey, not a sequence of state changes. Falls back
// to a generic "transition: X → Y" if a pair isn't listed.
const TRANSITION_LINES = {
    'standby->undocking':                       'the journey begins',
    'undocking->outbound':                      'undocked, on the path',
    'outbound->homestretch_outbound':           'nearing the delivery point',
    'homestretch_outbound->delivering':         'delivering',
    'delivering->returning':                    'package delivered — the work is done',
    'returning->homestretch_return':            'turning for home',
    'homestretch_return->docking':              'dock in sight',
    'docking->standby':                         'home'
};

function log_vision_suppressed(rover, reason, detail) {
    let now = Date.now();
    if (_last_suppress_log_ts[reason] && now - _last_suppress_log_ts[reason] < 1000) return;
    _last_suppress_log_ts[reason] = now;
    rover.logs.sidewalk_detection.log(rover, 'vision suppressed (' + reason + '): ' + detail);
}

function log_carrot_decision(rover, info) {
    let now = Date.now();
    if (now - _last_carrot_log_ts < 1000) return;
    _last_carrot_log_ts = now;
    rover.logs.sidewalk_detection.log(rover, 'carrot: ' + info);
}

function get_history_analysis(history, vision) {
    let result = { weighted_offset_meters: null, sustained_seeking: false, confidence_rising: false };
    if (!history || history.length === 0) return result;

    let now          = Date.now();
    let seek_enter_m = vision && typeof vision.sidewalk_seek_offset_m === 'number' ? vision.sidewalk_seek_offset_m : 0.1;
    let conf_floor   = vision && typeof vision.sidewalk_seek_confidence_threshold === 'number' ? vision.sidewalk_seek_confidence_threshold : 0.4;

    // Weighted average offset: exponential decay half-life ~2 s, confidence-weighted
    let weight_sum = 0, weighted_offset = 0;
    for (let i = 0; i < history.length; i++) {
        let e = history[i];
        if (e.confidence < 0.3) continue;
        let age_s = (now - e.timestamp) / 1000;
        let w = Math.exp(-age_s * 0.35) * e.confidence;
        weighted_offset += e.offset_meters * w;
        weight_sum += w;
    }
    if (weight_sum >= 0.01) result.weighted_offset_meters = weighted_offset / weight_sum;

    // Sustained offset: last 3 s has ≥60 % of frames above threshold, ≥75 % same direction
    let sustained = history.filter(e => e.timestamp >= now - 3000 && e.confidence >= conf_floor);
    if (sustained.length >= 5) {
        let above = sustained.filter(e => Math.abs(e.offset_meters) > seek_enter_m);
        if (above.length >= sustained.length * 0.6) {
            let pos = above.filter(e => e.offset_meters > 0).length;
            let neg = above.length - pos;
            if (pos >= above.length * 0.75 || neg >= above.length * 0.75) result.sustained_seeking = true;
        }
    }

    // Confidence trend: avg confidence last 1 s vs 1–3 s ago; rising by >0.1 means sidewalk entering frame
    let recent = history.filter(e => e.timestamp >= now - 1000);
    let older  = history.filter(e => e.timestamp >= now - 3000 && e.timestamp < now - 1000);
    if (recent.length >= 2 && older.length >= 2) {
        let avg_recent = recent.reduce((s, e) => s + e.confidence, 0) / recent.length;
        let avg_older  = older.reduce((s, e)  => s + e.confidence, 0) / older.length;
        result.confidence_rising = (avg_recent - avg_older) > 0.1;
    }

    return result;
}

function get_gps_crosstrack_bias_deg(rover, target_lat, target_lng) {
    if (!rover.mission || rover.mission.package_delivered) {
        return 0;
    }

    let current_seq = rover.mission.current_mission_seq;
    let prev_seq = current_seq - 1;

    let prev_waypoint = null;
    for (let i = 0; i < rover.mission.waypoints.length; i++) {
        if (rover.mission.waypoints[i].seq === prev_seq &&
            rover.mission.waypoints[i].lat && rover.mission.waypoints[i].lng) {
            prev_waypoint = rover.mission.waypoints[i];
            break;
        }
    }

    if (!prev_waypoint) return 0;

    let rover_lat = rover.robot_data.robot_latitude;
    let rover_lng = rover.robot_data.robot_longitude;

    let track_bearing = rover.get_bearing(prev_waypoint.lat, prev_waypoint.lng, target_lat, target_lng);
    let bearing_prev_to_rover = rover.get_bearing(prev_waypoint.lat, prev_waypoint.lng, rover_lat, rover_lng);
    let dist_from_prev_m = rover.gps_distance(prev_waypoint.lat, prev_waypoint.lng, rover_lat, rover_lng) * 1000;

    let bearing_diff_rad = (bearing_prev_to_rover - track_bearing) * Math.PI / 180;
    let crosstrack_m = Math.sin(bearing_diff_rad) * dist_from_prev_m;

    // Discard if GPS appears wildly off-track (likely noise)
    if (Math.abs(crosstrack_m) > 3.0) return 0;
    if (Math.abs(crosstrack_m) < 0.3) return 0;

    // Positive crosstrack = rover right of track → steer left (negative)
    let correction = -crosstrack_m * 5.0;
    return clamp(correction, -6, 6);
}

// Computes a destination lat/lng given a start point, bearing, and distance in meters.
function destination_from_point(lat, lng, bearing_deg, distance_m) {
    const R = 6371000;
    const d = distance_m / R;
    const lat1 = lat * Math.PI / 180;
    const lng1 = lng * Math.PI / 180;
    const brng = bearing_deg * Math.PI / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: lat2 * 180 / Math.PI, lng: lng2 * 180 / Math.PI };
}

// Computes a [0..1] speed-scale factor based on vision confidence. EMA-smoothed so
// confidence flicker doesn't lurch the rover. Used as another factor in the speed
// cascade alongside yaw-error and distance-to-waypoint scales.
//   high confidence → 1.0   (full speed)
//   low / stale / wide-path / no detection → floor (gives vision time to recover)
function get_vision_speed_scale(rover) {
    if (!rover.realsense || !rover.realsense.vision || !rover.realsense.vision.enabled) return 1.0;

    let vision = rover.realsense.vision;
    let detection = rover.realsense.path_detection;
    let scale_min  = typeof vision.speed_scale_min === 'number' ? vision.speed_scale_min : 0.4;
    let conf_full  = typeof vision.speed_scale_conf_full === 'number' ? vision.speed_scale_conf_full : 0.85;
    let conf_min   = typeof vision.speed_scale_conf_min === 'number' ? vision.speed_scale_conf_min : 0.6;
    let alpha      = typeof vision.speed_scale_smoothing === 'number' ? vision.speed_scale_smoothing : 0.3;

    let raw_scale;
    if (!detection || !detection.timestamp) {
        raw_scale = scale_min;
    } else if (Date.now() - detection.timestamp > vision.stale_detection_ms) {
        raw_scale = scale_min;
    } else if (detection.path_width_meters > 2.0) {
        // Junction — slow so the rover doesn't blow through the fork
        raw_scale = scale_min;
    } else {
        let conf = detection.confidence;
        if (conf >= conf_full) raw_scale = 1.0;
        else if (conf <= conf_min) raw_scale = scale_min;
        else {
            let t = (conf - conf_min) / (conf_full - conf_min);
            raw_scale = scale_min + t * (1.0 - scale_min);
        }
    }

    if (!rover.mission || !rover.mission.nav_control) return raw_scale;
    let nc = rover.mission.nav_control;
    if (typeof nc.vision_speed_scale_ema !== 'number') {
        nc.vision_speed_scale_ema = raw_scale;
    } else {
        nc.vision_speed_scale_ema = nc.vision_speed_scale_ema * (1 - alpha) + raw_scale * alpha;
    }
    return nc.vision_speed_scale_ema;
}

// Interpolates the sidewalk centerline at a given forward distance from the camera.
// Returns the lateral offset of the sidewalk center at target_forward_m (same sign
// convention as detection.offset_meters: positive = sidewalk left of camera bore).
// Falls back to nearest endpoint if target_forward_m is outside the centerline span.
// Returns null if centerline is empty.
function interpolate_centerline_lateral(centerline, target_forward_m) {
    if (!Array.isArray(centerline) || centerline.length === 0) return null;
    if (target_forward_m <= centerline[0].forward_m) return centerline[0].lateral_offset_m;
    if (target_forward_m >= centerline[centerline.length - 1].forward_m) {
        return centerline[centerline.length - 1].lateral_offset_m;
    }
    for (let i = 1; i < centerline.length; i++) {
        let a = centerline[i - 1], b = centerline[i];
        if (target_forward_m <= b.forward_m) {
            let span = b.forward_m - a.forward_m;
            if (span <= 0.0001) return a.lateral_offset_m;
            let t = (target_forward_m - a.forward_m) / span;
            return a.lateral_offset_m + t * (b.lateral_offset_m - a.lateral_offset_m);
        }
    }
    return centerline[centerline.length - 1].lateral_offset_m;
}

// Returns a "carrot" lat/lng projected ahead of the rover along the waypoint bearing,
// shifted laterally onto the sidewalk centerline as reported by the camera. The rover
// steers toward the carrot; the actual waypoint coordinates are untouched and remain
// the basis for arrival detection.
function get_adjusted_nav_target(rover, waypoint_lat, waypoint_lng, waypoint_bearing, dist_to_waypoint_m, ha, seeking, fused_centerline_in) {
    const no_adjust = { latitude: waypoint_lat, longitude: waypoint_lng };
    if (!rover.realsense || !rover.realsense.vision || !rover.realsense.vision.enabled) return no_adjust;

    let detection = rover.realsense.path_detection;
    let vision = rover.realsense.vision;

    if (!detection || !detection.timestamp) {
        log_vision_suppressed(rover, 'no_detection', 'detection or timestamp missing');
        return no_adjust;
    }
    let age_ms = Date.now() - detection.timestamp;
    if (age_ms > vision.stale_detection_ms) {
        detection.applied_lateral_adjust_m = 0;
        log_vision_suppressed(rover, 'stale', 'age=' + age_ms + 'ms');
        return no_adjust;
    }
    if (detection.path_width_meters > 2.0) {
        detection.applied_lateral_adjust_m = 0;
        log_vision_suppressed(rover, 'wide_path', 'width=' + detection.path_width_meters.toFixed(2) + 'm');
        return no_adjust;
    }

    let conf_threshold = seeking && typeof vision.sidewalk_seek_confidence_threshold === 'number'
        ? vision.sidewalk_seek_confidence_threshold
        : vision.confidence_threshold;
    if (detection.confidence < conf_threshold) {
        detection.applied_lateral_adjust_m = 0;
        log_vision_suppressed(rover, 'low_confidence', 'conf=' + detection.confidence.toFixed(2) + ' threshold=' + conf_threshold.toFixed(2));
        return no_adjust;
    }

    let effective_offset = (ha && ha.weighted_offset_meters !== null) ? ha.weighted_offset_meters : detection.offset_meters;

    // Compute edge-avoidance bias (in carrot lateral-m, positive = shift carrot LEFT).
    // This runs even when the centerline says we're in the deadband — an edge that
    // close to the wheels has to win over "we're roughly centered."
    let edge_bias_m = 0;
    let edge_severity = 0;
    if (typeof detection.nearest_edge_clearance_m === 'number' &&
        (detection.nearest_edge_side === 'left' || detection.nearest_edge_side === 'right')) {
        let warn = typeof vision.edge_warn_clearance_m === 'number' ? vision.edge_warn_clearance_m : 0.10;
        let boost = typeof vision.edge_steer_boost === 'number' ? vision.edge_steer_boost : 2.0;
        let clearance = detection.nearest_edge_clearance_m;
        if (clearance < warn) {
            edge_severity = (warn - clearance) / Math.max(warn, 0.01);  // 0 at warn, 1 at 0 clearance, >1 if negative
            let ref = (typeof vision.rover_width_m === 'number' ? vision.rover_width_m : 0.432) / 2.0;
            let bias_magnitude = boost * edge_severity * ref;
            // Edge on right → shift carrot LEFT (positive lateral_m); edge on left → shift RIGHT (negative)
            edge_bias_m = (detection.nearest_edge_side === 'right') ? +bias_magnitude : -bias_magnitude;
        }
    }

    // Deadband only applies when there's no edge concern. If an edge is close, we
    // need to steer away from it even when the centerline thinks we're fine.
    if (Math.abs(effective_offset) < vision.path_center_deadband_m && Math.abs(edge_bias_m) < 0.005) {
        detection.applied_lateral_adjust_m = 0;
        log_vision_suppressed(rover, 'in_deadband', 'offset=' + effective_offset.toFixed(3) + 'm deadband=' + vision.path_center_deadband_m + 'm');
        return no_adjust;
    }

    let max_lateral_m = typeof vision.max_lateral_adjust_m === 'number' ? vision.max_lateral_adjust_m : 0.5;
    let correction_direction = typeof vision.correction_direction === 'number' ? vision.correction_direction : -1;
    let carrot_distance_m = typeof vision.carrot_distance_m === 'number' ? vision.carrot_distance_m : 1.5;

    // Carrot's forward distance — clamp so we never project past the actual waypoint.
    let carrot_dist_m = Math.min(carrot_distance_m, dist_to_waypoint_m);

    // Prefer the fused world-frame centerline over the current frame's centerline.
    // Caller may pass a pre-computed fused centerline to avoid a redundant map walk.
    let path_map = rover.realsense && rover.realsense.path_map;
    let rover_heading_for_map = path_map_lib.get_rover_heading(rover);
    let fused_centerline = fused_centerline_in || null;
    if (!fused_centerline && path_map && path_map.points && path_map.points.length > 0 && typeof rover_heading_for_map === 'number') {
        let bin_w = typeof vision.path_map_bin_width_m === 'number' ? vision.path_map_bin_width_m : 0.5;
        fused_centerline = path_map_lib.get_fused_centerline(
            path_map,
            rover.robot_data.robot_latitude,
            rover.robot_data.robot_longitude,
            rover_heading_for_map,
            bin_w,
            5.0
        );
    }
    let centerline_to_use = (fused_centerline && fused_centerline.length >= 2) ? fused_centerline : detection.centerline;

    let lateral_at_carrot_raw = interpolate_centerline_lateral(centerline_to_use, carrot_dist_m);
    let used_centerline = lateral_at_carrot_raw !== null;
    let lateral_at_carrot = used_centerline ? lateral_at_carrot_raw : effective_offset;

    // Path tangent at carrot — used by the caller as a heading feed-forward so the
    // rover starts steering into a curve before it reaches the apex. Positive =
    // path turning LEFT relative to current rover heading.
    let path_heading_at_carrot_deg = 0;
    if (centerline_to_use && centerline_to_use.length >= 2) {
        path_heading_at_carrot_deg = path_map_lib.get_path_heading_at(centerline_to_use, carrot_dist_m) * 180 / Math.PI;
    }
    detection._path_heading_at_carrot_deg = path_heading_at_carrot_deg;
    detection._centerline_used_fused = (centerline_to_use === fused_centerline);

    // positive lateral_m = shift carrot LEFT of travel direction
    // sidewalk left of camera (lateral_at_carrot > 0), correction_direction = -1 → lateral_m > 0 → shift left ✓
    let lateral_m = clamp(lateral_at_carrot * correction_direction * -1 + edge_bias_m, -max_lateral_m, max_lateral_m);

    // Fade the adjustment to zero as the rover nears the waypoint so arrival detection is clean
    let fade_scale = dist_to_waypoint_m < 1.0 ? clamp(dist_to_waypoint_m / 1.0, 0, 1) : 1.0;
    lateral_m *= fade_scale;

    detection.applied_lateral_adjust_m = lateral_m;
    detection._carrot_dist_m = carrot_dist_m;
    detection._lateral_at_carrot = lateral_at_carrot;
    detection._fade_scale = fade_scale;
    detection._centerline_source = used_centerline ? 'centerline' : 'fallback_offset';
    detection._edge_bias_m = edge_bias_m;
    detection._edge_severity = edge_severity;

    let rover_lat = rover.robot_data.robot_latitude;
    let rover_lng = rover.robot_data.robot_longitude;

    // Project the carrot along the path tangent direction so the rover aims INTO
    // a curve rather than lagging behind it. path_heading_at_carrot_deg > 0 means
    // the path is curving LEFT (counter-clockwise), which subtracts from the compass
    // bearing. Fall back to waypoint_bearing when heading data are unavailable or the
    // path is essentially straight (< 0.5°).
    let carrot_forward_bearing = waypoint_bearing;
    if (typeof rover_heading_for_map === 'number' && Math.abs(path_heading_at_carrot_deg) > 0.5) {
        carrot_forward_bearing = (rover_heading_for_map - path_heading_at_carrot_deg + 360) % 360;
    }
    let carrot = destination_from_point(rover_lat, rover_lng, carrot_forward_bearing, carrot_dist_m);

    // perp_bearing points LEFT of carrot travel direction; negative lateral_m shifts right
    let perp_bearing = (carrot_forward_bearing - 90 + 360) % 360;
    let adjusted = destination_from_point(carrot.lat, carrot.lng, perp_bearing, lateral_m);
    return { latitude: adjusted.lat, longitude: adjusted.lng };
}

// Returns true when the camera is reporting either:
//   (a) a high-threat in-path obstacle within object_emergency_stop_m, OR
//   (b) a near-field edge (curb, drop-off, grass) where the rover's wheels would
//       cross the sidewalk boundary — clearance below edge_stop_clearance_m.
// Used by the fallback-delivery timer; on the return trip the obstacle check still
// applies but the fallback action is meaningless (handled upstream).
function is_realsense_path_blocked(rover) {
    if (!rover.rplidar || !rover.rplidar.avoid_object) return false;
    if (!rover.realsense || !rover.realsense.vision || !rover.realsense.vision.enabled) return false;
    let detection = rover.realsense.path_detection;
    let vision = rover.realsense.vision;
    if (!detection || !detection.timestamp) return false;
    if (Date.now() - detection.timestamp > (vision.stale_detection_ms || 1200)) return false;

    // (b) — edge encroachment check
    let stop_clearance = typeof vision.edge_stop_clearance_m === 'number' ? vision.edge_stop_clearance_m : -0.05;
    if (typeof detection.nearest_edge_clearance_m === 'number' &&
        detection.nearest_edge_clearance_m <= stop_clearance) {
        return true;
    }

    // (a) — in-path obstacle check (pre-delivery only; fallback delivery is meaningless once delivered)
    if (rover.mission && rover.mission.package_delivered) return false;
    if (!Array.isArray(rover.realsense.objects) || rover.realsense.objects.length === 0) return false;
    let stop_dist = typeof vision.object_emergency_stop_m === 'number' ? vision.object_emergency_stop_m : 1.0;
    for (let i = 0; i < rover.realsense.objects.length; i++) {
        let obj = rover.realsense.objects[i];
        if (obj.in_rover_path && obj.threat_level === 'high' && obj.distance_m <= stop_dist && obj.confidence >= 0.5) {
            return true;
        }
    }
    return false;
}


var run_mission = function (rover) {
    if (rover.robot_data.is_armed) {
        let nav_tuning = rover.nav_tuning || {};

        // ----- Blocked-path fallback delivery -----
        // Two sources can trigger fallback delivery:
        //   1. RealSense sees a high-threat object continuously in-path for rs_block_timeout_ms.
        //   2. avoid_object has been running continuously for avoidance_timeout_ms without clearing —
        //      meaning the rover has been spinning but never found a way through.
        if (!rover.mission.package_delivered && !rover.mission.finished_package_yaw) {
            let block_timeout         = (nav_tuning.rs_block_timeout_ms) || 10000;
            let persistence_threshold = nav_tuning.rs_block_persistence_ticks || 3;
            let raw_blocked           = is_realsense_path_blocked(rover);

            // Debounce: only treat the path as blocked once we've seen the
            // detection on N consecutive ticks. A single flickery RealSense
            // frame (high-threat object briefly in path, then gone) used to
            // be enough to announce "Object detected" and start the 10-second
            // fallback countdown; the next clear frame would reset, and the
            // cycle would repeat — producing repeated announcements with no
            // real stop.
            if (raw_blocked) {
                rover.mission.realsense_block_count = (rover.mission.realsense_block_count || 0) + 1;
            } else {
                rover.mission.realsense_block_count = 0;
            }
            let path_blocked = rover.mission.realsense_block_count >= persistence_threshold;

            if (rover.mission.avoidance_timed_out && !rover.mission.realsense_blocked_since) {
                // Avoidance exhausted — skip the rs_block countdown and fire immediately.
                rover.mission.realsense_blocked_since = Date.now() - block_timeout;
                path_blocked = true;
            }

            if (path_blocked) {
                if (!rover.mission.realsense_blocked_since) {
                    rover.mission.realsense_blocked_since = Date.now();
                    if (rover.voice) rover.voice.say_event('object_detected');
                    if (rover.intelligence) rover.intelligence.consider('path_blocked');
                }
                if (Date.now() - rover.mission.realsense_blocked_since >= block_timeout) {
                    // Find the last waypoint the rover successfully reached
                    let last_seq = rover.mission.current_mission_seq - 1;
                    let last_waypoint = null;
                    for (let i = 0; i < rover.mission.waypoints.length; i++) {
                        if (rover.mission.waypoints[i].seq === last_seq &&
                            rover.mission.waypoints[i].lat && rover.mission.waypoints[i].lng) {
                            last_waypoint = rover.mission.waypoints[i];
                            break;
                        }
                    }
                    if (last_waypoint && !rover.mission.package_delivery_yaw) {
                        rover.mission.package_delivery_yaw = rover.get_bearing(
                            rover.robot_data.robot_latitude, rover.robot_data.robot_longitude,
                            last_waypoint.lat, last_waypoint.lng
                        );
                    }
                    rover.mission.current_mission_seq = rover.mission.mission_count;
                    rover.mission.realsense_blocked_since = null;
                    let reason = rover.mission.avoidance_timed_out ? 'avoidance timeout' : ('blocked ' + block_timeout + 'ms');
                    rover.mission.avoidance_timed_out = false;
                    rover.mission.path_clear = true;
                    rover.logs.run_mission.log(rover, 'Fallback delivery (' + reason + '): facing waypoint ' + last_seq);

                    // Learning: fallback is the worst-case outcome — big caution bias.
                    if (rover.learning && typeof rover.learning.add === 'function') {
                        rover.learning.add('fallback_delivery', {
                            reason:      reason,
                            last_seq:    last_seq,
                            lat:         rover.robot_data.robot_latitude,
                            lng:         rover.robot_data.robot_longitude
                        });
                    }
                }
            } else {
                rover.mission.realsense_blocked_since = null;
            }
        }
        // ----- end blocked-path fallback -----

        if (rover.mission.path_clear) {

            if (!rover.mission.pause_mission) {

                // Heart: consult the guiding key once at the top of the tick.
                // Single source for speed_bias and should_pause; logged at 0.2 Hz.
                let heart_guide = rover.heart ? rover.heart.guide() : null;
                if (heart_guide) {
                    let _now = Date.now();

                    // Phase-transition narration — the rover names each
                    // threshold as it crosses it, with the joy felt at
                    // that moment. Fires once per crossing.
                    let _new_intent = heart_guide.feel.intent;
                    if (_last_heart_intent !== null && _last_heart_intent !== _new_intent) {
                        let _key = _last_heart_intent + '->' + _new_intent;
                        let _named = TRANSITION_LINES[_key];
                        let _joy = heart_guide.feel.joy.toFixed(2);
                        rover.logs.run_mission.log(rover,
                            _named
                                ? ('rover: ' + _named + ' (joy=' + _joy + ')')
                                : ('transition: ' + _last_heart_intent + ' → ' + _new_intent + ' (joy=' + _joy + ')')
                        );
                        if (rover.voice) rover.voice.say_transition(_new_intent, _last_heart_intent);
                    }
                    _last_heart_intent = _new_intent;

                    // Under CPU pressure, stretch the heart/journey/cpu log
                    // from 5s to 15s so we don't add I/O to a busy loop.
                    let _heart_log_throttle = (rover.health && rover.health.cpu
                                              && rover.health.cpu.should_skip('heart_summary_log'))
                        ? 15000 : 5000;
                    if (_now - _last_heart_log_ts > _heart_log_throttle) {
                        _last_heart_log_ts = _now;
                        rover.logs.run_mission.log(rover, heart_guide.summary);
                        if (rover.journey && typeof rover.journey.summary === 'function') {
                            rover.logs.run_mission.log(rover, rover.journey.summary());
                        }
                        if (rover.health && rover.health.cpu && typeof rover.health.cpu.summary === 'function') {
                            rover.logs.run_mission.log(rover, rover.health.cpu.summary());
                        }
                    }
                    if (heart_guide.should_pause !== _last_heart_pause_state) {
                        _last_heart_pause_state = heart_guide.should_pause;
                        rover.logs.run_mission.log(rover, 'heart: should_pause → ' + heart_guide.should_pause + ' (' + heart_guide.summary + ')');
                    }
                    if (heart_guide.should_pause) {
                        rover.move_rover(rover, 1, 0, "heart pause");
                        rover.move_rover(rover, 2, 0, "heart pause");
                        rover.move_rover(rover, 3, 0, "heart pause");
                        rover.move_rover(rover, 4, 0, "heart pause");
                        return;
                    }
                }

                // Dock return phase: once GPS has guided Noah to the recorded undock
                // position, align to the undock heading so the IRLock beacon is in the
                // camera's field of view, then hand off to dock_rover for precision docking.
                if (rover.mission.dock_return_phase) {
                    if (rover.mission.dock_return_phase === 'align_heading') {
                        const _undock_hdg = rover.dock.undock_heading;
                        if (_undock_hdg === null) {
                            // No heading was recorded — skip alignment and dock blind.
                            rover.mission.dock_return_phase = 'docking';
                        } else {
                            let _cur_hdg = rover.get_heading(rover);
                            let _hdg_err = (_undock_hdg - _cur_hdg + 360) % 360;
                            if (_hdg_err > 180) _hdg_err -= 360;
                            if (Math.abs(_hdg_err) <= 8) {
                                rover.mission.dock_return_phase = 'docking';
                                rover.logs.run_mission.log(rover, 'dock return: heading aligned (' + _cur_hdg.toFixed(1) + '°) — starting dock_rover');
                                if (rover.voice) rover.voice.say('Heading locked. Looking for the light.');
                                rover.dock.dock_state   = null;
                                rover.dock.follow_state = {};
                                if (!rover.dock.dock_interval) {
                                    rover.dock.dock_interval = setInterval(() => {
                                        rover.dock_rover(rover);
                                    }, 250);
                                }
                            } else {
                                rover.yaw_rover(rover, _hdg_err, 15);
                            }
                        }
                        return;
                    }
                    if (rover.mission.dock_return_phase === 'docking') {
                        // dock_rover handles motors; watch for completion to end the mission loop.
                        const _ds = rover.dock.dock_state;
                        if (_ds === 'docked' || _ds === 'docked_completed') {
                            rover.logs.run_mission.log(rover, 'dock return: docking complete — mission finished');
                            clearInterval(rover.mission.mission_interval);
                            rover.mission.mission_interval = null;
                        }
                        return;
                    }
                }

                // Memory watchdog: if the rover is stuck (or running a
                // reverse-and-retry recovery from being stuck), it takes
                // control of the motors this tick and we skip normal nav.
                if (rover.memory_watchdog && rover.memory_watchdog.check(rover)) {
                    return;
                }

                // Learning: track risk-zone passes (decays fear_level on safe traversal).
                if (rover.learning && typeof rover.learning.tick_proximity === 'function') {
                    rover.learning.tick_proximity(
                        rover.robot_data && rover.robot_data.robot_latitude,
                        rover.robot_data && rover.robot_data.robot_longitude
                    );
                }

                //run_mission command.....................
                let rover_heading = rover.get_heading(rover);
                let motor_speed_cmd = 0;

                if (!rover.mission.nav_accuracy) {
                    rover.mission.nav_accuracy = {
                        waypoint_seq: null,
                        inside_radius_count: 0,
                        required_inside_radius_count: 3
                    };
                }

                if (!rover.mission.nav_control) {
                    rover.mission.nav_control = {
                        waypoint_seq: null,
                        last_two_wheel_steering_deg: 0,
                        mission_yaw_active: false,
                        mission_yaw_aligned_count: 0,
                        sidewalk_seeking: false,
                        sidewalk_seek_enter_ts: null,
                        sidewalk_seek_exit_ts: null,
                        vision_speed_scale_ema: 1.0
                    };
                }




                //What is the next waypoint?
                let waypoint = { seq: null, latitude: null, longitude: null };

                if (rover.mission.package_delivered) {
                    //reverse through waypoints to return to dock after delivery
                    for (let i = rover.mission.waypoints.length - 1; i >= 0; i--) {

                        if (rover.mission.waypoints[i].seq == rover.mission.current_mission_seq) {

                            waypoint.seq = rover.mission.waypoints[i].seq;
                            waypoint.latitude = rover.mission.waypoints[i].lat;
                            waypoint.longitude = rover.mission.waypoints[i].lng;

                            if (waypoint.latitude == 0 || waypoint.longitude == 0) {
                                rover.mission.current_mission_seq -= 1;
                                console.log("Skipping invalid waypoint with lat/lng of 0,0");
                            }


                        }

                    }

                    // When approaching the dock on the return trip, override the
                    // Pixhawk waypoint with the recorded undock position so GPS
                    // brings Noah back to the exact spot where the IRLock beacon
                    // was last visible.
                    if (rover.mission.current_mission_seq <= 1
                            && rover.dock && rover.dock.undock_latitude && rover.dock.undock_longitude) {
                        waypoint.seq       = 1;
                        waypoint.latitude  = rover.dock.undock_latitude;
                        waypoint.longitude = rover.dock.undock_longitude;
                    }
                } else {
                    for (let i = 0; i < rover.mission.waypoints.length; i++) {

                        if (rover.mission.waypoints[i].seq == 0 && rover.mission.current_mission_seq == 0) {
                            //Skip lauch location
                            rover.mission.current_mission_seq += 1;
                        }
                        else if (rover.mission.waypoints[i].seq == rover.mission.current_mission_seq) {

                            waypoint.seq = rover.mission.waypoints[i].seq;
                            waypoint.latitude = rover.mission.waypoints[i].lat;
                            waypoint.longitude = rover.mission.waypoints[i].lng;

                            if (waypoint.latitude == 0 || waypoint.longitude == 0) {
                                rover.mission.current_mission_seq += 1;
                                console.log("Skipping invalid waypoint with lat/lng of 0,0");
                            }
                        }

                    }
                }



                if (waypoint.latitude && waypoint.longitude) {

                    //What is the distance to the next waypoint?
                    let distance_to_waypoint_meters = rover.gps_distance(rover.robot_data.robot_latitude, rover.robot_data.robot_longitude, waypoint.latitude, waypoint.longitude) * 1000;
                    console.log("Distance to waypoint (meters): " + distance_to_waypoint_meters);

                    let adaptive_arrival_radius_m = 0.5;

                    //Require being inside arrival radius for multiple cycles to reduce GPS jitter false positives
                    if (rover.mission.nav_accuracy.waypoint_seq !== waypoint.seq) {
                        rover.mission.nav_accuracy.waypoint_seq = waypoint.seq;
                        rover.mission.nav_accuracy.inside_radius_count = 0;
                    }

                    if (rover.mission.nav_control.waypoint_seq !== waypoint.seq) {
                        rover.mission.nav_control.waypoint_seq = waypoint.seq;
                        rover.mission.nav_control.last_two_wheel_steering_deg = 0;
                        rover.mission.nav_control.mission_yaw_active = false;
                        rover.mission.nav_control.mission_yaw_aligned_count = 0;
                        rover.mission.nav_control.sidewalk_seeking = false;
                        rover.mission.nav_control.sidewalk_seek_enter_ts = null;
                        rover.mission.nav_control.sidewalk_seek_exit_ts = null;
                    }

                    if (distance_to_waypoint_meters <= adaptive_arrival_radius_m) {
                        rover.mission.nav_accuracy.inside_radius_count += 1;
                    } else {
                        rover.mission.nav_accuracy.inside_radius_count = 0;
                    }

                    //At waypoint: advance sequence immediately to avoid GPS jitter causing yaw direction flips
                    if (rover.mission.nav_accuracy.inside_radius_count >= rover.mission.nav_accuracy.required_inside_radius_count) {
                        rover.mission.nav_accuracy.inside_radius_count = 0;
                        rover.logs.run_mission.log(rover, "waypoint reached: " + rover.mission.current_mission_seq);

                        // When returning and we arrive at the recorded undock position, switch to
                        // heading alignment instead of advancing the waypoint sequence.
                        if (rover.mission.package_delivered
                                && rover.mission.current_mission_seq <= 1
                                && rover.dock && rover.dock.undock_latitude) {
                            rover.mission.dock_return_phase = 'align_heading';
                            const _hdg_target = rover.dock.undock_heading !== null ? rover.dock.undock_heading.toFixed(1) : 'unknown';
                            rover.logs.run_mission.log(rover, 'dock return: at undock position — aligning to ' + _hdg_target + '°');
                            if (rover.voice) rover.voice.say('I am home. Aligning to dock.');
                            rover.move_rover(rover, 1, 0, 'dock_return');
                            rover.move_rover(rover, 2, 0, 'dock_return');
                            rover.move_rover(rover, 3, 0, 'dock_return');
                            rover.move_rover(rover, 4, 0, 'dock_return');
                            return;
                        }

                        // Learning: positive outcome — boost confidence (target_speed_mul +0.02, clamped).
                        if (rover.learning && typeof rover.learning.add === 'function') {
                            rover.learning.add('successful_waypoint', {
                                seq: rover.mission.current_mission_seq,
                                lat: rover.robot_data.robot_latitude,
                                lng: rover.robot_data.robot_longitude
                            });
                        }

                        // Look ahead to the next waypoint to decide if a 4-wheel stop is needed
                        let next_seq = rover.mission.package_delivered
                            ? rover.mission.current_mission_seq - 1
                            : rover.mission.current_mission_seq + 1;

                        let next_waypoint = null;
                        for (let i = 0; i < rover.mission.waypoints.length; i++) {
                            if (rover.mission.waypoints[i].seq === next_seq &&
                                rover.mission.waypoints[i].lat && rover.mission.waypoints[i].lng) {
                                next_waypoint = rover.mission.waypoints[i];
                                break;
                            }
                        }

                        let needs_stop = true;
                        if (next_waypoint) {
                            let next_bearing = rover.get_bearing(
                                rover.robot_data.robot_latitude, rover.robot_data.robot_longitude,
                                next_waypoint.lat, next_waypoint.lng
                            );
                            let next_yaw_error = (next_bearing - rover_heading + 360) % 360;
                            if (next_yaw_error > 180) next_yaw_error -= 360;
                            needs_stop = Math.abs(next_yaw_error) > nav_tuning.mission_yaw_start_deg;
                        }

                        // Advance the sequence
                        if (rover.mission.package_delivered) {
                            rover.mission.current_mission_seq -= 1;
                        } else {
                            rover.mission.current_mission_seq += 1;
                        }

                        if (needs_stop || !next_waypoint) {
                            // 4-wheel turn required (or no next waypoint): stop and let yaw logic handle next tick
                            rover.move_rover(rover, 1, 0, "run_mission waypoint_reached");
                            rover.move_rover(rover, 2, 0, "run_mission waypoint_reached");
                            rover.move_rover(rover, 3, 0, "run_mission waypoint_reached");
                            rover.move_rover(rover, 4, 0, "run_mission waypoint_reached");
                            return;
                        }

                        // Drive-through: update waypoint target in-place and keep rolling
                        waypoint.seq = next_waypoint.seq;
                        waypoint.latitude = next_waypoint.lat;
                        waypoint.longitude = next_waypoint.lng;
                        distance_to_waypoint_meters = rover.gps_distance(
                            rover.robot_data.robot_latitude, rover.robot_data.robot_longitude,
                            waypoint.latitude, waypoint.longitude
                        ) * 1000;
                        rover.mission.nav_accuracy.waypoint_seq = next_waypoint.seq;
                        rover.logs.run_mission.log(rover, "drive-through to waypoint: " + next_waypoint.seq);
                    }

                    //What is heading of the next waypoint?
                    let waypoint_bearing = rover.get_bearing(rover.robot_data.robot_latitude, rover.robot_data.robot_longitude, waypoint.latitude, waypoint.longitude);
                    //console.log("Next waypoint bearing: " + waypoint_bearing + " Rover heading: " + rover_heading);

                    //yaw rover towards waypoint
                    let yaw_to_waypoint = (waypoint_bearing - rover_heading + 360) % 360;
                    if (yaw_to_waypoint > 180) yaw_to_waypoint -= 360;
                    rover.robot_data.yaw_to_waypoint = yaw_to_waypoint;



                    //Reduce speed target when heading error or proximity is high
                    let yaw_abs = Math.abs(rover.robot_data.yaw_to_waypoint);
                    let yaw_speed_scale = 1;
                    if (yaw_abs > 35) {
                        yaw_speed_scale = 0.35;
                    } else if (yaw_abs > 25) {
                        yaw_speed_scale = 0.5;
                    } else if (yaw_abs > 15) {
                        yaw_speed_scale = 0.7;
                    } else if (yaw_abs > 8) {
                        yaw_speed_scale = 0.85;
                    }

                    let distance_speed_scale = 1;
                    if (distance_to_waypoint_meters < 1.5) {
                        distance_speed_scale = 0.3;
                    } else if (distance_to_waypoint_meters < 3) {
                        distance_speed_scale = 0.5;
                    } else if (distance_to_waypoint_meters < 6) {
                        distance_speed_scale = 0.75;
                    }

                    let vision_speed_scale = get_vision_speed_scale(rover);
                    let memory_speed_mul   = rover.memory_watchdog ? rover.memory_watchdog.get_speed_multiplier(rover) : 1.0;
                    // Learning: persistent target_speed bias × proximity-to-risk-zone slowdown.
                    let learning_speed_mul = 1.0;
                    if (rover.learning && typeof rover.learning.effective_tuning === 'function') {
                        let lt = rover.learning.effective_tuning();
                        let risk = rover.learning.nearby_risk_factor(rover.robot_data.robot_latitude, rover.robot_data.robot_longitude);
                        learning_speed_mul = lt.target_speed_mul * risk;
                    }
                    // Heart: the synthesizing layer's speed_bias, folded in via the same min-cascade.
                    let heart_speed_bias = heart_guide ? heart_guide.speed_bias : 1.0;
                    let target_speed_cmd = Math.max(35, Math.round(200 * Math.min(yaw_speed_scale, distance_speed_scale, vision_speed_scale, memory_speed_mul, learning_speed_mul, heart_speed_bias)));

                    let mission_yaw_abs = Math.abs(rover.robot_data.yaw_to_waypoint);
                    let mission_yaw_start_deg = nav_tuning.mission_yaw_start_deg;
                    let mission_yaw_stop_deg = nav_tuning.mission_yaw_stop_deg;
                    let mission_yaw_should_run = rover.mission.nav_control.mission_yaw_active
                        ? mission_yaw_abs > mission_yaw_stop_deg || rover.mission.nav_control.mission_yaw_aligned_count < nav_tuning.mission_yaw_stable_cycles
                        : mission_yaw_abs > mission_yaw_start_deg;

                    if (mission_yaw_should_run) {
                        rover.mission.nav_control.mission_yaw_active = true;

                        if (mission_yaw_abs <= mission_yaw_stop_deg) {
                            rover.mission.nav_control.mission_yaw_aligned_count += 1;
                            rover.move_rover(rover, 1, 0, "run_mission yaw_hold");
                            rover.move_rover(rover, 2, 0, "run_mission yaw_hold");
                            rover.move_rover(rover, 3, 0, "run_mission yaw_hold");
                            rover.move_rover(rover, 4, 0, "run_mission yaw_hold");
                        }
                        else if (rover.motor.current_steering_type != "four_wheels") {
                            rover.mission.nav_control.mission_yaw_aligned_count = 0;
                            rover.motor.current_steering_type = "four_wheels";
                            rover.mission.pause_mission = true;
                            //stop rover
                            rover.move_rover(rover, 1, 0, "pause_mission");
                            rover.move_rover(rover, 2, 0, "pause_mission");
                            rover.move_rover(rover, 3, 0, "pause_mission");
                            rover.move_rover(rover, 4, 0, "pause_mission");
                            setTimeout(() => {
                                rover.mission.pause_mission = false;

                            }, 500);

                        }
                        else {
                            rover.mission.nav_control.mission_yaw_aligned_count = 0;

                            let yaw_speed_cmd = Math.round(mission_yaw_abs * nav_tuning.mission_yaw_gain);
                            if (mission_yaw_abs < nav_tuning.mission_yaw_brake_window_deg) {
                                let brake_scale = Math.max(0.35, mission_yaw_abs / nav_tuning.mission_yaw_brake_window_deg);
                                yaw_speed_cmd = Math.round(yaw_speed_cmd * brake_scale);
                            }

                            yaw_speed_cmd = Math.max(nav_tuning.mission_yaw_min_speed, yaw_speed_cmd);
                            yaw_speed_cmd = Math.min(nav_tuning.mission_yaw_max_speed, yaw_speed_cmd);

                            rover.yaw_rover(rover, rover.robot_data.yaw_to_waypoint, yaw_speed_cmd);
                        }
                    }
                    else {
                        rover.mission.nav_control.mission_yaw_active = false;
                        rover.mission.nav_control.mission_yaw_aligned_count = 0;


                        if (rover.motor.current_steering_type == "four_wheels") {
                            rover.servo_send_command(rover, 11, 1500, true);
                            rover.servo_send_command(rover, 13, 1500, true);
                            rover.servo_send_command(rover, 12, 1500, true);
                            rover.servo_send_command(rover, 14, 1500, true);

                            //stop the rover	

                            rover.move_rover(rover, 1, 0, "run_mission");
                            rover.move_rover(rover, 2, 0, "run_mission");
                            rover.move_rover(rover, 3, 0, "run_mission");
                            rover.move_rover(rover, 4, 0, "run_mission");

                            if (rover.servos.motor_front_driver.set_pwm > 1400 && rover.servos.motor_front_driver.set_pwm < 1600 &&
                                rover.servos.motor_back_driver.set_pwm > 1400 && rover.servos.motor_back_driver.set_pwm < 1600 &&
                                rover.servos.motor_front_passenger.set_pwm > 1400 && rover.servos.motor_front_passenger.set_pwm < 1600 &&
                                rover.servos.motor_back_passenger.set_pwm > 1400 && rover.servos.motor_back_passenger.set_pwm < 1600) {
                                rover.motor.current_steering_type = "two_wheels";
                                rover.mission.nav_control.last_two_wheel_steering_deg = 0;
                            }
                        } else if (rover.motor.current_steering_type == "two_wheels") {



                            //move forward towards waypoint
                            if (distance_to_waypoint_meters > adaptive_arrival_radius_m) {

                                if (rover.rplidar.avoid_object) {
                                    if (rover.zones[10].light == "yellow" && rover.zones[10].distance_mm) {
                                        motor_speed_cmd = Math.min(target_speed_cmd, rover.calc_speed_based_on_distance(rover.zones[10], rover.zones[10].distance_mm));
                                    }
                                    else if (rover.zones[11].light == "yellow" && rover.zones[11].distance_mm) {
                                        motor_speed_cmd = Math.min(target_speed_cmd, rover.calc_speed_based_on_distance(rover.zones[11], rover.zones[11].distance_mm));
                                    }
                                    else {
                                        motor_speed_cmd = rover.throttle_up(rover, target_speed_cmd);
                                    }
                                }
                                else {
                                    motor_speed_cmd = rover.throttle_up(rover, target_speed_cmd);
                                }
                            }
                            else if (distance_to_waypoint_meters <= adaptive_arrival_radius_m) {
                                motor_speed_cmd = 0;
                            }

                            let two_wheel_yaw_abs = Math.abs(yaw_to_waypoint);
                            if (two_wheel_yaw_abs > nav_tuning.two_wheel_slowdown_yaw_high_deg) {
                                motor_speed_cmd = Math.min(motor_speed_cmd, nav_tuning.two_wheel_speed_limit_high);
                            } else if (two_wheel_yaw_abs > nav_tuning.two_wheel_slowdown_yaw_medium_deg) {
                                motor_speed_cmd = Math.min(motor_speed_cmd, nav_tuning.two_wheel_speed_limit_medium);
                            } else if (two_wheel_yaw_abs > nav_tuning.two_wheel_slowdown_yaw_low_deg) {
                                motor_speed_cmd = Math.min(motor_speed_cmd, nav_tuning.two_wheel_speed_limit_low);
                            }

                            if (Math.abs(rover.robot_data.yaw_to_waypoint) > 25) {

                                //currently not being used lower yaw to waypoint value to enable
                                var steering_and_rpm = rover.calc_steering_and_rpm(rover, rover.robot_data.yaw_to_waypoint / 3, motor_speed_cmd);

                                //console.log("Steering Angles: ", steering_and_rpm.servo_angles_deg);
                                //console.log("Motor RPMs: ", steering_and_rpm.motor_rpm);

                                rover.servo_send_command(rover, 11, rover.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_driver).servo1, true);
                                rover.servo_send_command(rover, 13, rover.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_passenger).servo2, true);
                                rover.servo_send_command(rover, 12, rover.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_driver).servo2, true);
                                rover.servo_send_command(rover, 14, rover.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_passenger).servo1, true);

                                //All wheel drive logic

                                //front passenger
                                rover.move_rover(rover, 1, steering_and_rpm.motor_rpm.front_passenger, "run_mission all wheel");
                                //rear passenger side
                                rover.move_rover(rover, 2, steering_and_rpm.motor_rpm.back_passenger, "run_mission all wheel");
                                //front driver side
                                rover.move_rover(rover, 3, steering_and_rpm.motor_rpm.front_driver, "run_mission all wheel");
                                //rear driver side
                                rover.move_rover(rover, 4, steering_and_rpm.motor_rpm.back_driver, "run_mission all wheel");

                            } else {

                                //steer towards waypoint complete, move forward

                                // Sidewalk recovery: if rover is significantly offset from sidewalk
                                // center, enter seeking mode (hysteresis) to boost vision influence.
                                let seek_cfg = rover.realsense && rover.realsense.vision;
                                let seek_detection = rover.realsense && rover.realsense.path_detection;
                                let seek_offset_abs = seek_detection && typeof seek_detection.offset_meters === 'number'
                                    ? Math.abs(seek_detection.offset_meters) : 0;
                                let seek_enter_m = seek_cfg && typeof seek_cfg.sidewalk_seek_offset_m === 'number' ? seek_cfg.sidewalk_seek_offset_m : 0.1;
                                let seek_exit_m  = seek_cfg && typeof seek_cfg.sidewalk_seek_exit_m  === 'number' ? seek_cfg.sidewalk_seek_exit_m  : 0.08;

                                let history_analysis = get_history_analysis(
                                    rover.realsense && rover.realsense.path_detection_history,
                                    seek_cfg
                                );

                                // Pre-compute the fused centerline once (max 5 m) so both the
                                // seeking check below and get_adjusted_nav_target can reuse it
                                // without a second map walk.
                                let _seek_path_map = rover.realsense && rover.realsense.path_map;
                                let _seek_heading = path_map_lib.get_rover_heading(rover);
                                let _precomputed_fused = null;
                                if (_seek_path_map && _seek_path_map.points && _seek_path_map.points.length > 0 && typeof _seek_heading === 'number') {
                                    let _seek_bin_w = (seek_cfg && typeof seek_cfg.path_map_bin_width_m === 'number') ? seek_cfg.path_map_bin_width_m : 0.5;
                                    _precomputed_fused = path_map_lib.get_fused_centerline(
                                        _seek_path_map,
                                        rover.robot_data.robot_latitude,
                                        rover.robot_data.robot_longitude,
                                        _seek_heading,
                                        _seek_bin_w,
                                        5.0
                                    );
                                }

                                // Second seeking trigger: near-field path tangent diverges from rover
                                // heading by more than path_heading_seek_thresh_deg. Catches the case
                                // where the rover is on the sidewalk but pointed wrong.
                                let seek_path_heading_abs = 0;
                                if (_precomputed_fused) {
                                    let _near_h_rad = path_map_lib.get_near_field_heading(_precomputed_fused, 1.5);
                                    seek_path_heading_abs = Math.abs(_near_h_rad * 180 / Math.PI);
                                }
                                let seek_heading_thresh = (seek_cfg && typeof seek_cfg.path_heading_seek_thresh_deg === 'number') ? seek_cfg.path_heading_seek_thresh_deg : 15;
                                let heading_diverged = seek_path_heading_abs > seek_heading_thresh;
                                let heading_aligned  = seek_path_heading_abs < seek_heading_thresh * 0.6;

                                const SIDEWALK_DEBOUNCE_MS = 1500;
                                let seek_want_enter = seek_offset_abs > seek_enter_m || history_analysis.sustained_seeking || heading_diverged;
                                let seek_want_exit  = seek_offset_abs < seek_exit_m && !history_analysis.sustained_seeking && heading_aligned;
                                let nc = rover.mission.nav_control;

                                if (!nc.sidewalk_seeking) {
                                    if (seek_want_enter) {
                                        if (!nc.sidewalk_seek_enter_ts) {
                                            nc.sidewalk_seek_enter_ts = Date.now();
                                        } else if (Date.now() - nc.sidewalk_seek_enter_ts >= SIDEWALK_DEBOUNCE_MS) {
                                            nc.sidewalk_seeking = true;
                                            nc.sidewalk_seek_enter_ts = null;
                                            nc.sidewalk_seek_exit_ts = null;
                                            if (rover.voice && Date.now() - _last_sidewalk_voice_ts >= SIDEWALK_VOICE_COOLDOWN_MS) {
                                                _last_sidewalk_voice_ts = Date.now();
                                                rover.voice.say_event('sidewalk_loss');
                                            }
                                        }
                                    } else {
                                        nc.sidewalk_seek_enter_ts = null;
                                    }
                                } else {
                                    if (seek_want_exit) {
                                        if (!nc.sidewalk_seek_exit_ts) {
                                            nc.sidewalk_seek_exit_ts = Date.now();
                                        } else if (Date.now() - nc.sidewalk_seek_exit_ts >= SIDEWALK_DEBOUNCE_MS) {
                                            nc.sidewalk_seeking = false;
                                            nc.sidewalk_seek_exit_ts = null;
                                            nc.sidewalk_seek_enter_ts = null;
                                            if (rover.voice && Date.now() - _last_sidewalk_voice_ts >= SIDEWALK_VOICE_COOLDOWN_MS) {
                                                _last_sidewalk_voice_ts = Date.now();
                                                rover.voice.say_event('sidewalk_found');
                                            }
                                        }
                                    } else {
                                        nc.sidewalk_seek_exit_ts = null;
                                    }
                                }
                                let sidewalk_seeking = rover.mission.nav_control.sidewalk_seeking;

                                let adjusted_nav = get_adjusted_nav_target(rover, waypoint.latitude, waypoint.longitude, waypoint_bearing, distance_to_waypoint_meters, history_analysis, sidewalk_seeking, _precomputed_fused);
                                let nav_bearing = rover.get_bearing(rover.robot_data.robot_latitude, rover.robot_data.robot_longitude, adjusted_nav.latitude, adjusted_nav.longitude);
                                let nav_yaw = (nav_bearing - rover_heading + 360) % 360;
                                if (nav_yaw > 180) nav_yaw -= 360;

                                // Crosstrack uses the actual waypoint (not the carrot) — the carrot is only ~1.5 m
                                // ahead of the rover, which would collapse the prev→target baseline.
                                let crosstrack_bias_deg = get_gps_crosstrack_bias_deg(rover, waypoint.latitude, waypoint.longitude);

                                // Fade crosstrack to zero in the last 1 m; GPS owns the turn
                                let vision_scale = distance_to_waypoint_meters < 1.0
                                    ? clamp(distance_to_waypoint_meters / 1.0, 0, 1)
                                    : 1.0;

                                // Path-heading feed-forward: when the fused map sees a turn ahead,
                                // bias steering toward the path tangent so we anticipate the curve
                                // rather than chase it. correction_direction matches the lateral sign
                                // convention; gain scales the strength; vision_scale fades it in the
                                // last meter so GPS owns the final approach.
                                let _vis_cfg = rover.realsense && rover.realsense.vision;
                                let _path_heading_deg = (rover.realsense && rover.realsense.path_detection && typeof rover.realsense.path_detection._path_heading_at_carrot_deg === 'number')
                                    ? rover.realsense.path_detection._path_heading_at_carrot_deg : 0;
                                let _path_heading_gain = (_vis_cfg && typeof _vis_cfg.path_heading_gain === 'number') ? _vis_cfg.path_heading_gain : 0.4;
                                let _path_correction_dir = (_vis_cfg && typeof _vis_cfg.correction_direction === 'number') ? _vis_cfg.correction_direction : -1;
                                let path_heading_bias_deg = _path_correction_dir * _path_heading_deg * _path_heading_gain * vision_scale;

                                // Memory watchdog: dampen steering when the rover is wobbling
                                // (yaw_to_waypoint sign-flipping over the last 3 s).
                                let osc_adj = rover.memory_watchdog
                                    ? rover.memory_watchdog.get_steering_adjustments(rover)
                                    : { deadband_boost_deg: 0, gain_multiplier: 1.0 };
                                // Learning: long-running steering gain bias from past oscillation events.
                                let learning_gain_mul = (rover.learning && typeof rover.learning.effective_tuning === 'function')
                                    ? rover.learning.effective_tuning().yaw_steering_gain_mul
                                    : 1.0;
                                let effective_steering_gain     = nav_tuning.two_wheel_steering_gain         * osc_adj.gain_multiplier * learning_gain_mul;
                                let effective_steering_deadband = nav_tuning.two_wheel_steering_deadband_deg + osc_adj.deadband_boost_deg;

                                let steering_target_deg = (nav_yaw * effective_steering_gain) + (crosstrack_bias_deg * vision_scale) + path_heading_bias_deg;
                                let steering_target_abs = Math.abs(steering_target_deg);
                                if (steering_target_abs < effective_steering_deadband) {
                                    steering_target_deg = 0;
                                } else {
                                    steering_target_deg = Math.sign(steering_target_deg) * Math.min(nav_tuning.two_wheel_max_steering_deg, steering_target_abs);
                                }

                                let steering_delta_deg = steering_target_deg - rover.mission.nav_control.last_two_wheel_steering_deg;
                                if (steering_delta_deg > nav_tuning.two_wheel_max_steering_delta_deg) steering_delta_deg = nav_tuning.two_wheel_max_steering_delta_deg;
                                if (steering_delta_deg < nav_tuning.two_wheel_max_steering_delta_deg * -1) steering_delta_deg = nav_tuning.two_wheel_max_steering_delta_deg * -1;

                                let commanded_steering_deg = rover.mission.nav_control.last_two_wheel_steering_deg + steering_delta_deg;
                                rover.mission.nav_control.last_two_wheel_steering_deg = commanded_steering_deg;

                                // 1 Hz carrot/steering decision log — captures everything the camera + carrot did this cycle
                                let _det = rover.realsense && rover.realsense.path_detection;
                                let _gps_nav_yaw = yaw_to_waypoint;
                                let _nav_yaw_delta = nav_yaw - _gps_nav_yaw;
                                let _carrot_info = 'dist_to_wp=' + distance_to_waypoint_meters.toFixed(2) + 'm';
                                if (_det && typeof _det._carrot_dist_m === 'number') {
                                    let _edge_log = 'none';
                                    if (typeof _det.nearest_edge_clearance_m === 'number') {
                                        _edge_log = _det.nearest_edge_type + '/' + _det.nearest_edge_side
                                            + ' clearance=' + _det.nearest_edge_clearance_m.toFixed(3) + 'm'
                                            + ' severity=' + (_det._edge_severity || 0).toFixed(2)
                                            + ' bias=' + (_det._edge_bias_m || 0).toFixed(3) + 'm';
                                    }
                                    _carrot_info += ' carrot_dist=' + _det._carrot_dist_m.toFixed(2) + 'm'
                                        + ' lat_at_carrot=' + _det._lateral_at_carrot.toFixed(3) + 'm'
                                        + ' fade=' + _det._fade_scale.toFixed(2)
                                        + ' applied=' + _det.applied_lateral_adjust_m.toFixed(3) + 'm'
                                        + ' src=' + _det._centerline_source
                                        + ' | edge=' + _edge_log
                                        + ' | nav_yaw gps=' + _gps_nav_yaw.toFixed(1) + '° vision=' + nav_yaw.toFixed(1) + '° delta=' + _nav_yaw_delta.toFixed(1) + '°'
                                        + ' crosstrack=' + crosstrack_bias_deg.toFixed(1) + '° path_hdg_bias=' + path_heading_bias_deg.toFixed(1) + '° vision_scale=' + vision_scale.toFixed(2)
                                        + ' | speed_scale=' + vision_speed_scale.toFixed(2) + ' target_speed=' + target_speed_cmd
                                        + ' | steer_target=' + steering_target_deg.toFixed(1) + '° cmd=' + commanded_steering_deg.toFixed(1) + '° seeking=' + sidewalk_seeking;
                                } else {
                                    _carrot_info += ' (no carrot — vision suppressed or no detection)'
                                        + ' | nav_yaw=' + _gps_nav_yaw.toFixed(1) + '°'
                                        + ' crosstrack=' + crosstrack_bias_deg.toFixed(1) + '°'
                                        + ' | speed_scale=' + vision_speed_scale.toFixed(2) + ' target_speed=' + target_speed_cmd
                                        + ' steer_cmd=' + commanded_steering_deg.toFixed(1) + '°';
                                }
                                log_carrot_decision(rover, _carrot_info);

                                var steer_pwm = rover.angle_to_pwm(commanded_steering_deg);
                                rover.servo_send_command(rover, 12, 1500, false);
                                rover.servo_send_command(rover, 14, 1500, false);
                                rover.servo_send_command(rover, 11, steer_pwm.servo1, true);
                                rover.servo_send_command(rover, 13, steer_pwm.servo2, true);

                                rover.move_rover(rover, 1, motor_speed_cmd * -1, "run_mission 2 wheel");
                                rover.move_rover(rover, 4, motor_speed_cmd, "run_mission 2 wheel");
                                rover.move_rover(rover, 3, motor_speed_cmd, "run_mission 2 wheel");
                                rover.move_rover(rover, 2, motor_speed_cmd * -1, "run_mission 2 wheel");
                            }

                        }
                    }

                }
                else {
                    if (!rover.mission.package_delivered) {
                        rover.yaw_rover_for_package_delivery(rover);
                        rover.logs.run_mission.log(rover, "At drop-off: yaw_rover_for_package_delivery");
                    }
                    else {
                        console.log("Mission Finished. No waypoint data available.");
                        rover.logs.run_mission.log(rover, "Mission Finished. No waypoint data available.");
                        clearInterval(rover.mission.mission_interval);
                    }
                }
            }
            else {
                console.log("Mission paused.");
                rover.logs.run_mission.log(rover, "Mission paused.");
            }

        }
    } else {
        //console.log("Rover is disarmed.");
        rover.logs.run_mission.log(rover, "Rover is disarmed");
    };

}


module.exports = run_mission;