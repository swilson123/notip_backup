const get_roll     = require('../navigation/get_roll');

// Shifts the raw GPS position (mounted at Noah's front) backward along the current
// heading to estimate the rover's center position. The offset distance is
// nav_tuning.gps_forward_offset_m (default 0.3556 m = 14 inches).
function apply_gps_center_offset(white_rabbit) {
    const offset_m = (white_rabbit.nav_tuning && white_rabbit.nav_tuning.gps_forward_offset_m) || 0;
    if (!offset_m) return;
    const heading_deg = white_rabbit.get_heading(white_rabbit);
    if (typeof heading_deg !== 'number') return;
    const raw_lat = white_rabbit.robot_data.robot_latitude;
    const raw_lng = white_rabbit.robot_data.robot_longitude;
    if (!raw_lat || !raw_lng) return;
    // Move backward along heading (opposite direction = +180°)
    const bearing_rad = ((heading_deg + 180) % 360) * Math.PI / 180;
    const R = 6371000;
    const lat_rad = raw_lat * Math.PI / 180;
    white_rabbit.robot_data.robot_latitude  = raw_lat + (offset_m * Math.cos(bearing_rad) / R) * (180 / Math.PI);
    white_rabbit.robot_data.robot_longitude = raw_lng + (offset_m * Math.sin(bearing_rad) / (R * Math.cos(lat_rad))) * (180 / Math.PI);
}

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


// Module-level log throttles.
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

// True when waypoint `seq` is a sidewalk-gate marker. Two independent triggers:
//   1. Sharp turn — the route turn here is at least nav_tuning.sidewalk_gate_turn_deg.
//   2. Close pair — this waypoint sits within nav_tuning.sidewalk_gate_pair_distance_m
//      of an adjacent waypoint. Placing two waypoints right next to each other
//      (same arrival bubble) is then the trigger, with no physical turn required.
// Either marks the road↔sidewalk boundary the same way.
function is_sidewalk_gate_waypoint(white_rabbit, seq, nav_tuning) {
    let gate_turn_deg = (typeof nav_tuning.sidewalk_gate_turn_deg === 'number') ? nav_tuning.sidewalk_gate_turn_deg : 90;
    if (waypoint_turn_deg(white_rabbit, seq) >= gate_turn_deg) return true;

    let pair_m = (typeof nav_tuning.sidewalk_gate_pair_distance_m === 'number') ? nav_tuning.sidewalk_gate_pair_distance_m : 1.0;
    if (pair_m <= 0 || !white_rabbit.mission || !Array.isArray(white_rabbit.mission.waypoints)) return false;

    let find = function (s) {
        for (let i = 0; i < white_rabbit.mission.waypoints.length; i++) {
            let wp = white_rabbit.mission.waypoints[i];
            if (wp.seq === s && wp.lat && wp.lng) return wp;
        }
        return null;
    };
    let here = find(seq);
    if (!here) return false;
    let prev = find(seq - 1), next = find(seq + 1);
    if (prev && white_rabbit.gps_distance(here.lat, here.lng, prev.lat, prev.lng) * 1000 <= pair_m) return true;
    if (next && white_rabbit.gps_distance(here.lat, here.lng, next.lat, next.lng) * 1000 <= pair_m) return true;
    return false;
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

        // Shift GPS (front-mounted) backward to Noah's center before all nav math.
        apply_gps_center_offset(white_rabbit);

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
                // camera's field of view, then hand off to 0 for precision docking.
                if (white_rabbit.mission.dock_return_phase) {
                    if (white_rabbit.mission.dock_return_phase === 'align_heading') {
                        const _undock_hdg = white_rabbit.dock.undock_heading;

                        // The point of yawing back to the undock heading is to bring the
                        // IRLock beacon into the camera's field of view (±30°). As soon as
                        // the light is detected and fresh, STOP yawing and hand off to
                        // docking — continuing toward the exact heading target turns Noah
                        // right past the beacon (the over-yaw seen in testing).
                        const _light_found = !!(white_rabbit.irlock && white_rabbit.irlock.detected
                            && white_rabbit.irlock_message_handler
                            && typeof white_rabbit.irlock_message_handler.is_fresh === 'function'
                            && white_rabbit.irlock_message_handler.is_fresh(white_rabbit));

                        // Shared handoff out of alignment → follow_the_light (or wait for
                        // an RC dock command first when manual docking is required).
                        const _begin_dock_handoff = function (reason) {
                            // Stop the spin before handing off so we don't carry yaw momentum
                            // into the IRLock approach.
                            white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'dock_handoff');
                            white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'dock_handoff');
                            white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'dock_handoff');
                            white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'dock_handoff');
                            white_rabbit.mission.dock_align_start_ts = null;

                            if (white_rabbit.dock.manual_dock_required && white_rabbit.dock.rc_dock >= 1100) {
                                white_rabbit.mission.dock_return_phase = 'await_dock_command';
                                white_rabbit.logs.run_mission.log(white_rabbit, 'dock return: ' + reason + ' — waiting for RC dock command');
                                if (white_rabbit.voice) white_rabbit.voice.say('Waiting for dock command.');
                                return;
                            }
                            white_rabbit.mission.dock_return_phase = 'docking';
                            white_rabbit.logs.run_mission.log(white_rabbit, 'dock return: ' + reason + ' — starting follow_the_light');
                            if (white_rabbit.voice) white_rabbit.voice.say('Looking for the light.');
                            white_rabbit.dock.dock_state   = null;
                            if (!white_rabbit.dock.dock_interval) {
                                white_rabbit.dock.dock_interval = setInterval(() => {
                                    white_rabbit.follow_the_light(white_rabbit);
                                }, 250);
                            }
                        };

                        if (_light_found) {
                            const _angle_x = white_rabbit.irlock.target ? white_rabbit.irlock.target.angle_x : null;
                            const _center_thresh = typeof nav_tuning.dock_center_angle_deg === 'number' ? nav_tuning.dock_center_angle_deg : 5;
                            if (_angle_x !== null && Math.abs(_angle_x) > _center_thresh) {
                                // Light visible but not centered — keep spinning toward it.
                                let _yaw_speed = clamp(Math.round(Math.abs(_angle_x) * 0.5), 10, 18);
                                white_rabbit.yaw_white_rabbit(white_rabbit, _angle_x, _yaw_speed);
                                white_rabbit.logs.run_mission.log(white_rabbit, 'dock align: centering beacon angle_x=' + _angle_x.toFixed(1) + '° (threshold=' + _center_thresh + '°)');
                                return;
                            }
                            _begin_dock_handoff('beacon centered (angle_x='
                                + (_angle_x !== null ? _angle_x.toFixed(1) : '?') + '°)');
                            return;
                        }

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
                                    _begin_dock_handoff('heading aligned (' + _cur_hdg.toFixed(1) + '°)');
                                } else {
                                    // Proportional yaw speed: slow down as we approach the
                                    // target so the spin doesn't overshoot the beacon or the
                                    // heading. Clamped to a usable spin range.
                                    let _yaw_speed = clamp(Math.round(Math.abs(_hdg_err) * 0.5), 10, 18);
                                    white_rabbit.yaw_white_rabbit(white_rabbit, _hdg_err, _yaw_speed);
                                }
                            }
                        }
                        return;
                    }
                    if (white_rabbit.mission.dock_return_phase === 'await_dock_command') {
                        if (white_rabbit.dock.rc_dock < 1100) {
                            white_rabbit.dock.manual_dock_required = false;
                            white_rabbit.mission.dock_return_phase = 'docking';
                            white_rabbit.logs.run_mission.log(white_rabbit, 'dock return: RC dock command received — starting follow_the_light');
                            if (white_rabbit.voice) white_rabbit.voice.say('Dock command received. Looking for the light.');
                            white_rabbit.dock.dock_state   = null;
                            if (!white_rabbit.dock.dock_interval) {
                                white_rabbit.dock.dock_interval = setInterval(() => {
                                    white_rabbit.follow_the_light(white_rabbit);
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
                        // follow_the_light handles motors; watch for completion to end the mission loop.
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
                let white_rabbit_heading = white_rabbit.get_heading(white_rabbit);
                let motor_speed_cmd = 0;


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
                        mission_yaw_aligned_count: 0
                    };
                }

                // Yellow Brick Road — sidewalk edge following takes full control when gate is open
                if (follow_sidewalk_enabled(white_rabbit)) {

                    // Reset edge trail on first return tick so outbound x-values don't persist
                    if (white_rabbit.mission.package_delivered && !white_rabbit.mission.return_trail_reset) {
                        white_rabbit.mission.return_trail_reset = true;
                        if (white_rabbit.edge_trail) white_rabbit.edge_trail.start();
                    }
                    // Yield delivery to GPS nav: FTYBR advances seq past max when Noah
                    // arrives within 1m of the delivery WP. Once that happens, drop through
                    // so the GPS nav else-branch fires yaw_for_package_delivery.
                    let _yield_delivery = false;
                    if (!white_rabbit.mission.package_delivered) {
                        let _max_seq = 0;
                        for (let _i = 0; _i < white_rabbit.mission.waypoints.length; _i++) {
                            if (white_rabbit.mission.waypoints[_i].seq > _max_seq) _max_seq = white_rabbit.mission.waypoints[_i].seq;
                        }
                        _yield_delivery = _max_seq > 0 && white_rabbit.mission.current_mission_seq > _max_seq;
                    }
                    if (!_yield_delivery) {
                        white_rabbit.follow_the_yellow_brick_road(white_rabbit);
                        return;
                    }
                }

                //What is the next waypoint?
                let waypoint = { seq: null, latitude: null, longitude: null };

                if (white_rabbit.mission.package_delivered) {
                    //reverse through waypoints to return to dock after delivery
                    for (let i = white_rabbit.mission.waypoints.length - 1; i >= 0; i--) {

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
                    if (white_rabbit.mission.current_mission_seq <= 1
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

                    let _max_wp_seq = 0;
                    if (Array.isArray(white_rabbit.mission.waypoints)) {
                        for (let _wi = 0; _wi < white_rabbit.mission.waypoints.length; _wi++) {
                            if (white_rabbit.mission.waypoints[_wi].seq > _max_wp_seq) _max_wp_seq = white_rabbit.mission.waypoints[_wi].seq;
                        }
                    }
                    let _is_dock_return_wp = white_rabbit.mission.package_delivered
                        && white_rabbit.mission.current_mission_seq <= 1
                        && white_rabbit.dock && white_rabbit.dock.undock_latitude;
                    let _is_delivery_wp = !white_rabbit.mission.package_delivered
                        && _max_wp_seq > 0
                        && white_rabbit.mission.current_mission_seq === _max_wp_seq;
                    let adaptive_arrival_radius_m = _is_dock_return_wp
                        ? (typeof nav_tuning.arrival_radius_dock_m === 'number' ? nav_tuning.arrival_radius_dock_m : 0.1)
                        : _is_delivery_wp
                        ? (typeof nav_tuning.arrival_radius_delivery_m === 'number' ? nav_tuning.arrival_radius_delivery_m : 0.1)
                        : (typeof nav_tuning.arrival_radius_waypoint_m === 'number' ? nav_tuning.arrival_radius_waypoint_m : 0.5);

                    // Prepare the next navigation target for smooth roll-through blending.
                    let next_nav_target = null;
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

                    //Require being inside arrival radius for multiple cycles to reduce GPS jitter false positives
                    if (white_rabbit.mission.nav_accuracy.waypoint_seq !== waypoint.seq) {
                        white_rabbit.mission.nav_accuracy.waypoint_seq = waypoint.seq;
                        white_rabbit.mission.nav_accuracy.inside_radius_count = 0;
                    }

                    if (white_rabbit.mission.nav_control.waypoint_seq !== waypoint.seq) {
                        white_rabbit.mission.nav_control.waypoint_seq = waypoint.seq;
                        white_rabbit.mission.nav_control.last_two_wheel_steering_deg = 0;
                        // If the delivery yaw already aligned Noah toward the return waypoint,
                        // treat him as stable so GPS drift from spinning doesn't trigger a second spin.
                        let _post_delivery = white_rabbit.mission.package_delivered && white_rabbit.mission.finished_package_yaw
                            && white_rabbit.mission._post_delivery_yaw_carry;
                        white_rabbit.mission._post_delivery_yaw_carry = false;
                        white_rabbit.mission.nav_control.mission_yaw_active = _post_delivery;
                        white_rabbit.mission.nav_control.mission_yaw_aligned_count = _post_delivery ? (nav_tuning.mission_yaw_stable_cycles || 3) : 0;
                    }

                    // ----- Overshoot capture -----
                    // If we're close to the target but its true bearing has slipped >90° off our
                    // heading, we've physically driven PAST it. Re-facing an overshot point means
                    // spinning in place, and GPS bearing is unstable this close — which made Noah
                    // spin a full 360° at the delivery waypoint before arriving. Treat a confirmed
                    // pass as arrival so the next tick proceeds (deliver / next leg) immediately,
                    // rather than waiting out a consecutive-tick debounce the overshoot skips past.
                    let _capture_m = (typeof nav_tuning.overshoot_capture_m === 'number')
                        ? nav_tuning.overshoot_capture_m
                        : Math.max(1.0, adaptive_arrival_radius_m * 2);
                    let _bearing_to_wp = white_rabbit.get_bearing(
                        white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude,
                        waypoint.latitude, waypoint.longitude);
                    let _bearing_err = Math.abs(((_bearing_to_wp - white_rabbit_heading + 540) % 360) - 180);
                    let _overshot = distance_to_waypoint_meters <= _capture_m && _bearing_err > 90;

                    if (distance_to_waypoint_meters <= adaptive_arrival_radius_m || _overshot) {
                        white_rabbit.mission.nav_accuracy.inside_radius_count += 1;
                    } else {
                        white_rabbit.mission.nav_accuracy.inside_radius_count = 0;
                    }
                    if (_overshot) {
                        white_rabbit.mission.nav_accuracy.inside_radius_count = white_rabbit.mission.nav_accuracy.required_inside_radius_count;
                        white_rabbit.logs.run_mission.log(white_rabbit,
                            'overshoot capture: passed waypoint ' + waypoint.seq + ' (dist=' + distance_to_waypoint_meters.toFixed(2)
                            + 'm bearing_err=' + _bearing_err.toFixed(0) + '°) — treating as reached');
                    }

                    //At waypoint: advance sequence immediately to avoid GPS jitter causing yaw direction flips
                    if (white_rabbit.mission.nav_accuracy.inside_radius_count >= white_rabbit.mission.nav_accuracy.required_inside_radius_count) {
                        white_rabbit.mission.nav_accuracy.inside_radius_count = 0;
                        white_rabbit.logs.run_mission.log(white_rabbit, "waypoint reached: " + white_rabbit.mission.current_mission_seq);

                        // ----- Sidewalk-following gate -----
                        // A gate waypoint marks the boundary between road/driveway and sidewalk:
                        // either a >=sidewalk_gate_turn_deg route turn OR a deliberate close pair of
                        // waypoints (see is_sidewalk_gate_waypoint). Reaching it OUTBOUND turns
                        // sidewalk-following ON; reaching it on the RETURN turns it OFF. Everywhere
                        // else the camera doesn't steer, so driveways and roads stop producing
                        // sidewalk false positives.
                        if (is_sidewalk_gate_waypoint(white_rabbit, white_rabbit.mission.current_mission_seq, nav_tuning)) {
                            if (!white_rabbit.mission.package_delivered) {
                                if (!white_rabbit.mission.sidewalk_follow_active && !white_rabbit.mission.sidewalk_gate_pending) {
                                    // Don't open yet — wait until Noah completes the yaw to face the sidewalk.
                                    // Opening early lets the camera see the road/driveway scene and steer the wrong way.
                                    white_rabbit.mission.sidewalk_gate_pending = true;
                                    white_rabbit.logs.run_mission.log(white_rabbit, 'sidewalk gate: pending yaw alignment at waypoint ' + white_rabbit.mission.current_mission_seq);
                                }
                            } else {
                                if (white_rabbit.mission.sidewalk_follow_active) {
                                    white_rabbit.mission.sidewalk_follow_active = false;
                                    white_rabbit.logs.run_mission.log(white_rabbit, 'sidewalk gate: returned to marker at waypoint ' + white_rabbit.mission.current_mission_seq + ' — sidewalk following OFF');
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

                    // Heading to current target, optionally blended toward next target for smooth roll-through.
                    let waypoint_bearing = white_rabbit.get_bearing(
                        white_rabbit.robot_data.robot_latitude,
                        white_rabbit.robot_data.robot_longitude,
                        waypoint.latitude,
                        waypoint.longitude
                    );

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
                                let blend_den = Math.max(0.05, turn_entry_m);
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
                    let target_speed_cmd = Math.max(35, Math.round(200 * Math.min(yaw_speed_scale, distance_speed_scale, memory_speed_mul, learning_speed_mul, heart_speed_bias)));

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
                            white_rabbit.servo_send_command(white_rabbit, 11, 1500, true);
                            white_rabbit.servo_send_command(white_rabbit, 13, 1500, true);
                            white_rabbit.servo_send_command(white_rabbit, 12, 1500, true);
                            white_rabbit.servo_send_command(white_rabbit, 14, 1500, true);

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

                                // Noah is now facing the sidewalk — safe to open the gate.
                                if (white_rabbit.mission.sidewalk_gate_pending) {
                                    white_rabbit.mission.sidewalk_gate_pending = false;
                                    white_rabbit.mission.sidewalk_follow_active = true;
                                    if (white_rabbit.edge_trail) white_rabbit.edge_trail.start();
                                    white_rabbit.logs.run_mission.log(white_rabbit, 'sidewalk gate: yaw complete — sidewalk following ON');
                                    if (white_rabbit.voice) white_rabbit.voice.say_event('sidewalk_on');
                                }
                            }
                        } else if (white_rabbit.motor.current_steering_type == "two_wheels") {

                            // Gate open: Noah was already aligned (no 4-wheel yaw), so the
                            // four_wheels→two_wheels transition that normally opens the gate never ran.
                            if (white_rabbit.mission.sidewalk_gate_pending) {
                                white_rabbit.mission.sidewalk_gate_pending = false;
                                white_rabbit.mission.sidewalk_follow_active = true;
                                if (white_rabbit.edge_trail) white_rabbit.edge_trail.start();
                                white_rabbit.logs.run_mission.log(white_rabbit, 'sidewalk gate: already aligned — sidewalk following ON');
                                if (white_rabbit.voice) white_rabbit.voice.say_event('sidewalk_on');
                            }

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

                            if (Math.abs(white_rabbit.robot_data.yaw_to_waypoint) > 90 && !follow_sidewalk_enabled(white_rabbit)) {

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

                                //steer towards waypoint

                                let nav_bearing = white_rabbit.get_bearing(white_rabbit.robot_data.robot_latitude, white_rabbit.robot_data.robot_longitude, waypoint.latitude, waypoint.longitude);
                                let nav_yaw = (nav_bearing - white_rabbit_heading + 360) % 360;
                                if (nav_yaw > 180) nav_yaw -= 360;

                                let crosstrack_bias_deg = get_gps_crosstrack_bias_deg(white_rabbit, waypoint.latitude, waypoint.longitude);
                                let crosstrack_scale = distance_to_waypoint_meters < 1.0 ? clamp(distance_to_waypoint_meters / 1.0, 0, 1) : 1.0;
                                let crosstrack_term = crosstrack_bias_deg * crosstrack_scale;

                                let osc_adj = white_rabbit.memory_watchdog
                                    ? white_rabbit.memory_watchdog.get_steering_adjustments(white_rabbit)
                                    : { deadband_boost_deg: 0, gain_multiplier: 1.0 };
                                let learning_gain_mul = (white_rabbit.learning && typeof white_rabbit.learning.effective_tuning === 'function')
                                    ? white_rabbit.learning.effective_tuning().yaw_steering_gain_mul
                                    : 1.0;
                                let effective_steering_gain     = nav_tuning.two_wheel_steering_gain         * osc_adj.gain_multiplier * learning_gain_mul;
                                let effective_steering_deadband = nav_tuning.two_wheel_steering_deadband_deg + osc_adj.deadband_boost_deg;

                                let steering_target_deg = (nav_yaw * effective_steering_gain) + crosstrack_term;
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

                                var steer4 = white_rabbit.calc_steering_and_rpm(white_rabbit, commanded_steering_deg, 0);
                                white_rabbit.servo_send_command(white_rabbit, 11, white_rabbit.angle_to_pwm(steer4.servo_angles_deg.front_driver).servo1, true);
                                white_rabbit.servo_send_command(white_rabbit, 13, white_rabbit.angle_to_pwm(steer4.servo_angles_deg.front_passenger).servo2, true);
                                white_rabbit.servo_send_command(white_rabbit, 12, white_rabbit.angle_to_pwm(steer4.servo_angles_deg.back_driver).servo2, true);
                                white_rabbit.servo_send_command(white_rabbit, 14, white_rabbit.angle_to_pwm(steer4.servo_angles_deg.back_passenger).servo1, true);

                                white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd * -1, "run_mission 4 wheel");
                                white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd, "run_mission 4 wheel");
                                white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd, "run_mission 4 wheel");
                                white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd * -1, "run_mission 4 wheel");
                            }

                        }
                    }

                }
                else {
                    if (!white_rabbit.mission.package_delivered) {
                        white_rabbit.yaw_white_rabbit_for_package_delivery(white_rabbit);
                        white_rabbit.logs.run_mission.log(white_rabbit, "At drop-off: yaw_white_rabbit_for_package_delivery");

                        // Completion safety net. Normally arduino_message_handler sets
                        // package_delivered when the Arduino reports auto_delivery -> 0.
                        // If that never comes (delivery sequence stalls on a missed limit
                        // switch, or the Arduino goes quiet), the rover would sit here
                        // forever — never returning, never stowing. Once delivery has run
                        // past delivery_timeout_ms, force completion: command the arm to
                        // stow AND start the return so Noah drives home while it stows.
                        let _deliv_timeout_ms = (typeof nav_tuning.delivery_timeout_ms === 'number') ? nav_tuning.delivery_timeout_ms : 45000;
                        if (white_rabbit.mission.finished_package_yaw
                            && white_rabbit.mission._delivery_sent_at
                            && (Date.now() - white_rabbit.mission._delivery_sent_at) > _deliv_timeout_ms) {
                            white_rabbit.logs.run_mission.log(white_rabbit, 'delivery timeout (' + _deliv_timeout_ms + 'ms) — stowing arm and returning to dock');
                            if (white_rabbit.voice) white_rabbit.voice.say('Delivery complete. Returning while I stow.');
                            if (typeof white_rabbit.create_arduino_message === 'function') {
                                white_rabbit.create_arduino_message(white_rabbit, 'stow_arm', 0);
                            }
                            if (white_rabbit.dock) {
                                white_rabbit.dock.awaiting_stow_ack = true;
                                white_rabbit.dock.stow_command_sent_at = Date.now();
                            }
                            white_rabbit.mission.auto_delivery = false;
                            white_rabbit.mission._delivery_sent_at = null;
                            white_rabbit.mission.package_delivered = true;
                            white_rabbit.mission.current_mission_seq = Math.max(1, (white_rabbit.mission.current_mission_seq || 0) - 2);
                        }
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