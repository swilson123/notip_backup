// Memory Watchdog — uses white_rabbit.memory to catch failure modes that no single
// tick can see, then either corrects or escalates.
//
//   A) Stuck detector + recovery
//        "Commanding > 20 speed but moved < 0.1 m for 2.5 s+" → reverse 1.2 s,
//        pause, retry. After two failed recoveries in a 10 s cooldown, escalate
//        by setting white_rabbit.mission.avoidance_timed_out so the existing
//        run_mission fallback block delivers from the last good waypoint.
//
//   B) Vision-trend pre-slowdown
//        Confidence below 0.7 AND dropping by >0.15 in the last 3 s →
//        an extra speed multiplier (0.6) folded into the run_mission cascade.
//        Catches sidewalk-loss before the existing absolute-threshold trip.
//
//   C) Yaw oscillation correction
//        yaw_to_waypoint sign-flipping ≥3 times in 3 s with average amplitude
//        > 4° → widen the steering deadband and ease the gain so the white_rabbit
//        settles instead of wobbling.
//
// Each watchdog is independent; any can be disabled via setup.json. None ever
// throws — a bad watchdog must not crash the white_rabbit.

const STUCK = {
    min_speed_cmd:       20,
    max_moved_m:         0.10,
    window_ms:           3000,
    min_span_ms:         2500,
    recovery_reverse_ms: 1200,
    recovery_pause_ms:   800,
    cooldown_ms:         10000,
    max_recoveries:      2
};

const VISION_TREND = {
    window_ms:        3000,
    drop_threshold:   0.15,
    max_confidence:   0.7,
    speed_multiplier: 0.6
};

const YAW_OSC = {
    window_ms:          3000,
    min_sign_changes:   3,
    min_amplitude_deg:  4,
    deadband_boost_deg: 3,
    gain_multiplier:    0.6
};

// ---------- helpers ----------

function safe_log(white_rabbit, msg) {
    if (white_rabbit.logs && white_rabbit.logs.run_mission && typeof white_rabbit.logs.run_mission.log === 'function') {
        white_rabbit.logs.run_mission.log(white_rabbit, msg);
    } else {
        console.log(msg);
    }
}

function config_for(white_rabbit) {
    return white_rabbit.memory_watchdog_config || {
        enabled:                 true,
        stuck_recovery_enabled:  true,
        vision_trend_enabled:    true,
        yaw_oscillation_enabled: true
    };
}

function init_state(white_rabbit) {
    if (!white_rabbit.mission.memory_watchdog) {
        white_rabbit.mission.memory_watchdog = {
            recovery_state:          null,   // null | 'reversing' | 'pause_post_reverse'
            recovery_start_ts:       0,
            recovery_pause_start_ts: 0,
            recovery_count:          0,
            last_recovery_ts:        0,
            last_vision_warn_ts:     0,
            last_osc_log_ts:         0
        };
    }
    return white_rabbit.mission.memory_watchdog;
}

// ---------- A: stuck detector + recovery ----------

function stuck_eligible(white_rabbit) {
    if (!white_rabbit.robot_data.is_armed)                                                 return false;
    if (white_rabbit.mission.pause_mission)                                                return false;
    if (!white_rabbit.mission.path_clear)                                                  return false;
    if (white_rabbit.mission.realsense_blocked_since)                                      return false;
    if (white_rabbit.mission.avoidance_timed_out)                                          return false;
    if (white_rabbit.motor.current_steering_type !== 'two_wheels')                         return false;
    if (white_rabbit.mission.nav_control && white_rabbit.mission.nav_control.mission_yaw_active)  return false;
    return true;
}

function detect_stuck(white_rabbit) {
    if (!white_rabbit.memory) return null;
    const r = white_rabbit.memory.reflect(STUCK.window_ms);
    if (!r || r.samples < 3) return null;
    const is_stuck = r.avg_speed_cmd != null
                  && r.avg_speed_cmd >= STUCK.min_speed_cmd
                  && r.moved_m       != null
                  && r.moved_m       <  STUCK.max_moved_m
                  && r.span_ms       >= STUCK.min_span_ms;
    return is_stuck ? r : null;
}

function command_stop(white_rabbit) {
    white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'memory_watchdog recovery stop');
    white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'memory_watchdog recovery stop');
    white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'memory_watchdog recovery stop');
    white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'memory_watchdog recovery stop');
}

function command_reverse(white_rabbit, speed) {
    // Straighten the steering — reversing with the wheels turned is unpredictable.
    const zero_pwm = white_rabbit.angle_to_pwm(0);
    white_rabbit.servo_send_command(white_rabbit, 11, zero_pwm.servo1, false);
    white_rabbit.servo_send_command(white_rabbit, 13, zero_pwm.servo2, false);
    white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
    white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);

    // Signs mirror run_mission's 2-wheel forward block (line 863-866), inverted.
    white_rabbit.move_white_rabbit(white_rabbit, 1, speed,      'memory_watchdog reverse');
    white_rabbit.move_white_rabbit(white_rabbit, 4, speed * -1, 'memory_watchdog reverse');
    white_rabbit.move_white_rabbit(white_rabbit, 3, speed * -1, 'memory_watchdog reverse');
    white_rabbit.move_white_rabbit(white_rabbit, 2, speed,      'memory_watchdog reverse');
}

function reverse_speed_for(white_rabbit) {
    return Math.max(40, Math.round((white_rabbit.motor.throttle_percentage || 0.25) * 200));
}

// Returns true when the watchdog took control of motors this tick — the caller
// must skip its normal navigation step.
function check(white_rabbit) {
    if (!white_rabbit.memory) return false;
    const cfg = config_for(white_rabbit);
    if (!cfg.enabled || !cfg.stuck_recovery_enabled) return false;

    const s   = init_state(white_rabbit);
    const now = Date.now();

    // 1. Drive the recovery state machine if one is already running.
    if (s.recovery_state === 'reversing') {
        if (now - s.recovery_start_ts >= STUCK.recovery_reverse_ms) {
            s.recovery_state          = 'pause_post_reverse';
            s.recovery_pause_start_ts = now;
            command_stop(white_rabbit);
            safe_log(white_rabbit, 'memory_watchdog: reverse complete, pausing');
        } else {
            command_reverse(white_rabbit, reverse_speed_for(white_rabbit));
        }
        return true;
    }
    if (s.recovery_state === 'pause_post_reverse') {
        command_stop(white_rabbit);
        if (now - s.recovery_pause_start_ts >= STUCK.recovery_pause_ms) {
            s.recovery_state   = null;
            s.last_recovery_ts = now;
            safe_log(white_rabbit, 'memory_watchdog: recovery complete, resuming mission');
        }
        return true;
    }

    // 2. Detect a new stuck event.
    if (!stuck_eligible(white_rabbit)) return false;
    const stuck_info = detect_stuck(white_rabbit);
    if (!stuck_info) return false;

    // Recoveries decay out of the cooldown window.
    if (now - s.last_recovery_ts > STUCK.cooldown_ms) s.recovery_count = 0;

    // Too many recoveries in a row → hand off to the existing fallback delivery.
    if (s.recovery_count >= STUCK.max_recoveries) {
        white_rabbit.mission.avoidance_timed_out = true;
        s.recovery_count = 0;
        safe_log(white_rabbit, 'memory_watchdog: max recoveries (' + STUCK.max_recoveries
            + ') exhausted within ' + STUCK.cooldown_ms + 'ms — triggering fallback delivery');
        return false;
    }

    // 3. Begin a fresh recovery.
    s.recovery_state    = 'reversing';
    s.recovery_start_ts = now;
    s.recovery_count   += 1;
    command_stop(white_rabbit);
    safe_log(white_rabbit, 'memory_watchdog: stuck detected (moved='
        + (stuck_info.moved_m != null      ? stuck_info.moved_m.toFixed(3)      : '?') + 'm avg_speed_cmd='
        + (stuck_info.avg_speed_cmd != null ? stuck_info.avg_speed_cmd.toFixed(0) : '?')
        + ' span=' + stuck_info.span_ms + 'ms) — reverse-and-retry #' + s.recovery_count);

    // Learning: record the stuck event with a risk zone at the current GPS,
    // and flag any zones the white_rabbit is already inside so they don't decay.
    if (white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
        const lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
        const lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
        white_rabbit.learning.mark_stuck_in_zones(lat, lng);
        white_rabbit.learning.add('stuck_event', {
            lat:           lat,
            lng:           lng,
            mission_seq:   white_rabbit.mission.current_mission_seq,
            moved_m:       stuck_info.moved_m,
            avg_speed_cmd: stuck_info.avg_speed_cmd,
            span_ms:       stuck_info.span_ms
        });
    }
    if (white_rabbit.intelligence) white_rabbit.intelligence.consider('stuck_detected');
    return true;
}

// ---------- B: vision-trend pre-slowdown ----------

function get_speed_multiplier(white_rabbit) {
    if (!white_rabbit.memory) return 1.0;
    const cfg = config_for(white_rabbit);
    if (!cfg.enabled || !cfg.vision_trend_enabled) return 1.0;
    if (!white_rabbit.realsense || !white_rabbit.realsense.vision || !white_rabbit.realsense.vision.enabled) return 1.0;

    const latest = white_rabbit.memory.latest();
    if (!latest || !latest.realsense) return 1.0;
    const current_conf = latest.realsense.confidence;
    if (typeof current_conf !== 'number') return 1.0;
    if (current_conf >= VISION_TREND.max_confidence) return 1.0;

    const trend = white_rabbit.memory.delta('realsense.confidence', VISION_TREND.window_ms);
    if (trend == null || trend > -VISION_TREND.drop_threshold) return 1.0;

    // Both conditions hold: confidence is low AND falling — slow down so the
    // sidewalk detector has time to recover before we get further from the path.
    const s = init_state(white_rabbit);
    const now = Date.now();
    if (now - s.last_vision_warn_ts > 2000) {
        s.last_vision_warn_ts = now;
        safe_log(white_rabbit, 'memory_watchdog: vision trending down (conf='
            + current_conf.toFixed(2) + ' delta=' + trend.toFixed(2) + ') — speed×'
            + VISION_TREND.speed_multiplier);

        // Learning: emit at most one vision_loss per 2s window (matches the log throttle).
        if (white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
            white_rabbit.learning.add('vision_loss', {
                lat:        white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude,
                lng:        white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude,
                confidence: current_conf,
                trend:      trend
            });
        }
    }
    return VISION_TREND.speed_multiplier;
}

// ---------- C: yaw oscillation correction ----------

function get_steering_adjustments(white_rabbit) {
    const passthrough = { deadband_boost_deg: 0, gain_multiplier: 1.0 };
    if (!white_rabbit.memory) return passthrough;
    const cfg = config_for(white_rabbit);
    if (!cfg.enabled || !cfg.yaw_oscillation_enabled) return passthrough;

    const snaps = white_rabbit.memory.recent(YAW_OSC.window_ms);
    if (snaps.length < 4) return passthrough;

    let sign_changes = 0;
    let prev_sign    = 0;
    let amp_sum      = 0;
    let amp_count    = 0;
    for (let i = 0; i < snaps.length; i++) {
        const y = snaps[i].yaw_to_waypoint;
        if (typeof y !== 'number') continue;
        const sign = y > 0 ? 1 : (y < 0 ? -1 : 0);
        if (sign !== 0 && prev_sign !== 0 && sign !== prev_sign) sign_changes++;
        if (sign !== 0) prev_sign = sign;
        amp_sum   += Math.abs(y);
        amp_count += 1;
    }
    if (amp_count === 0) return passthrough;
    const avg_amp = amp_sum / amp_count;

    if (sign_changes >= YAW_OSC.min_sign_changes && avg_amp > YAW_OSC.min_amplitude_deg) {
        const s = init_state(white_rabbit);
        const now = Date.now();
        if (now - s.last_osc_log_ts > 2000) {
            s.last_osc_log_ts = now;
            safe_log(white_rabbit, 'memory_watchdog: yaw oscillation (' + sign_changes
                + ' sign-changes, avg_amp=' + avg_amp.toFixed(1) + '°) — widening deadband, easing gain');

            // Learning: emit at most one per throttle window so we don't double-count one wobble.
            if (white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
                white_rabbit.learning.add('yaw_oscillation', {
                    lat:          white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude,
                    lng:          white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude,
                    sign_changes: sign_changes,
                    avg_amp_deg:  avg_amp
                });
            }
        }
        return {
            deadband_boost_deg: YAW_OSC.deadband_boost_deg,
            gain_multiplier:    YAW_OSC.gain_multiplier
        };
    }
    return passthrough;
}

var memory_watchdog = function (white_rabbit) {};
memory_watchdog.check                    = check;
memory_watchdog.get_speed_multiplier     = get_speed_multiplier;
memory_watchdog.get_steering_adjustments = get_steering_adjustments;
module.exports = memory_watchdog;
