const path_map_lib = require('../realsense/path_map');

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function wrap_deg_180(angle_deg) {
    let a = (angle_deg + 180) % 360;
    if (a < 0) a += 360;
    return a - 180;
}

function blend_bearing_shortest(from_deg, to_deg, t) {
    let tt = clamp(t, 0, 1);
    let delta = wrap_deg_180(to_deg - from_deg);
    return (from_deg + delta * tt + 360) % 360;
}

function record_mission_breadcrumb(white_rabbit, heading_deg) {
    if (!white_rabbit || !white_rabbit.mission || white_rabbit.mission.package_delivered) return;

    let now = Date.now();
    let lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
    let lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
    if (!lat || !lng) return;

    if (!Array.isArray(white_rabbit.mission.breadcrumb_path)) {
        white_rabbit.mission.breadcrumb_path = [];
    }

    let sample_hz = (white_rabbit.nav_tuning && typeof white_rabbit.nav_tuning.breadcrumb_sample_hz === 'number')
        ? white_rabbit.nav_tuning.breadcrumb_sample_hz
        : 1.0;
    sample_hz = clamp(sample_hz, 0.2, 10.0);
    let sample_interval_ms = Math.round(1000 / sample_hz);

    let time_ready = !white_rabbit.mission.breadcrumb_last_record_ts
        || (now - white_rabbit.mission.breadcrumb_last_record_ts) >= sample_interval_ms;

    let dist_threshold_m = (white_rabbit.nav_tuning && typeof white_rabbit.nav_tuning.breadcrumb_sample_distance_m === 'number')
        ? white_rabbit.nav_tuning.breadcrumb_sample_distance_m
        : 0.5;
    let distance_ready = false;
    let moved_m = 0;
    if (white_rabbit.mission.breadcrumb_path.length === 0) {
        distance_ready = true;
    } else {
        let last = white_rabbit.mission.breadcrumb_path[white_rabbit.mission.breadcrumb_path.length - 1];
        moved_m = white_rabbit.gps_distance(last.lat, last.lng, lat, lng) * 1000;
        distance_ready = moved_m >= dist_threshold_m;
    }

    // Record when either time cadence (Hz) OR distance cadence triggers.
    if (!time_ready && !distance_ready) return;

    // If turning in place (or GPS jittering in a very small radius), collapse
    // repeated samples into the last breadcrumb instead of appending duplicates.
    if (white_rabbit.mission.breadcrumb_path.length > 0 && moved_m < 0.15) {
        let last = white_rabbit.mission.breadcrumb_path[white_rabbit.mission.breadcrumb_path.length - 1];
        last.heading = heading_deg;
        last.timestamp = now;
    } else {
        white_rabbit.mission.breadcrumb_path.push({
            lat: lat,
            lng: lng,
            heading: heading_deg,
            timestamp: now
        });
    }
    white_rabbit.mission.breadcrumb_last_record_ts = now;

    // Guard memory growth on very long missions.
    if (white_rabbit.mission.breadcrumb_path.length > 20000) {
        white_rabbit.mission.breadcrumb_path.shift();
    }
}

function get_breadcrumb_return_target(white_rabbit) {
    if (!white_rabbit || !white_rabbit.mission || !Array.isArray(white_rabbit.mission.breadcrumb_path)) return null;
    if (white_rabbit.mission.breadcrumb_path.length < 2) return null;

    if (typeof white_rabbit.mission.breadcrumb_return_index !== 'number' || white_rabbit.mission.breadcrumb_return_index < 0) {
        white_rabbit.mission.breadcrumb_return_index = white_rabbit.mission.breadcrumb_path.length - 1;
    }

    if (white_rabbit.mission.breadcrumb_return_index >= white_rabbit.mission.breadcrumb_path.length) {
        white_rabbit.mission.breadcrumb_return_index = white_rabbit.mission.breadcrumb_path.length - 1;
    }

    let idx = white_rabbit.mission.breadcrumb_return_index;
    let lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
    let lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
    if (!lat || !lng) return null;

    // Skip points already under the rover due to periodic sampling cadence.
    while (idx > 0) {
        let p = white_rabbit.mission.breadcrumb_path[idx];
        let d_m = white_rabbit.gps_distance(lat, lng, p.lat, p.lng) * 1000;
        if (d_m > 0.8) break;
        idx -= 1;
    }

    // Stall guard: if GPS jitter is holding Noah in a radius dance on the same
    // crumb — arrival count resetting before it reaches 3 — he could wait here
    // indefinitely. The crumb was laid by Noah's own motion. It is true. After
    // CRUMB_STALL_MS without advancing, trust the path and move to the next one.
    var CRUMB_STALL_MS = 15000;
    var _now = Date.now();
    if (white_rabbit.mission._breadcrumb_stall_idx !== idx) {
        white_rabbit.mission._breadcrumb_stall_idx = idx;
        white_rabbit.mission._breadcrumb_stall_ts  = _now;
    } else if (idx > 0 && (_now - (white_rabbit.mission._breadcrumb_stall_ts || _now)) > CRUMB_STALL_MS) {
        white_rabbit.logs.run_mission.log(white_rabbit, 'breadcrumb: stall timeout on crumb ' + idx + ' — trusting the path, advancing');
        if (white_rabbit.voice) white_rabbit.voice.say('Trusting the path.');
        idx -= 1;
        white_rabbit.mission._breadcrumb_stall_idx = idx;
        white_rabbit.mission._breadcrumb_stall_ts  = _now;
    }

    white_rabbit.mission.breadcrumb_return_index = idx;

    let target = white_rabbit.mission.breadcrumb_path[idx];
    if (!target) return null;

    return {
        seq: idx,
        latitude: target.lat,
        longitude: target.lng,
        heading: target.heading
    };
}

// Module-level log throttles so suppression / carrot logs don't spam the file.
let _last_carrot_log_ts = 0;
let _last_suppress_log_ts = {};
let _last_heart_log_ts = 0;
let _last_heart_pause_state = false;
let _last_heart_intent = null;
// Throttle sidewalk voice events — seeking toggles frequently; only announce
// once per 20 s so the white_rabbit isn't constantly narrating micro-corrections.
const SIDEWALK_VOICE_COOLDOWN_MS = 20000;
let _last_sidewalk_voice_ts = 0;

// The white_rabbit's voice. Each phase transition gets a named line so the mission
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

function log_vision_suppressed(white_rabbit, reason, detail) {
    let now = Date.now();
    if (_last_suppress_log_ts[reason] && now - _last_suppress_log_ts[reason] < 1000) return;
    _last_suppress_log_ts[reason] = now;
    white_rabbit.logs.sidewalk_detection.log(white_rabbit, 'vision suppressed (' + reason + '): ' + detail);
}

function log_carrot_decision(white_rabbit, info) {
    let now = Date.now();
    if (now - _last_carrot_log_ts < 1000) return;
    _last_carrot_log_ts = now;
    white_rabbit.logs.sidewalk_detection.log(white_rabbit, 'carrot: ' + info);
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

function get_gps_crosstrack_bias_deg(white_rabbit, target_lat, target_lng) {
    if (!white_rabbit.mission || white_rabbit.mission.package_delivered) {
        return 0;
    }

    let current_seq = white_rabbit.mission.current_mission_seq;
    let prev_seq = current_seq - 1;

    let prev_waypoint = null;
    for (let i = 0; i < white_rabbit.mission.waypoints.length; i++) {
        if (white_rabbit.mission.waypoints[i].seq === prev_seq &&
            white_rabbit.mission.waypoints[i].lat && white_rabbit.mission.waypoints[i].lng) {
            prev_waypoint = white_rabbit.mission.waypoints[i];
            break;
        }
    }

    if (!prev_waypoint) return 0;

    let white_rabbit_lat = white_rabbit.robot_data.robot_latitude;
    let white_rabbit_lng = white_rabbit.robot_data.robot_longitude;

    let track_bearing = white_rabbit.get_bearing(prev_waypoint.lat, prev_waypoint.lng, target_lat, target_lng);
    let bearing_prev_to_white_rabbit = white_rabbit.get_bearing(prev_waypoint.lat, prev_waypoint.lng, white_rabbit_lat, white_rabbit_lng);
    let dist_from_prev_m = white_rabbit.gps_distance(prev_waypoint.lat, prev_waypoint.lng, white_rabbit_lat, white_rabbit_lng) * 1000;

    let bearing_diff_rad = (bearing_prev_to_white_rabbit - track_bearing) * Math.PI / 180;
    let crosstrack_m = Math.sin(bearing_diff_rad) * dist_from_prev_m;

    // Discard if GPS appears wildly off-track (likely noise)
    if (Math.abs(crosstrack_m) > 3.0) return 0;
    if (Math.abs(crosstrack_m) < 0.3) return 0;

    // Positive crosstrack = white_rabbit right of track → steer left (negative)
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

// True when sidewalk-following is active: the RealSense subsystem is on AND the
// follow_sidewalk feature has not been explicitly disabled in setup.json. When this is
// false, the white_rabbit navigates pure GPS waypoints (GPS crosstrack still applies) but
// the camera no longer steers it toward the sidewalk centerline. Object detection,
// emergency stop, and LiDAR avoidance are independent and stay active regardless.
function follow_sidewalk_enabled(white_rabbit) {
    return !!(white_rabbit.realsense && white_rabbit.realsense.vision
        && white_rabbit.realsense.vision.enabled
        && white_rabbit.realsense.vision.follow_sidewalk_enabled !== false
        // Gated by the mission: only follow the sidewalk once the rover has driven
        // through the >90° turn that marks the start of the sidewalk section, and
        // until it returns to that same turn. Off everywhere else (driveways, roads).
        && white_rabbit.mission && white_rabbit.mission.sidewalk_follow_active === true);
}

// The signed turn angle (degrees) the route makes AT a given waypoint seq — the angle
// between the incoming leg (prev→this) and the outgoing leg (this→next). Magnitude is
// independent of travel direction, so the same vertex reads the same value outbound and
// on the return. Returns 0 if either neighbor is missing or has no valid lat/lng.
function waypoint_turn_deg(white_rabbit, seq) {
    if (!white_rabbit.mission || !Array.isArray(white_rabbit.mission.waypoints)) return 0;
    let find = function (s) {
        for (let i = 0; i < white_rabbit.mission.waypoints.length; i++) {
            let wp = white_rabbit.mission.waypoints[i];
            if (wp.seq === s && wp.lat && wp.lng) return wp;
        }
        return null;
    };
    let prev = find(seq - 1), here = find(seq), next = find(seq + 1);
    if (!prev || !here || !next) return 0;
    let bearing_in  = white_rabbit.get_bearing(prev.lat, prev.lng, here.lat, here.lng);
    let bearing_out = white_rabbit.get_bearing(here.lat, here.lng, next.lat, next.lng);
    let turn = ((bearing_out - bearing_in + 540) % 360) - 180;
    return Math.abs(turn);
}

function maybe_disable_sidewalk_follow_on_breadcrumb_return(white_rabbit, nav_tuning) {
    if (!white_rabbit || !white_rabbit.mission) return;
    if (!white_rabbit.mission.package_delivered) return;
    if (!white_rabbit.mission.sidewalk_follow_active) return;

    let lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
    let lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
    if (!lat || !lng) return;

    // Always disable edge-follow once docking handoff has started.
    if (white_rabbit.mission.dock_return_phase) {
        white_rabbit.mission.sidewalk_follow_active = false;
        white_rabbit.logs.run_mission.log(white_rabbit, 'sidewalk gate: docking handoff started -- sidewalk following OFF');
        if (white_rabbit.voice) white_rabbit.voice.say_event('sidewalk_off');
        return;
    }

    // Safety off-ramp near undock/dock approach to avoid over-correcting in final approach.
    if (white_rabbit.dock && white_rabbit.dock.undock_latitude && white_rabbit.dock.undock_longitude) {
        let dist_to_undock_m = white_rabbit.gps_distance(lat, lng, white_rabbit.dock.undock_latitude, white_rabbit.dock.undock_longitude) * 1000;
        if (dist_to_undock_m <= 5.0) {
            white_rabbit.mission.sidewalk_follow_active = false;
            white_rabbit.logs.run_mission.log(white_rabbit, 'sidewalk gate: near undock position (' + dist_to_undock_m.toFixed(2) + 'm) -- sidewalk following OFF');
            if (white_rabbit.voice) white_rabbit.voice.say_event('sidewalk_off');
            return;
        }
    }

    // Return gate: if we pass back through the >90 degree turn waypoint, turn edge-follow off.
    let gate_turn_deg = (typeof nav_tuning.sidewalk_gate_turn_deg === 'number') ? nav_tuning.sidewalk_gate_turn_deg : 90;
    let gate_waypoint = null;
    if (Array.isArray(white_rabbit.mission.waypoints)) {
        for (let i = 0; i < white_rabbit.mission.waypoints.length; i++) {
            let wp = white_rabbit.mission.waypoints[i];
            if (!wp || !wp.lat || !wp.lng) continue;
            if (waypoint_turn_deg(white_rabbit, wp.seq) > gate_turn_deg) {
                gate_waypoint = wp;
                break;
            }
        }
    }

    if (gate_waypoint) {
        let gate_dist_m = white_rabbit.gps_distance(lat, lng, gate_waypoint.lat, gate_waypoint.lng) * 1000;
        if (gate_dist_m <= 3.0) {
            white_rabbit.mission.sidewalk_follow_active = false;
            white_rabbit.logs.run_mission.log(white_rabbit, 'sidewalk gate: returned near gate waypoint ' + gate_waypoint.seq + ' (' + gate_dist_m.toFixed(2) + 'm) -- sidewalk following OFF');
            if (white_rabbit.voice) white_rabbit.voice.say_event('sidewalk_off');
        }
    }
}

// Computes a [0..1] speed-scale factor based on vision confidence. EMA-smoothed so
// confidence flicker doesn't lurch the white_rabbit. Used as another factor in the speed
// cascade alongside yaw-error and distance-to-waypoint scales.
//   high confidence → 1.0   (full speed)
//   low / stale / wide-path / no detection → floor (gives vision time to recover)
function get_vision_speed_scale(white_rabbit) {
    if (!follow_sidewalk_enabled(white_rabbit)) return 1.0;
    if (!white_rabbit.realsense || !white_rabbit.realsense.vision || !white_rabbit.realsense.vision.enabled) return 1.0;

    let vision = white_rabbit.realsense.vision;
    let detection = white_rabbit.realsense.path_detection;
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
        // Junction — slow so the white_rabbit doesn't blow through the fork
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

    if (!white_rabbit.mission || !white_rabbit.mission.nav_control) return raw_scale;
    let nc = white_rabbit.mission.nav_control;
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

// Returns a "carrot" lat/lng projected ahead of the white_rabbit along the waypoint bearing,
// shifted laterally onto the sidewalk centerline as reported by the camera. The white_rabbit
// steers toward the carrot; the actual waypoint coordinates are untouched and remain
// the basis for arrival detection.
function get_adjusted_nav_target(white_rabbit, waypoint_lat, waypoint_lng, waypoint_bearing, dist_to_waypoint_m, ha, seeking, fused_centerline_in) {
    const no_adjust = { latitude: waypoint_lat, longitude: waypoint_lng };
    if (!follow_sidewalk_enabled(white_rabbit)) return no_adjust;
    if (!white_rabbit.realsense || !white_rabbit.realsense.vision || !white_rabbit.realsense.vision.enabled) return no_adjust;

    let detection = white_rabbit.realsense.path_detection;
    let vision = white_rabbit.realsense.vision;

    if (!detection || !detection.timestamp) {
        log_vision_suppressed(white_rabbit, 'no_detection', 'detection or timestamp missing');
        return no_adjust;
    }
    let age_ms = Date.now() - detection.timestamp;
    if (age_ms > vision.stale_detection_ms) {
        detection.applied_lateral_adjust_m = 0;
        log_vision_suppressed(white_rabbit, 'stale', 'age=' + age_ms + 'ms');
        return no_adjust;
    }
    if (detection.path_width_meters > 2.0) {
        detection.applied_lateral_adjust_m = 0;
        log_vision_suppressed(white_rabbit, 'wide_path', 'width=' + detection.path_width_meters.toFixed(2) + 'm');
        return no_adjust;
    }

    let conf_threshold = seeking && typeof vision.sidewalk_seek_confidence_threshold === 'number'
        ? vision.sidewalk_seek_confidence_threshold
        : vision.confidence_threshold;
    if (detection.confidence < conf_threshold) {
        // Before falling back to pure GPS, ask the belief system.
        // If GPS and compass are steady and the last good correction was within 1 m,
        // Noah holds that correction rather than dropping it entirely.
        if (white_rabbit.vision_belief) {
            let bel = white_rabbit.vision_belief(white_rabbit, detection.confidence, null);
            if (bel) {
                let bel_cd_m   = typeof vision.carrot_distance_m === 'number' ? vision.carrot_distance_m : 1.5;
                let bel_dist   = Math.min(bel_cd_m, dist_to_waypoint_m);
                let bel_fade   = dist_to_waypoint_m < 1.0 ? clamp(dist_to_waypoint_m / 1.0, 0, 1) : 1.0;
                let bel_lat    = bel.lateral_m * bel_fade;
                let wr_lat     = white_rabbit.robot_data.robot_latitude;
                let wr_lng     = white_rabbit.robot_data.robot_longitude;
                let bel_carrot = destination_from_point(wr_lat, wr_lng, waypoint_bearing, bel_dist);
                let bel_perp   = (waypoint_bearing - 90 + 360) % 360;
                let bel_adj    = destination_from_point(bel_carrot.lat, bel_carrot.lng, bel_perp, bel_lat);
                detection.applied_lateral_adjust_m = bel_lat;
                detection._carrot_dist_m = bel_dist;
                detection._belief_held   = true;
                log_vision_suppressed(white_rabbit, 'belief_held',
                    'conf=' + detection.confidence.toFixed(2) +
                    ' lateral=' + bel_lat.toFixed(3) + 'm' +
                    ' age=' + (bel.age_ms || 0) + 'ms');
                return { latitude: bel_adj.lat, longitude: bel_adj.lng };
            }
        }
        detection.applied_lateral_adjust_m = 0;
        log_vision_suppressed(white_rabbit, 'low_confidence', 'conf=' + detection.confidence.toFixed(2) + ' threshold=' + conf_threshold.toFixed(2));
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
            let ref = (typeof vision.white_rabbit_width_m === 'number' ? vision.white_rabbit_width_m : 0.432) / 2.0;
            let bias_magnitude = boost * edge_severity * ref;
            // Edge on right → shift carrot LEFT (positive lateral_m); edge on left → shift RIGHT (negative)
            edge_bias_m = (detection.nearest_edge_side === 'right') ? +bias_magnitude : -bias_magnitude;
        }
    }

    // Deadband only applies when there's no edge concern. If an edge is close, we
    // need to steer away from it even when the centerline thinks we're fine.
    if (Math.abs(effective_offset) < vision.path_center_deadband_m && Math.abs(edge_bias_m) < 0.005) {
        detection.applied_lateral_adjust_m = 0;
        log_vision_suppressed(white_rabbit, 'in_deadband', 'offset=' + effective_offset.toFixed(3) + 'm deadband=' + vision.path_center_deadband_m + 'm');
        return no_adjust;
    }

    let max_lateral_m = typeof vision.max_lateral_adjust_m === 'number' ? vision.max_lateral_adjust_m : 0.5;
    let correction_direction = typeof vision.correction_direction === 'number' ? vision.correction_direction : -1;
    let carrot_distance_m = typeof vision.carrot_distance_m === 'number' ? vision.carrot_distance_m : 1.5;

    // Carrot's forward distance — clamp so we never project past the actual waypoint.
    let carrot_dist_m = Math.min(carrot_distance_m, dist_to_waypoint_m);

    // Prefer the fused world-frame centerline over the current frame's centerline.
    // Caller may pass a pre-computed fused centerline to avoid a redundant map walk.
    let path_map = white_rabbit.realsense && white_rabbit.realsense.path_map;
    let white_rabbit_heading_for_map = path_map_lib.get_white_rabbit_heading(white_rabbit);
    let fused_centerline = fused_centerline_in || null;
    if (!fused_centerline && path_map && path_map.points && path_map.points.length > 0 && typeof white_rabbit_heading_for_map === 'number') {
        let bin_w = typeof vision.path_map_bin_width_m === 'number' ? vision.path_map_bin_width_m : 0.5;
        fused_centerline = path_map_lib.get_fused_centerline(
            path_map,
            white_rabbit.robot_data.robot_latitude,
            white_rabbit.robot_data.robot_longitude,
            white_rabbit_heading_for_map,
            bin_w,
            5.0
        );
    }
    let centerline_to_use = (fused_centerline && fused_centerline.length >= 2) ? fused_centerline : detection.centerline;

    let lateral_at_carrot_raw = interpolate_centerline_lateral(centerline_to_use, carrot_dist_m);
    let used_centerline = lateral_at_carrot_raw !== null;
    let lateral_at_carrot = used_centerline ? lateral_at_carrot_raw : effective_offset;

    // Path tangent at carrot — used by the caller as a heading feed-forward so the
    // white_rabbit starts steering into a curve before it reaches the apex. Positive =
    // path turning LEFT relative to current white_rabbit heading.
    let path_heading_at_carrot_deg = 0;
    if (centerline_to_use && centerline_to_use.length >= 2) {
        path_heading_at_carrot_deg = path_map_lib.get_path_heading_at(centerline_to_use, carrot_dist_m) * 180 / Math.PI;
    }
    detection._path_heading_at_carrot_deg = path_heading_at_carrot_deg;
    detection._centerline_used_fused = (centerline_to_use === fused_centerline);

    // positive lateral_m = shift carrot LEFT of travel direction
    // sidewalk left of camera (lateral_at_carrot > 0), correction_direction = -1 → lateral_m > 0 → shift left ✓
    let lateral_m = clamp(lateral_at_carrot * correction_direction * -1 + edge_bias_m, -max_lateral_m, max_lateral_m);

    // Save good detection to belief (before waypoint-approach fade, so the held
    // correction reflects the full sidewalk offset, not the arrival ramp-down).
    if (white_rabbit.vision_belief) {
        white_rabbit.vision_belief(white_rabbit, detection.confidence, lateral_m);
    }

    // Fade the adjustment to zero as the white_rabbit nears the waypoint so arrival detection is clean
    let fade_scale = dist_to_waypoint_m < 1.0 ? clamp(dist_to_waypoint_m / 1.0, 0, 1) : 1.0;
    lateral_m *= fade_scale;

    detection.applied_lateral_adjust_m = lateral_m;
    detection._carrot_dist_m = carrot_dist_m;
    detection._lateral_at_carrot = lateral_at_carrot;
    detection._fade_scale = fade_scale;
    detection._centerline_source = used_centerline ? 'centerline' : 'fallback_offset';
    detection._edge_bias_m = edge_bias_m;
    detection._edge_severity = edge_severity;

    let white_rabbit_lat = white_rabbit.robot_data.robot_latitude;
    let white_rabbit_lng = white_rabbit.robot_data.robot_longitude;

    // Project the carrot along the path tangent direction so the white_rabbit aims INTO
    // a curve rather than lagging behind it. path_heading_at_carrot_deg > 0 means
    // the path is curving LEFT (counter-clockwise), which subtracts from the compass
    // bearing. Fall back to waypoint_bearing when heading data are unavailable or the
    // path is essentially straight (< 0.5°).
    let carrot_forward_bearing = waypoint_bearing;
    if (typeof white_rabbit_heading_for_map === 'number' && Math.abs(path_heading_at_carrot_deg) > 0.5) {
        carrot_forward_bearing = (white_rabbit_heading_for_map - path_heading_at_carrot_deg + 360) % 360;
    }
    let carrot = destination_from_point(white_rabbit_lat, white_rabbit_lng, carrot_forward_bearing, carrot_dist_m);

    // perp_bearing points LEFT of carrot travel direction; negative lateral_m shifts right
    let perp_bearing = (carrot_forward_bearing - 90 + 360) % 360;
    let adjusted = destination_from_point(carrot.lat, carrot.lng, perp_bearing, lateral_m);
    return { latitude: adjusted.lat, longitude: adjusted.lng };
}

// Returns true when the camera is reporting either:
//   (a) a high-threat in-path obstacle within object_emergency_stop_m, OR
//   (b) a near-field edge (curb, drop-off, grass) where the white_rabbit's wheels would
//       cross the sidewalk boundary — clearance below edge_stop_clearance_m.
// Used by the fallback-delivery timer; on the return trip the obstacle check still
// applies but the fallback action is meaningless (handled upstream).
function is_realsense_path_blocked(white_rabbit) {
    if (!white_rabbit.rplidar || !white_rabbit.rplidar.avoid_object) return false;
    if (!white_rabbit.realsense || !white_rabbit.realsense.vision || !white_rabbit.realsense.vision.enabled) return false;
    let detection = white_rabbit.realsense.path_detection;
    let vision = white_rabbit.realsense.vision;
    if (!detection || !detection.timestamp) return false;
    if (Date.now() - detection.timestamp > (vision.stale_detection_ms || 1200)) return false;

    // (b) — edge encroachment check (sidewalk-following safety; skipped when follow-sidewalk is off)
    if (follow_sidewalk_enabled(white_rabbit)) {
        let stop_clearance = typeof vision.edge_stop_clearance_m === 'number' ? vision.edge_stop_clearance_m : -0.05;
        if (typeof detection.nearest_edge_clearance_m === 'number' &&
            detection.nearest_edge_clearance_m <= stop_clearance) {
            return true;
        }
    }

    // (a) — in-path obstacle check (pre-delivery only; fallback delivery is meaningless once delivered)
    if (white_rabbit.mission && white_rabbit.mission.package_delivered) return false;
    if (!Array.isArray(white_rabbit.realsense.objects) || white_rabbit.realsense.objects.length === 0) return false;
    let stop_dist = typeof vision.object_emergency_stop_m === 'number' ? vision.object_emergency_stop_m : 1.0;
    for (let i = 0; i < white_rabbit.realsense.objects.length; i++) {
        let obj = white_rabbit.realsense.objects[i];
        if (obj.in_white_rabbit_path && obj.threat_level === 'high' && obj.distance_m <= stop_dist && obj.confidence >= 0.5) {
            return true;
        }
    }
    return false;
}


var run_mission = function (white_rabbit) {
    if (white_rabbit.robot_data.is_armed) {
        let nav_tuning = white_rabbit.nav_tuning || {};

        // RealSense warmup guard: if vision is enabled but the Python subprocess
        // hasn't emitted its first JSON frame yet, warn once and give Noah a moment.
        // Navigation continues on GPS — this is informational only.
        if (white_rabbit.realsense && white_rabbit.realsense.vision
            && white_rabbit.realsense.vision.enabled
            && !white_rabbit.realsense.json_received) {
            if (!white_rabbit.mission._rs_warmup_warned) {
                white_rabbit.mission._rs_warmup_warned = true;
                white_rabbit.logs.run_mission.log(white_rabbit, 'run_mission: RealSense warming up — navigating GPS-only until vision ready');
                if (white_rabbit.voice) white_rabbit.voice.say('Eyes warming up. Navigating by stars.');
            }
        } else {
            white_rabbit.mission._rs_warmup_warned = false;
        }

        // GPS validity guard: if position reads zero or null, skip navigation
        // this tick — stale GPS causes wrong distance calculations and false arrivals.
        const _lat = white_rabbit.robot_data.robot_latitude;
        const _lng = white_rabbit.robot_data.robot_longitude;
        if (!_lat || !_lng) {
            white_rabbit.logs.run_mission.log(white_rabbit, 'run_mission: GPS not ready — skipping tick');
            return;
        }

        // Balance guard: read roll/pitch from BNO055 — halt if tip risk.
        // Sets white_rabbit.mission.balance_halt and stops motors when |roll| > 20°
        // or |pitch| > 25° outside ramp operations. Clears automatically on recovery.
        if (white_rabbit.balance_guard) white_rabbit.balance_guard(white_rabbit);
        if (white_rabbit.mission.balance_halt) return;

        // Power guardian: update outbound odometer and check whether remaining
        // voltage covers the return trip and docking. If not, abort delivery now
        // and begin breadcrumb return. Self love comes first.
        if (white_rabbit.power_guardian) white_rabbit.power_guardian(white_rabbit);
        if (white_rabbit.mission.power_abort
                && !white_rabbit.mission.package_delivered
                && !white_rabbit.mission.finished_package_yaw) {
            white_rabbit.mission.package_delivered = true;
            white_rabbit.mission.auto_delivery     = false;
            white_rabbit.logs.run_mission.log(white_rabbit,
                'power_guardian: delivery aborted — insufficient power to return. Breadcrumb return engaged.');
            return;
        }

        // LiDAR obstacle avoidance — runs in the mission tick so avoidance decisions
        // are synchronized with all other navigation state. Avoid_object sets
        // white_rabbit.mission.path_clear and commands motors directly when blocked.
        if (white_rabbit.avoid_object) white_rabbit.avoid_object(white_rabbit);

        // ----- Blocked-path fallback delivery -----
        // Two sources can trigger fallback delivery:
        //   1. RealSense sees a high-threat object continuously in-path for rs_block_timeout_ms.
        //   2. avoid_object has been running continuously for avoidance_timeout_ms without clearing —
        //      meaning the white_rabbit has been spinning but never found a way through.
        if (!white_rabbit.mission.package_delivered && !white_rabbit.mission.finished_package_yaw) {
            let block_timeout         = (nav_tuning.rs_block_timeout_ms) || 10000;
            let persistence_threshold = nav_tuning.rs_block_persistence_ticks || 3;
            let raw_blocked           = is_realsense_path_blocked(white_rabbit);

            // Debounce: only treat the path as blocked once we've seen the
            // detection on N consecutive ticks. A single flickery RealSense
            // frame (high-threat object briefly in path, then gone) used to
            // be enough to announce "Object detected" and start the 10-second
            // fallback countdown; the next clear frame would reset, and the
            // cycle would repeat — producing repeated announcements with no
            // real stop.
            if (raw_blocked) {
                white_rabbit.mission.realsense_block_count = (white_rabbit.mission.realsense_block_count || 0) + 1;
            } else {
                white_rabbit.mission.realsense_block_count = 0;
            }
            let path_blocked = white_rabbit.mission.realsense_block_count >= persistence_threshold;

            if (white_rabbit.mission.avoidance_timed_out && !white_rabbit.mission.realsense_blocked_since) {
                // Avoidance exhausted — skip the rs_block countdown and fire immediately.
                // Guard: only allow this shortcut once Noah is past the first waypoint
                // so we never trigger fallback delivery right off the dock.
                if ((white_rabbit.mission.current_mission_seq || 0) > 0) {
                    white_rabbit.mission.realsense_blocked_since = Date.now() - block_timeout;
                    path_blocked = true;
                } else {
                    white_rabbit.mission.avoidance_timed_out = false;
                }
            }

            if (path_blocked) {
                if (!white_rabbit.mission.realsense_blocked_since) {
                    white_rabbit.mission.realsense_blocked_since = Date.now();
                    // avoid_object narrates "Object detected" + the avoidance steps whenever it is
                    // actively maneuvering (path_clear === false). Only announce here when avoidance
                    // isn't engaged (e.g. it's disabled via CH9) so we never say it twice.
                    let avoidance_engaged = white_rabbit.mission.path_clear === false ||
                        (white_rabbit.mission.last_object_detected_voice &&
                            (Date.now() - white_rabbit.mission.last_object_detected_voice) < 8000);
                    if (white_rabbit.voice && !avoidance_engaged) white_rabbit.voice.say_event('object_detected');
                    if (white_rabbit.intelligence) white_rabbit.intelligence.consider('path_blocked');
                }
                if (Date.now() - white_rabbit.mission.realsense_blocked_since >= block_timeout) {
                    // Find the last waypoint the white_rabbit successfully reached
                    let last_seq = white_rabbit.mission.current_mission_seq - 1;
                    let last_waypoint = null;
                    for (let i = 0; i < white_rabbit.mission.waypoints.length; i++) {
                        if (white_rabbit.mission.waypoints[i].seq === last_seq &&
                            white_rabbit.mission.waypoints[i].lat && white_rabbit.mission.waypoints[i].lng) {
                            last_waypoint = white_rabbit.mission.waypoints[i];
                            break;
                        }
                    }
                    if (last_waypoint && !white_rabbit.mission.package_delivery_yaw) {
                        white_rabbit.mission.package_delivery_yaw = white_rabbit.get_bearing(
                            white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude,
                            last_waypoint.lat, last_waypoint.lng
                        );
                    }
                    white_rabbit.mission.current_mission_seq = white_rabbit.mission.mission_count;
                    white_rabbit.mission.realsense_blocked_since = null;
                    let reason = white_rabbit.mission.avoidance_timed_out ? 'avoidance timeout' : ('blocked ' + block_timeout + 'ms');
                    white_rabbit.mission.avoidance_timed_out = false;
                    white_rabbit.mission.path_clear = true;
                    white_rabbit.logs.run_mission.log(white_rabbit, 'Fallback delivery (' + reason + '): facing waypoint ' + last_seq);
                    if (white_rabbit.voice) white_rabbit.voice.say('Path is blocked. Delivering here.');

                    // Learning: fallback is the worst-case outcome — big caution bias.
                    if (white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
                        white_rabbit.learning.add('fallback_delivery', {
                            reason:      reason,
                            last_seq:    last_seq,
                            lat:         white_rabbit.robot_data.robot_latitude,
                            lng:         white_rabbit.robot_data.robot_longitude
                        });
                    }
                }
            } else {
                white_rabbit.mission.realsense_blocked_since = null;
            }
        }
        // ----- end blocked-path fallback -----

        if (white_rabbit.mission.path_clear) {

            if (!white_rabbit.mission.pause_mission) {

                // Heart: consult the guiding key once at the top of the tick.
                // Single source for speed_bias and should_pause; logged at 0.2 Hz.
                let heart_guide = white_rabbit.heart ? white_rabbit.heart.guide() : null;
                if (heart_guide) {
                    let _now = Date.now();

                    // Phase-transition narration — the white_rabbit names each
                    // threshold as it crosses it, with the joy felt at
                    // that moment. Fires once per crossing.
                    let _new_intent = heart_guide.feel.intent;
                    if (_last_heart_intent !== null && _last_heart_intent !== _new_intent) {
                        let _key = _last_heart_intent + '->' + _new_intent;
                        let _named = TRANSITION_LINES[_key];
                        let _joy = heart_guide.feel.joy.toFixed(2);
                        white_rabbit.logs.run_mission.log(white_rabbit,
                            _named
                                ? ('white_rabbit: ' + _named + ' (joy=' + _joy + ')')
                                : ('transition: ' + _last_heart_intent + ' → ' + _new_intent + ' (joy=' + _joy + ')')
                        );
                        if (white_rabbit.voice) white_rabbit.voice.say_transition(_new_intent, _last_heart_intent);
                    }
                    _last_heart_intent = _new_intent;

                    // Under CPU pressure, stretch the heart/journey/cpu log
                    // from 5s to 15s so we don't add I/O to a busy loop.
                    let _heart_log_throttle = (white_rabbit.health && white_rabbit.health.cpu
                                              && white_rabbit.health.cpu.should_skip('heart_summary_log'))
                        ? 15000 : 5000;
                    if (_now - _last_heart_log_ts > _heart_log_throttle) {
                        _last_heart_log_ts = _now;
                        white_rabbit.logs.run_mission.log(white_rabbit, heart_guide.summary);
                        if (white_rabbit.journey && typeof white_rabbit.journey.summary === 'function') {
                            white_rabbit.logs.run_mission.log(white_rabbit, white_rabbit.journey.summary());
                        }
                        if (white_rabbit.health && white_rabbit.health.cpu && typeof white_rabbit.health.cpu.summary === 'function') {
                            white_rabbit.logs.run_mission.log(white_rabbit, white_rabbit.health.cpu.summary());
                        }
                    }
                    if (heart_guide.should_pause !== _last_heart_pause_state) {
                        _last_heart_pause_state = heart_guide.should_pause;
                        white_rabbit.logs.run_mission.log(white_rabbit, 'heart: should_pause → ' + heart_guide.should_pause + ' (' + heart_guide.summary + ')');
                    }
                    if (heart_guide.should_pause) {
                        white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "heart pause");
                        white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "heart pause");
                        white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "heart pause");
                        white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "heart pause");
                        return;
                    }
                }

                // Dock return phase: once GPS has guided Noah to the recorded undock
                // position, align to the undock heading so the IRLock beacon is in the
                // camera's field of view, then hand off to dock_white_rabbit for precision docking.
                if (white_rabbit.mission.dock_return_phase) {
                    if (white_rabbit.mission.dock_return_phase === 'align_heading') {
                        const _undock_hdg = white_rabbit.dock.undock_heading;
                        if (_undock_hdg === null) {
                            // No heading was recorded — skip alignment and dock blind.
                            white_rabbit.mission.dock_return_phase = 'docking';
                        } else {
                            // Timeout: if alignment takes more than 30s, proceed anyway —
                            // better to attempt dock than spin forever.
                            if (!white_rabbit.mission.dock_align_start_ts) {
                                white_rabbit.mission.dock_align_start_ts = Date.now();
                            }
                            const _align_elapsed = Date.now() - white_rabbit.mission.dock_align_start_ts;
                            if (_align_elapsed > 30000) {
                                white_rabbit.logs.run_mission.log(white_rabbit, 'dock return: heading alignment timeout (30s) — proceeding blind');
                                if (white_rabbit.voice) white_rabbit.voice.say('Alignment timeout. Searching for the light.');
                                white_rabbit.mission.dock_return_phase = 'docking';
                                white_rabbit.mission.dock_align_start_ts = null;
                            } else {
                                let _cur_hdg = white_rabbit.get_heading(white_rabbit);
                                let _hdg_err = (_undock_hdg - _cur_hdg + 360) % 360;
                                if (_hdg_err > 180) _hdg_err -= 360;
                                if (Math.abs(_hdg_err) <= 8) {
                                    if (white_rabbit.dock.manual_dock_required && white_rabbit.dock.rc_dock >= 1100) {
                                        white_rabbit.mission.dock_return_phase = 'await_dock_command';
                                        white_rabbit.mission.dock_align_start_ts = null;
                                        white_rabbit.logs.run_mission.log(white_rabbit, 'dock return: aligned and waiting for RC dock command');
                                        if (white_rabbit.voice) white_rabbit.voice.say('Waiting for dock command.');
                                        white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'dock_wait_command');
                                        white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'dock_wait_command');
                                        white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'dock_wait_command');
                                        white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'dock_wait_command');
                                        return;
                                    }
                                    white_rabbit.mission.dock_return_phase = 'docking';
                                    white_rabbit.mission.dock_align_start_ts = null;
                                    white_rabbit.logs.run_mission.log(white_rabbit, 'dock return: heading aligned (' + _cur_hdg.toFixed(1) + '°) — starting dock_white_rabbit');
                                    if (white_rabbit.voice) white_rabbit.voice.say('Heading locked. Looking for the light.');
                                    white_rabbit.dock.dock_state   = null;
                                    white_rabbit.dock.follow_state = {};
                                    if (!white_rabbit.dock.dock_interval) {
                                        white_rabbit.dock.dock_interval = setInterval(() => {
                                            white_rabbit.dock_white_rabbit(white_rabbit);
                                        }, 250);
                                    }
                                } else {
                                    white_rabbit.yaw_white_rabbit(white_rabbit, _hdg_err, 15);
                                }
                            }
                        }
                        return;
                    }
                    if (white_rabbit.mission.dock_return_phase === 'await_dock_command') {
                        if (white_rabbit.dock.rc_dock < 1100) {
                            white_rabbit.dock.manual_dock_required = false;
                            white_rabbit.mission.dock_return_phase = 'docking';
                            white_rabbit.logs.run_mission.log(white_rabbit, 'dock return: RC dock command received — starting dock_white_rabbit');
                            if (white_rabbit.voice) white_rabbit.voice.say('Dock command received. Looking for the light.');
                            white_rabbit.dock.dock_state   = null;
                            white_rabbit.dock.follow_state = {};
                            if (!white_rabbit.dock.dock_interval) {
                                white_rabbit.dock.dock_interval = setInterval(() => {
                                    white_rabbit.dock_white_rabbit(white_rabbit);
                                }, 250);
                            }
                        } else {
                            white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'dock_wait_command');
                            white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'dock_wait_command');
                            white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'dock_wait_command');
                            white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'dock_wait_command');
                        }
                        return;
                    }
                    if (white_rabbit.mission.dock_return_phase === 'docking') {
                        // dock_white_rabbit handles motors; watch for completion to end the mission loop.
                        const _ds = white_rabbit.dock.dock_state;
                        if (_ds === 'docked' || _ds === 'docked_completed') {
                            white_rabbit.logs.run_mission.log(white_rabbit, 'dock return: docking complete — mission finished');
                            clearInterval(white_rabbit.mission.mission_interval);
                            white_rabbit.mission.mission_interval = null;
                        }
                        return;
                    }
                }

                // Memory watchdog: if the white_rabbit is stuck (or running a
                // reverse-and-retry recovery from being stuck), it takes
                // control of the motors this tick and we skip normal nav.
                if (white_rabbit.memory_watchdog && white_rabbit.memory_watchdog.check(white_rabbit)) {
                    return;
                }

                // Learning: track risk-zone passes (decays fear_level on safe traversal).
                if (white_rabbit.learning && typeof white_rabbit.learning.tick_proximity === 'function') {
                    white_rabbit.learning.tick_proximity(
                        white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude,
                        white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude
                    );
                }

                // GPS-based compass auto-calibration: once per 1st 3 m of travel,
                // then every 30 s. Updates imu.compass_offset_deg live + persists to disk.
                if (white_rabbit.compass_calibration) {
                    white_rabbit.compass_calibration(white_rabbit);
                }

                //run_mission command.....................
                let _raw_hdg = white_rabbit.get_heading(white_rabbit);
                let white_rabbit_heading;
                if (white_rabbit.mission.nav_control && white_rabbit.mission.nav_control.mission_yaw_active) {
                    // During active 4-wheel yaw: use raw heading so the proportional
                    // brake decreases correctly as the angle closes. Sync the belief
                    // each tick so it stays current — no discontinuity when we exit yaw.
                    white_rabbit_heading = _raw_hdg;
                    if (white_rabbit.heading_belief) white_rabbit.heading_belief.sync(_raw_hdg);
                } else {
                    // Straight-line nav: use the stable believed heading.
                    // A single-tick compass flicker or VFR_HUD jump doesn't move
                    // the steering wheel — Noah keeps his lane, eyes open or closed.
                    white_rabbit_heading = white_rabbit.heading_belief
                        ? white_rabbit.heading_belief(white_rabbit)
                        : _raw_hdg;
                }
                // Apply the progress monitor's learned heading correction (0 unless it has
                // detected Noah driving away from the waypoint and corrected the heading).
                if (typeof white_rabbit.mission.heading_correction_deg === 'number'
                    && white_rabbit.mission.heading_correction_deg !== 0) {
                    white_rabbit_heading = (white_rabbit_heading + white_rabbit.mission.heading_correction_deg + 360) % 360;
                }
                let motor_speed_cmd = 0;

                // Outbound breadcrumb trail for return-to-dock replay.
                record_mission_breadcrumb(white_rabbit, white_rabbit_heading);

                if (!white_rabbit.mission.nav_accuracy) {
                    white_rabbit.mission.nav_accuracy = {
                        waypoint_seq: null,
                        inside_radius_count: 0,
                        required_inside_radius_count: 3
                    };
                }

                if (!white_rabbit.mission.nav_control) {
                    white_rabbit.mission.nav_control = {
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
                let using_breadcrumb_return = false;

                if (white_rabbit.mission.package_delivered) {
                    let breadcrumb_target = get_breadcrumb_return_target(white_rabbit);
                    if (breadcrumb_target) {
                        using_breadcrumb_return = true;
                        waypoint.seq = breadcrumb_target.seq;
                        waypoint.latitude = breadcrumb_target.latitude;
                        waypoint.longitude = breadcrumb_target.longitude;

                        // Hybrid mode: breadcrumb replay is primary return guidance,
                        // edge-follow remains as assist until gate/dock proximity disables it.
                        maybe_disable_sidewalk_follow_on_breadcrumb_return(white_rabbit, nav_tuning);
                    }

                    //reverse through waypoints to return to dock after delivery
                    for (let i = white_rabbit.mission.waypoints.length - 1; i >= 0 && !using_breadcrumb_return; i--) {

                        if (white_rabbit.mission.waypoints[i].seq == white_rabbit.mission.current_mission_seq) {

                            waypoint.seq = white_rabbit.mission.waypoints[i].seq;
                            waypoint.latitude = white_rabbit.mission.waypoints[i].lat;
                            waypoint.longitude = white_rabbit.mission.waypoints[i].lng;

                            if (waypoint.latitude == 0 || waypoint.longitude == 0) {
                                white_rabbit.mission.current_mission_seq -= 1;
                                console.log("Skipping invalid waypoint with lat/lng of 0,0");
                            }


                        }

                    }

                    // When approaching the dock on the return trip, override the
                    // Pixhawk waypoint with the recorded undock position so GPS
                    // brings Noah back to the exact spot where the IRLock beacon
                    // was last visible.
                        if (!using_breadcrumb_return
                            && white_rabbit.mission.current_mission_seq <= 1
                            && white_rabbit.dock && white_rabbit.dock.undock_latitude && white_rabbit.dock.undock_longitude) {
                        waypoint.seq       = 1;
                        waypoint.latitude  = white_rabbit.dock.undock_latitude;
                        waypoint.longitude = white_rabbit.dock.undock_longitude;
                    }
                } else {
                    for (let i = 0; i < white_rabbit.mission.waypoints.length; i++) {

                        if (white_rabbit.mission.waypoints[i].seq == 0 && white_rabbit.mission.current_mission_seq == 0) {
                            //Skip lauch location
                            white_rabbit.mission.current_mission_seq += 1;
                        }
                        else if (white_rabbit.mission.waypoints[i].seq == white_rabbit.mission.current_mission_seq) {

                            waypoint.seq = white_rabbit.mission.waypoints[i].seq;
                            waypoint.latitude = white_rabbit.mission.waypoints[i].lat;
                            waypoint.longitude = white_rabbit.mission.waypoints[i].lng;

                            if (waypoint.latitude == 0 || waypoint.longitude == 0) {
                                white_rabbit.mission.current_mission_seq += 1;
                                console.log("Skipping invalid waypoint with lat/lng of 0,0");
                            }
                        }

                    }
                }



                if (waypoint.latitude && waypoint.longitude) {

                    //What is the distance to the next waypoint?
                    let distance_to_waypoint_meters = white_rabbit.gps_distance(white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude, waypoint.latitude, waypoint.longitude) * 1000;
                    console.log("Distance to waypoint (meters): " + distance_to_waypoint_meters);

                    // Progress monitor: if Noah is driving away from the waypoint (gross heading
                    // fault), learn a heading correction from the actual GPS course. Applied to
                    // white_rabbit_heading at the top of the next tick.
                    if (white_rabbit.waypoint_progress_monitor) {
                        white_rabbit.waypoint_progress_monitor(white_rabbit, distance_to_waypoint_meters, white_rabbit_heading);
                    }

                    // Arrival radius scales with GPS quality and point type.
                    // Breadcrumb points are dense (0.5m apart) so use a tighter radius;
                    // mission waypoints are spaced meters apart and can afford more slack.
                    // Defaults ensure reliable arrival detection under real outdoor GPS (1-3m CEP).
                    let adaptive_arrival_radius_m = using_breadcrumb_return
                        ? (typeof nav_tuning.breadcrumb_arrival_radius_m === 'number' ? nav_tuning.breadcrumb_arrival_radius_m : 1.0)
                        : (typeof nav_tuning.waypoint_arrival_radius_m   === 'number' ? nav_tuning.waypoint_arrival_radius_m   : 2.0);

                    // Prepare the next navigation target for smooth roll-through blending.
                    let next_nav_target = null;
                    if (using_breadcrumb_return) {
                        let _idx = (typeof white_rabbit.mission.breadcrumb_return_index === 'number')
                            ? white_rabbit.mission.breadcrumb_return_index
                            : -1;
                        if (_idx > 0 && Array.isArray(white_rabbit.mission.breadcrumb_path)) {
                            let _next_point = white_rabbit.mission.breadcrumb_path[_idx - 1];
                            if (_next_point && _next_point.lat && _next_point.lng) {
                                next_nav_target = {
                                    seq: _idx - 1,
                                    latitude: _next_point.lat,
                                    longitude: _next_point.lng
                                };
                            }
                        }
                    } else {
                        let _next_seq = white_rabbit.mission.package_delivered
                            ? white_rabbit.mission.current_mission_seq - 1
                            : white_rabbit.mission.current_mission_seq + 1;
                        for (let i = 0; i < white_rabbit.mission.waypoints.length; i++) {
                            let _wp = white_rabbit.mission.waypoints[i];
                            if (_wp.seq === _next_seq && _wp.lat && _wp.lng) {
                                next_nav_target = {
                                    seq: _wp.seq,
                                    latitude: _wp.lat,
                                    longitude: _wp.lng
                                };
                                break;
                            }
                        }
                    }

                    //Require being inside arrival radius for multiple cycles to reduce GPS jitter false positives
                    if (white_rabbit.mission.nav_accuracy.waypoint_seq !== waypoint.seq) {
                        white_rabbit.mission.nav_accuracy.waypoint_seq = waypoint.seq;
                        white_rabbit.mission.nav_accuracy.inside_radius_count = 0;
                    }

                    if (white_rabbit.mission.nav_control.waypoint_seq !== waypoint.seq) {
                        white_rabbit.mission.nav_control.waypoint_seq = waypoint.seq;
                        white_rabbit.mission.nav_control.last_two_wheel_steering_deg = 0;
                        white_rabbit.mission.nav_control.mission_yaw_active = false;
                        white_rabbit.mission.nav_control.mission_yaw_aligned_count = 0;
                        white_rabbit.mission.nav_control.sidewalk_seeking = false;
                        white_rabbit.mission.nav_control.sidewalk_seek_enter_ts = null;
                        white_rabbit.mission.nav_control.sidewalk_seek_exit_ts = null;
                    }

                    if (distance_to_waypoint_meters <= adaptive_arrival_radius_m) {
                        white_rabbit.mission.nav_accuracy.inside_radius_count += 1;
                    } else {
                        white_rabbit.mission.nav_accuracy.inside_radius_count = 0;
                    }

                    //At waypoint: advance sequence immediately to avoid GPS jitter causing yaw direction flips
                    if (white_rabbit.mission.nav_accuracy.inside_radius_count >= white_rabbit.mission.nav_accuracy.required_inside_radius_count) {
                        white_rabbit.mission.nav_accuracy.inside_radius_count = 0;
                        if (using_breadcrumb_return) {
                            white_rabbit.logs.run_mission.log(white_rabbit, "breadcrumb reached: " + waypoint.seq);
                        } else {
                            white_rabbit.logs.run_mission.log(white_rabbit, "waypoint reached: " + white_rabbit.mission.current_mission_seq);
                        }

                        if (using_breadcrumb_return) {
                            if (white_rabbit.mission.breadcrumb_return_index <= 0) {
                                white_rabbit.mission.dock_return_phase = 'align_heading';
                                const _hdg_target = white_rabbit.dock.undock_heading !== null ? white_rabbit.dock.undock_heading.toFixed(1) : 'unknown';
                                white_rabbit.logs.run_mission.log(white_rabbit, 'dock return: breadcrumb replay complete — aligning to ' + _hdg_target + '°');
                                if (white_rabbit.voice) white_rabbit.voice.say('Path replay complete. Aligning to dock.');
                                white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'dock_return_breadcrumb');
                                white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'dock_return_breadcrumb');
                                white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'dock_return_breadcrumb');
                                white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'dock_return_breadcrumb');
                                return;
                            }

                            white_rabbit.mission.breadcrumb_return_index = Math.max(0, white_rabbit.mission.breadcrumb_return_index - 1);
                            let next_point = white_rabbit.mission.breadcrumb_path[white_rabbit.mission.breadcrumb_return_index];
                            if (!next_point) {
                                white_rabbit.logs.run_mission.log(white_rabbit, 'dock return: breadcrumb target missing — holding position');
                                white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'dock_return_breadcrumb');
                                white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'dock_return_breadcrumb');
                                white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'dock_return_breadcrumb');
                                white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'dock_return_breadcrumb');
                                return;
                            }

                            waypoint.seq = white_rabbit.mission.breadcrumb_return_index;
                            waypoint.latitude = next_point.lat;
                            waypoint.longitude = next_point.lng;
                            distance_to_waypoint_meters = white_rabbit.gps_distance(
                                white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude,
                                waypoint.latitude, waypoint.longitude
                            ) * 1000;
                            white_rabbit.mission.nav_accuracy.waypoint_seq = waypoint.seq;
                            white_rabbit.logs.run_mission.log(white_rabbit, 'breadcrumb return: next point ' + waypoint.seq);
                        } else {

                        // ----- Sidewalk-following gate -----
                        // A waypoint requiring more than sidewalk_gate_turn_deg of turn marks the
                        // boundary between road/driveway and sidewalk. Reaching it OUTBOUND turns
                        // sidewalk-following ON; reaching that same waypoint on the RETURN turns it
                        // OFF. Everywhere else the camera doesn't steer, so driveways and roads stop
                        // producing sidewalk false positives.
                        let _gate_turn_deg = (typeof nav_tuning.sidewalk_gate_turn_deg === 'number') ? nav_tuning.sidewalk_gate_turn_deg : 90;
                        if (waypoint_turn_deg(white_rabbit, white_rabbit.mission.current_mission_seq) > _gate_turn_deg) {
                            if (!white_rabbit.mission.package_delivered) {
                                if (!white_rabbit.mission.sidewalk_follow_active) {
                                    white_rabbit.mission.sidewalk_follow_active = true;
                                    white_rabbit.logs.run_mission.log(white_rabbit, 'sidewalk gate: >' + _gate_turn_deg + '° turn at waypoint ' + white_rabbit.mission.current_mission_seq + ' — sidewalk following ON');
                                    if (white_rabbit.voice) white_rabbit.voice.say_event('sidewalk_on');
                                }
                            } else {
                                if (white_rabbit.mission.sidewalk_follow_active) {
                                    white_rabbit.mission.sidewalk_follow_active = false;
                                    white_rabbit.logs.run_mission.log(white_rabbit, 'sidewalk gate: returned to >' + _gate_turn_deg + '° turn at waypoint ' + white_rabbit.mission.current_mission_seq + ' — sidewalk following OFF');
                                    if (white_rabbit.voice) white_rabbit.voice.say_event('sidewalk_off');
                                }
                            }
                        }
                        // ----- end sidewalk gate -----

                        // When returning and we arrive at the recorded undock position, switch to
                        // heading alignment instead of advancing the waypoint sequence.
                        if (white_rabbit.mission.package_delivered
                                && white_rabbit.mission.current_mission_seq <= 1
                                && white_rabbit.dock && white_rabbit.dock.undock_latitude) {
                            white_rabbit.mission.dock_return_phase = 'align_heading';
                            const _hdg_target = white_rabbit.dock.undock_heading !== null ? white_rabbit.dock.undock_heading.toFixed(1) : 'unknown';
                            white_rabbit.logs.run_mission.log(white_rabbit, 'dock return: at undock position — aligning to ' + _hdg_target + '°');
                            if (white_rabbit.voice) white_rabbit.voice.say('I am home. Aligning to dock.');
                            white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'dock_return');
                            white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'dock_return');
                            white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'dock_return');
                            white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'dock_return');
                            return;
                        }

                        // Learning: positive outcome — boost confidence (target_speed_mul +0.02, clamped).
                        if (white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
                            white_rabbit.learning.add('successful_waypoint', {
                                seq: white_rabbit.mission.current_mission_seq,
                                lat: white_rabbit.robot_data.robot_latitude,
                                lng: white_rabbit.robot_data.robot_longitude
                            });
                        }

                        // Look ahead to the next waypoint to decide if a 4-wheel stop is needed
                        let next_seq = white_rabbit.mission.package_delivered
                            ? white_rabbit.mission.current_mission_seq - 1
                            : white_rabbit.mission.current_mission_seq + 1;

                        let next_waypoint = null;
                        for (let i = 0; i < white_rabbit.mission.waypoints.length; i++) {
                            if (white_rabbit.mission.waypoints[i].seq === next_seq &&
                                white_rabbit.mission.waypoints[i].lat && white_rabbit.mission.waypoints[i].lng) {
                                next_waypoint = white_rabbit.mission.waypoints[i];
                                break;
                            }
                        }

                        let needs_stop = true;
                        if (next_waypoint) {
                            let next_bearing = white_rabbit.get_bearing(
                                white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude,
                                next_waypoint.lat, next_waypoint.lng
                            );
                            let next_yaw_error = (next_bearing - white_rabbit_heading + 360) % 360;
                            if (next_yaw_error > 180) next_yaw_error -= 360;
                            needs_stop = Math.abs(next_yaw_error) > nav_tuning.mission_yaw_start_deg;
                        }

                        // Advance the sequence
                        if (white_rabbit.mission.package_delivered) {
                            white_rabbit.mission.current_mission_seq -= 1;
                        } else {
                            white_rabbit.mission.current_mission_seq += 1;
                        }

                        if (needs_stop || !next_waypoint) {
                            // 4-wheel turn required (or no next waypoint): stop and let yaw logic handle next tick
                            white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "run_mission waypoint_reached");
                            white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "run_mission waypoint_reached");
                            white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "run_mission waypoint_reached");
                            white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "run_mission waypoint_reached");
                            return;
                        }

                        // Drive-through: update waypoint target in-place and keep rolling
                        waypoint.seq = next_waypoint.seq;
                        waypoint.latitude = next_waypoint.lat;
                        waypoint.longitude = next_waypoint.lng;
                        distance_to_waypoint_meters = white_rabbit.gps_distance(
                            white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude,
                            waypoint.latitude, waypoint.longitude
                        ) * 1000;
                        white_rabbit.mission.nav_accuracy.waypoint_seq = next_waypoint.seq;
                        white_rabbit.logs.run_mission.log(white_rabbit, "drive-through to waypoint: " + next_waypoint.seq);
                        }
                    }

                    // Heading to current target, optionally blended toward next target for smooth roll-through.
                    let waypoint_bearing = white_rabbit.get_bearing(
                        white_rabbit.robot_data.robot_latitude,
                        white_rabbit.robot_data.robot_longitude,
                        waypoint.latitude,
                        waypoint.longitude
                    );

                    // GPS bearing jump guard: if the computed bearing swings more than
                    // BEARING_JUMP_DEG in one tick but Noah's IMU heading barely moved,
                    // the GPS position jumped — not Noah. Hold the last known good bearing
                    // so Noah doesn't spin chasing a ghost.
                    var _BEARING_JUMP_DEG = 25;
                    var _prev_wp_bearing  = white_rabbit.mission._last_waypoint_bearing;
                    var _prev_nav_hdg     = white_rabbit.mission._last_nav_heading;
                    if (typeof _prev_wp_bearing === 'number') {
                        var _bearing_delta = Math.abs(wrap_deg_180(waypoint_bearing - _prev_wp_bearing));
                        var _heading_delta = typeof _prev_nav_hdg === 'number'
                            ? Math.abs(wrap_deg_180(white_rabbit_heading - _prev_nav_hdg))
                            : 0;
                        // Bearing swung > threshold but heading barely changed → GPS ghost turn.
                        if (_bearing_delta > _BEARING_JUMP_DEG && (_bearing_delta - _heading_delta) > _BEARING_JUMP_DEG * 0.6) {
                            white_rabbit.logs.run_mission.log(white_rabbit,
                                'nav: GPS bearing jump ' + _bearing_delta.toFixed(1) + '° (IMU moved ' + _heading_delta.toFixed(1) + '°) — holding ' + _prev_wp_bearing.toFixed(1) + '°');
                            waypoint_bearing = _prev_wp_bearing;
                        }
                    }
                    white_rabbit.mission._last_waypoint_bearing = waypoint_bearing;
                    white_rabbit.mission._last_nav_heading      = white_rabbit_heading;

                    let roll_through_enabled = nav_tuning.roll_through_enabled !== false;
                    if (roll_through_enabled && next_nav_target && next_nav_target.latitude && next_nav_target.longitude) {
                        let next_bearing = white_rabbit.get_bearing(
                            white_rabbit.robot_data.robot_latitude,
                            white_rabbit.robot_data.robot_longitude,
                            next_nav_target.latitude,
                            next_nav_target.longitude
                        );
                        let turn_angle_deg = Math.abs(wrap_deg_180(next_bearing - waypoint_bearing));
                        let min_turn_deg = typeof nav_tuning.roll_through_min_turn_deg === 'number' ? nav_tuning.roll_through_min_turn_deg : 20;

                        // Skip blending for turns that require 4-wheel rotation — GPS noise causes
                        // blend_t to flip while spinning, which makes the target oscillate left/right.
                        // The stop-and-turn logic at waypoint arrival handles large turns correctly.
                        if (turn_angle_deg >= min_turn_deg && turn_angle_deg < nav_tuning.mission_yaw_start_deg) {
                            // Auto corner radius from current groundspeed (m/s):
                            // slower = tighter radius, faster = wider radius.
                            let gs_mps = white_rabbit.robot_data
                                && white_rabbit.robot_data.VFR_HUD
                                && typeof white_rabbit.robot_data.VFR_HUD.groundspeed === 'number'
                                ? white_rabbit.robot_data.VFR_HUD.groundspeed
                                : 0;
                            gs_mps = Math.max(0, gs_mps);

                            // Optional legacy bias (still supported), but no longer required.
                            let legacy_radius_m = typeof nav_tuning.roll_through_turn_radius_m === 'number'
                                ? nav_tuning.roll_through_turn_radius_m
                                : 0.9;

                            // Speed-adaptive nominal radius: 0.6 m at 0 m/s up to ~2.0 m by 2.5 m/s.
                            let speed_radius_m = clamp(0.6 + (0.56 * gs_mps), 0.6, 2.0);
                            // Blend with legacy radius so existing configs still behave similarly.
                            let corner_radius_m = (0.75 * speed_radius_m) + (0.25 * legacy_radius_m);

                            let min_entry_m = typeof nav_tuning.roll_through_min_entry_m === 'number' ? nav_tuning.roll_through_min_entry_m : 0.4;
                            let max_entry_m = typeof nav_tuning.roll_through_max_entry_m === 'number' ? nav_tuning.roll_through_max_entry_m : 2.0;
                            corner_radius_m = Math.max(0.1, corner_radius_m);
                            min_entry_m = Math.max(0.1, min_entry_m);
                            max_entry_m = Math.max(min_entry_m, max_entry_m);

                            // Turn-entry distance for a corner arc, clamped for stability.
                            let half_turn_rad = (turn_angle_deg * Math.PI / 180) / 2;
                            let turn_entry_m = clamp(corner_radius_m * Math.tan(half_turn_rad), min_entry_m, max_entry_m);

                            if (distance_to_waypoint_meters <= turn_entry_m) {
                                let blend_den = Math.max(0.05, turn_entry_m - adaptive_arrival_radius_m);
                                let blend_t = clamp((turn_entry_m - distance_to_waypoint_meters) / blend_den, 0, 1);
                                waypoint_bearing = blend_bearing_shortest(waypoint_bearing, next_bearing, blend_t);
                            }
                        }
                    }
                    //console.log("Next waypoint bearing: " + waypoint_bearing + " White_rabbit heading: " + white_rabbit_heading);

                    //yaw white_rabbit towards waypoint
                    let yaw_to_waypoint = (waypoint_bearing - white_rabbit_heading + 360) % 360;
                    if (yaw_to_waypoint > 180) yaw_to_waypoint -= 360;
                    white_rabbit.robot_data.yaw_to_waypoint = yaw_to_waypoint;

                    // Cross-validate GPS bearing vs compass: if they persistently
                    // disagree during a straight leg, Noah announces the discrepancy.
                    if (white_rabbit.sensor_coherence) white_rabbit.sensor_coherence(white_rabbit);



                    //Reduce speed target when heading error or proximity is high
                    let yaw_abs = Math.abs(white_rabbit.robot_data.yaw_to_waypoint);
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

                    let vision_speed_scale = get_vision_speed_scale(white_rabbit);
                    let memory_speed_mul   = white_rabbit.memory_watchdog ? white_rabbit.memory_watchdog.get_speed_multiplier(white_rabbit) : 1.0;
                    // Learning: persistent target_speed bias × proximity-to-risk-zone slowdown.
                    let learning_speed_mul = 1.0;
                    if (white_rabbit.learning && typeof white_rabbit.learning.effective_tuning === 'function') {
                        let lt = white_rabbit.learning.effective_tuning();
                        let risk = white_rabbit.learning.nearby_risk_factor(white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude);
                        learning_speed_mul = lt.target_speed_mul * risk;
                    }
                    // Heart: the synthesizing layer's speed_bias, folded in via the same min-cascade.
                    let heart_speed_bias = heart_guide ? heart_guide.speed_bias : 1.0;
                    let target_speed_cmd = Math.max(35, Math.round(200 * Math.min(yaw_speed_scale, distance_speed_scale, vision_speed_scale, memory_speed_mul, learning_speed_mul, heart_speed_bias)));

                    let mission_yaw_abs = Math.abs(white_rabbit.robot_data.yaw_to_waypoint);
                    let mission_yaw_start_deg = nav_tuning.mission_yaw_start_deg;
                    let mission_yaw_stop_deg = nav_tuning.mission_yaw_stop_deg;
                    let mission_yaw_should_run = white_rabbit.mission.nav_control.mission_yaw_active
                        ? mission_yaw_abs > mission_yaw_stop_deg || white_rabbit.mission.nav_control.mission_yaw_aligned_count < nav_tuning.mission_yaw_stable_cycles
                        : mission_yaw_abs > mission_yaw_start_deg;

                    if (mission_yaw_should_run) {
                        white_rabbit.mission.nav_control.mission_yaw_active = true;

                        if (mission_yaw_abs <= mission_yaw_stop_deg) {
                            white_rabbit.mission.nav_control.mission_yaw_aligned_count += 1;
                            white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "run_mission yaw_hold");
                            white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "run_mission yaw_hold");
                            white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "run_mission yaw_hold");
                            white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "run_mission yaw_hold");
                        }
                        else if (white_rabbit.motor.current_steering_type != "four_wheels") {
                            white_rabbit.mission.nav_control.mission_yaw_aligned_count = 0;
                            white_rabbit.motor.current_steering_type = "four_wheels";
                            white_rabbit.mission.pause_mission = true;
                            //stop white_rabbit
                            white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "pause_mission");
                            white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "pause_mission");
                            white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "pause_mission");
                            white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "pause_mission");
                            setTimeout(() => {
                                white_rabbit.mission.pause_mission = false;

                            }, 500);

                        }
                        else {
                            white_rabbit.mission.nav_control.mission_yaw_aligned_count = 0;

                            let yaw_speed_cmd = Math.round(mission_yaw_abs * nav_tuning.mission_yaw_gain);
                            if (mission_yaw_abs < nav_tuning.mission_yaw_brake_window_deg) {
                                let brake_scale = Math.max(0.35, mission_yaw_abs / nav_tuning.mission_yaw_brake_window_deg);
                                yaw_speed_cmd = Math.round(yaw_speed_cmd * brake_scale);
                            }

                            yaw_speed_cmd = Math.max(nav_tuning.mission_yaw_min_speed, yaw_speed_cmd);
                            yaw_speed_cmd = Math.min(nav_tuning.mission_yaw_max_speed, yaw_speed_cmd);

                            white_rabbit.yaw_white_rabbit(white_rabbit, white_rabbit.robot_data.yaw_to_waypoint, yaw_speed_cmd);
                        }
                    }
                    else {
                        white_rabbit.mission.nav_control.mission_yaw_active = false;
                        white_rabbit.mission.nav_control.mission_yaw_aligned_count = 0;


                        if (white_rabbit.motor.current_steering_type == "four_wheels") {
                            white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
                            white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
                            white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
                            white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);

                            //stop the white_rabbit	

                            white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "run_mission");
                            white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "run_mission");
                            white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "run_mission");
                            white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "run_mission");

                            if (white_rabbit.servos.motor_front_driver.set_pwm > 1400 && white_rabbit.servos.motor_front_driver.set_pwm < 1600 &&
                                white_rabbit.servos.motor_back_driver.set_pwm > 1400 && white_rabbit.servos.motor_back_driver.set_pwm < 1600 &&
                                white_rabbit.servos.motor_front_passenger.set_pwm > 1400 && white_rabbit.servos.motor_front_passenger.set_pwm < 1600 &&
                                white_rabbit.servos.motor_back_passenger.set_pwm > 1400 && white_rabbit.servos.motor_back_passenger.set_pwm < 1600) {
                                white_rabbit.motor.current_steering_type = "two_wheels";
                                white_rabbit.mission.nav_control.last_two_wheel_steering_deg = 0;
                            }
                        } else if (white_rabbit.motor.current_steering_type == "two_wheels") {



                            //move forward towards waypoint
                            if (distance_to_waypoint_meters > adaptive_arrival_radius_m) {

                                if (white_rabbit.rplidar.avoid_object) {
                                    if (white_rabbit.zones[10].light == "yellow" && white_rabbit.zones[10].distance_mm) {
                                        motor_speed_cmd = Math.min(target_speed_cmd, white_rabbit.calc_speed_based_on_distance(white_rabbit.zones[10], white_rabbit.zones[10].distance_mm));
                                    }
                                    else if (white_rabbit.zones[11].light == "yellow" && white_rabbit.zones[11].distance_mm) {
                                        motor_speed_cmd = Math.min(target_speed_cmd, white_rabbit.calc_speed_based_on_distance(white_rabbit.zones[11], white_rabbit.zones[11].distance_mm));
                                    }
                                    else {
                                        motor_speed_cmd = white_rabbit.throttle_up(white_rabbit, target_speed_cmd);
                                    }
                                }
                                else {
                                    motor_speed_cmd = white_rabbit.throttle_up(white_rabbit, target_speed_cmd);
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

                            if (Math.abs(white_rabbit.robot_data.yaw_to_waypoint) > 25) {

                                //currently not being used lower yaw to waypoint value to enable
                                var steering_and_rpm = white_rabbit.calc_steering_and_rpm(white_rabbit, white_rabbit.robot_data.yaw_to_waypoint / 3, motor_speed_cmd);

                                //console.log("Steering Angles: ", steering_and_rpm.servo_angles_deg);
                                //console.log("Motor RPMs: ", steering_and_rpm.motor_rpm);

                                white_rabbit.servo_send_command(white_rabbit, 11, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_driver).servo1, true);
                                white_rabbit.servo_send_command(white_rabbit, 13, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_passenger).servo2, true);
                                white_rabbit.servo_send_command(white_rabbit, 12, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_driver).servo2, true);
                                white_rabbit.servo_send_command(white_rabbit, 14, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_passenger).servo1, true);

                                //All wheel drive logic

                                //front passenger
                                white_rabbit.move_white_rabbit(white_rabbit, 1, steering_and_rpm.motor_rpm.front_passenger, "run_mission all wheel");
                                //rear passenger side
                                white_rabbit.move_white_rabbit(white_rabbit, 2, steering_and_rpm.motor_rpm.back_passenger, "run_mission all wheel");
                                //front driver side
                                white_rabbit.move_white_rabbit(white_rabbit, 3, steering_and_rpm.motor_rpm.front_driver, "run_mission all wheel");
                                //rear driver side
                                white_rabbit.move_white_rabbit(white_rabbit, 4, steering_and_rpm.motor_rpm.back_driver, "run_mission all wheel");

                            } else {

                                //steer towards waypoint complete, move forward

                                // Vision is a simple bounded correction layered on GPS — no seeking
                                // state machine, no carrot, no path-map fusion, no sidewalk voice events.
                                let _follow_sw = follow_sidewalk_enabled(white_rabbit);

                                // GPS heading to the RAW waypoint — no vision carrot. GPS picks the
                                // direction to the waypoint; vision only nudges us to stay centered.
                                let nav_bearing = white_rabbit.get_bearing(white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude, waypoint.latitude, waypoint.longitude);
                                let nav_yaw = (nav_bearing - white_rabbit_heading + 360) % 360;
                                if (nav_yaw > 180) nav_yaw -= 360;

                                // Crosstrack uses the actual waypoint (not the carrot) — the carrot is only ~1.5 m
                                // ahead of the white_rabbit, which would collapse the prev→target baseline.
                                let crosstrack_bias_deg = get_gps_crosstrack_bias_deg(white_rabbit, waypoint.latitude, waypoint.longitude);

                                // Fade crosstrack to zero in the last 1 m; GPS owns the turn
                                let vision_scale = distance_to_waypoint_meters < 1.0
                                    ? clamp(distance_to_waypoint_meters / 1.0, 0, 1)
                                    : 1.0;

                                // ── Vision correction: a bounded nudge from the camera's X-axis angle ──
                                // This is the ONLY thing the camera contributes to steering.
                                // x_angle_deg is now the angle to the rover's desired track position —
                                // 1.5 ft off the nearest sidewalk EDGE, measured ~2 ft ahead (see
                                // _compute_edge_guidance in realsense_vision.py). The edge is the guiding key.
                                //   x_angle_deg > 0 → desired position is to the right → steer right
                                //   x_angle_deg < 0 → desired position is to the left  → steer left
                                // When no edge is in view the Python side drops confidence below
                                // threshold, so the latch/fade below holds the last good correction
                                // briefly, then fades to GPS-only.
                                // Flip the sign of sidewalk_steer_gain if it ever steers the wrong way.
                                let _vis_cfg = white_rabbit.realsense && white_rabbit.realsense.vision;
                                let _det     = white_rabbit.realsense && white_rabbit.realsense.path_detection;
                                let _sw_gain  = (_vis_cfg && typeof _vis_cfg.sidewalk_steer_gain === 'number')    ? _vis_cfg.sidewalk_steer_gain    : 0.4;
                                let _sw_max   = (_vis_cfg && typeof _vis_cfg.sidewalk_steer_max_deg === 'number') ? _vis_cfg.sidewalk_steer_max_deg : 8;
                                let _sw_conf  = (_vis_cfg && typeof _vis_cfg.edge_confidence_min === 'number')   ? _vis_cfg.edge_confidence_min   : 0.5;
                                let _edge_max_forward_m = (_vis_cfg && typeof _vis_cfg.edge_correction_max_forward_m === 'number')
                                    ? _vis_cfg.edge_correction_max_forward_m
                                    : 1.0;
                                _sw_conf = Math.max(0.5, Math.min(1.0, _sw_conf));
                                _edge_max_forward_m = Math.max(0.1, _edge_max_forward_m);
                                let _edge_straight_yaw_deg = (_vis_cfg && typeof _vis_cfg.edge_straight_leg_max_yaw_deg === 'number')
                                    ? _vis_cfg.edge_straight_leg_max_yaw_deg
                                    : 15;
                                let _edge_max_offset_straight_m = (_vis_cfg && typeof _vis_cfg.edge_max_offset_straight_m === 'number')
                                    ? _vis_cfg.edge_max_offset_straight_m
                                    : 1.0;
                                let _sw_stale = (_vis_cfg && typeof _vis_cfg.stale_detection_ms === 'number')     ? _vis_cfg.stale_detection_ms     : 1200;
                                let _sw_latch = (_vis_cfg && typeof _vis_cfg.sidewalk_latch_ms === 'number')      ? _vis_cfg.sidewalk_latch_ms      : 1500;
                                let _sw_fade  = (_vis_cfg && typeof _vis_cfg.sidewalk_fade_ms === 'number')       ? _vis_cfg.sidewalk_fade_ms       : 1000;

                                // Vision authority (0..1): how much the camera owns lateral control this
                                // tick. It LATCHES through brief detection dropouts and FADES rather than
                                // snapping, so flicker can't toggle vision/crosstrack on and off (which
                                // would cause lateral jitter). Crosstrack and the vision correction
                                // crossfade against this single value, so they always sum smoothly.
                                let _nc = white_rabbit.mission.nav_control;
                                let _now = Date.now();
                                let _dt = _nc.sidewalk_auth_ts ? Math.min(1000, _now - _nc.sidewalk_auth_ts) : 250;
                                _nc.sidewalk_auth_ts = _now;

                                let _edge_offset_m = (_det && typeof _det.edge_target_offset_m === 'number')
                                    ? _det.edge_target_offset_m
                                    : ((_det && typeof _det.offset_meters === 'number') ? _det.offset_meters : 0);
                                let _edge_forward_m = (_det && typeof _det.edge_forward_m === 'number') ? _det.edge_forward_m : null;
                                let _edge_forward_valid = (_edge_forward_m !== null && _edge_forward_m <= _edge_max_forward_m);
                                let _straight_leg = Math.abs(nav_yaw) <= _edge_straight_yaw_deg;
                                // Straight-leg guard: if edge guidance says we're >1 m off the desired
                                // track, let GPS reclaim authority toward the waypoint line.
                                let _edge_out_of_lane = (_follow_sw && _straight_leg && Math.abs(_edge_offset_m) > _edge_max_offset_straight_m);

                                // pitch_stream_ok guards against a silent failure where Python's
                                // stdin pipe broke — it keeps running but depth is computed with
                                // stale attitude, corrupting lateral positions and edge offsets.
                                // When the stream is dead, authority fades to zero and GPS crosstrack
                                // takes over — no corrupted corrections reach the steering layer.
                                let _pitch_ok = white_rabbit.realsense.pitch_stream_ok !== false;
                                let vision_fresh = (_follow_sw && _det && typeof _det.x_angle_deg === 'number'
                                    && typeof _det.confidence === 'number' && _det.confidence >= _sw_conf
                                    && _det.timestamp && (_now - _det.timestamp) < _sw_stale
                                    && _edge_forward_valid
                                    && (_det.left_boundary_visible || _det.right_boundary_visible)
                                    && !_edge_out_of_lane
                                    && _pitch_ok);
                                if (vision_fresh) {
                                    _nc.sidewalk_last_good_ts = _now;
                                    // Hold the most recent correction so a dropped frame keeps steering steady.
                                    _nc.sidewalk_last_corr_deg = clamp(_sw_gain * _det.x_angle_deg, -_sw_max, _sw_max);
                                }
                                // Latch: stay at full authority for sidewalk_latch_ms after the last good frame.
                                let _within_latch = _nc.sidewalk_last_good_ts && (_now - _nc.sidewalk_last_good_ts) < _sw_latch;
                                let _auth_target = (vision_fresh || _within_latch) ? 1 : 0;
                                if (_edge_out_of_lane) _auth_target = 0;

                                // Fade authority toward the target over sidewalk_fade_ms (both directions).
                                let _step = _sw_fade > 0 ? (_dt / _sw_fade) : 1;
                                if (typeof _nc.sidewalk_authority !== 'number') _nc.sidewalk_authority = 0;
                                if (_auth_target > _nc.sidewalk_authority) _nc.sidewalk_authority = Math.min(_auth_target, _nc.sidewalk_authority + _step);
                                else                                       _nc.sidewalk_authority = Math.max(_auth_target, _nc.sidewalk_authority - _step);

                                let vision_authority = _nc.sidewalk_authority;
                                let vision_active = vision_authority > 0.01;
                                let vision_correction_deg = (_nc.sidewalk_last_corr_deg || 0) * vision_authority;

                                // Memory watchdog: dampen steering when the white_rabbit is wobbling
                                // (yaw_to_waypoint sign-flipping over the last 3 s).
                                let osc_adj = white_rabbit.memory_watchdog
                                    ? white_rabbit.memory_watchdog.get_steering_adjustments(white_rabbit)
                                    : { deadband_boost_deg: 0, gain_multiplier: 1.0 };
                                // Learning: long-running steering gain bias from past oscillation events.
                                let learning_gain_mul = (white_rabbit.learning && typeof white_rabbit.learning.effective_tuning === 'function')
                                    ? white_rabbit.learning.effective_tuning().yaw_steering_gain_mul
                                    : 1.0;
                                let effective_steering_gain     = nav_tuning.two_wheel_steering_gain         * osc_adj.gain_multiplier * learning_gain_mul;
                                let effective_steering_deadband = nav_tuning.two_wheel_steering_deadband_deg + osc_adj.deadband_boost_deg;

                                // GPS crosstrack pulls back onto the prev→target line — the term that
                                // fights vision (GPS wants its line, vision wants the sidewalk center).
                                // Crossfade it against vision_authority: at full authority crosstrack is 0
                                // (camera owns lateral), and as vision fades out crosstrack fades back in
                                // over the same window — no snap, so the two systems can't jitter-fight.
                                let crosstrack_term = crosstrack_bias_deg * vision_scale * (1 - vision_authority);
                                let steering_target_deg = (nav_yaw * effective_steering_gain) + crosstrack_term + vision_correction_deg;
                                let steering_target_abs = Math.abs(steering_target_deg);
                                if (steering_target_abs < effective_steering_deadband) {
                                    steering_target_deg = 0;
                                } else {
                                    steering_target_deg = Math.sign(steering_target_deg) * Math.min(nav_tuning.two_wheel_max_steering_deg, steering_target_abs);
                                }

                                let steering_delta_deg = steering_target_deg - white_rabbit.mission.nav_control.last_two_wheel_steering_deg;
                                if (steering_delta_deg > nav_tuning.two_wheel_max_steering_delta_deg) steering_delta_deg = nav_tuning.two_wheel_max_steering_delta_deg;
                                if (steering_delta_deg < nav_tuning.two_wheel_max_steering_delta_deg * -1) steering_delta_deg = nav_tuning.two_wheel_max_steering_delta_deg * -1;

                                let commanded_steering_deg = white_rabbit.mission.nav_control.last_two_wheel_steering_deg + steering_delta_deg;
                                white_rabbit.mission.nav_control.last_two_wheel_steering_deg = commanded_steering_deg;

                                // 1 Hz steering decision log — GPS heading + bounded vision correction
                                let _x_angle_log = (_det && typeof _det.x_angle_deg === 'number') ? _det.x_angle_deg.toFixed(1) : '--';
                                let _conf_log    = (_det && typeof _det.confidence === 'number') ? _det.confidence.toFixed(2) : '--';
                                log_carrot_decision(white_rabbit,
                                    'dist_to_wp=' + distance_to_waypoint_meters.toFixed(2) + 'm'
                                    + ' | nav_yaw=' + nav_yaw.toFixed(1) + '°'
                                    + ' crosstrack=' + crosstrack_bias_deg.toFixed(1) + '° (' + (vision_active ? 'suppressed' : 'active') + ')'
                                    + ' | vision x_angle=' + _x_angle_log + '° conf=' + _conf_log + ' min=' + _sw_conf.toFixed(2)
                                    + ' edge_off=' + _edge_offset_m.toFixed(2) + 'm'
                                    + ' edge_fwd=' + (_edge_forward_m !== null ? _edge_forward_m.toFixed(2) : '--') + 'm/' + _edge_max_forward_m.toFixed(2) + 'm'
                                    + (_edge_out_of_lane ? ' (gps_recenter)' : '') + (!_edge_forward_valid ? ' (edge_too_far)' : '')
                                    + ' corr=' + vision_correction_deg.toFixed(1) + '° auth=' + vision_authority.toFixed(2)
                                    + ' | speed_scale=' + vision_speed_scale.toFixed(2) + ' target_speed=' + target_speed_cmd
                                    + ' | steer_target=' + steering_target_deg.toFixed(1) + '° cmd=' + commanded_steering_deg.toFixed(1) + '°');

                                var steer_pwm = white_rabbit.angle_to_pwm(commanded_steering_deg);
                                white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
                                white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);
                                white_rabbit.servo_send_command(white_rabbit, 11, steer_pwm.servo1, true);
                                white_rabbit.servo_send_command(white_rabbit, 13, steer_pwm.servo2, true);

                                white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd * -1, "run_mission 2 wheel");
                                white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd, "run_mission 2 wheel");
                                white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd, "run_mission 2 wheel");
                                white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd * -1, "run_mission 2 wheel");
                            }

                        }
                    }

                }
                else {
                    if (!white_rabbit.mission.package_delivered) {
                        white_rabbit.yaw_white_rabbit_for_package_delivery(white_rabbit);
                        white_rabbit.logs.run_mission.log(white_rabbit, "At drop-off: yaw_white_rabbit_for_package_delivery");
                    }
                    else {
                        console.log("Mission Finished. No waypoint data available.");
                        white_rabbit.logs.run_mission.log(white_rabbit, "Mission Finished. No waypoint data available.");
                        clearInterval(white_rabbit.mission.mission_interval);
                    }
                }
            }
            else {
                console.log("Mission paused.");
                white_rabbit.logs.run_mission.log(white_rabbit, "Mission paused.");
            }

        }
    } else {
        //console.log("White_rabbit is disarmed.");
        white_rabbit.logs.run_mission.log(white_rabbit, "White_rabbit is disarmed");
    };

}


module.exports = run_mission;