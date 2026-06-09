'use strict';

// Cross-validates GPS bearing vs compass heading during straight-line nav.
// When they disagree, diagnoses WHICH sensor is the liar by watching
// each sensor's own stability independently.
//
// A flat line is honest. A jumping sensor is suspect.
// When one is flat and one is jumping — the jumpy one is wrong.

// --- Disagreement alarm ---
const DISAGREE_DEG  = 20;    // degrees of GPS/compass gap that starts the clock
const PERSIST_MS    = 8000;  // ms the gap must persist before Noah speaks
const REPEAT_MS     = 45000; // ms before repeating the same warning

// --- Sensor jitter thresholds ---
// GPS: EMA of successive raw-position jumps in metres.
// At Noah's speed (< 0.5 m/s) and 5 Hz GPS, expected delta ≈ 0.1 m/reading.
// Above 1.5 m is clearly noisy.
const GPS_JITTER_NOISY_M   = 1.5;
// GPS: consecutive outlier-rejected reads (> 5 m jump) indicate bad GPS.
const GPS_REJECT_NOISY     = 2;

// Heading: EMA of successive heading_raw deltas in degrees per 250 ms tick.
// Straight-line driving: < 1 °/tick. Magnetic anomaly: 5-15 °/tick.
const HDG_JITTER_NOISY_DEG = 2.5;
const HDG_JITTER_ALPHA     = 0.30;

function signed_diff(a, b) {
    return ((a - b + 540) % 360) - 180;
}

let _bad_since        = null;
let _last_announced   = 0;
let _prev_hdg_raw     = null;
let _hdg_jitter_ema   = 0;

var sensor_coherence = function (white_rabbit) {

    const nav_control = white_rabbit.mission && white_rabbit.mission.nav_control;
    const yaw_active  = nav_control && nav_control.mission_yaw_active;

    // --- Track heading jitter ONLY during straight-line nav ---
    // During a 4-wheel yaw the heading changes rapidly by design — counting
    // that as compass noise would leave a false "jumpy compass" signal after
    // every turn. Reset prev during yaw so the post-turn first tick is skipped.
    if (!yaw_active) {
        const hdg_raw = white_rabbit.imu_data && white_rabbit.imu_data.heading_raw;
        if (typeof hdg_raw === 'number') {
            if (_prev_hdg_raw !== null) {
                const delta = Math.abs(signed_diff(hdg_raw, _prev_hdg_raw));
                _hdg_jitter_ema = _hdg_jitter_ema * (1 - HDG_JITTER_ALPHA) + delta * HDG_JITTER_ALPHA;
            }
            _prev_hdg_raw = hdg_raw;
        }
    } else {
        _prev_hdg_raw = null;   // clear so the first post-yaw tick doesn't score the turn delta
    }

    // Publish so logs and dashboards can read it.
    if (white_rabbit.imu_data) {
        white_rabbit.imu_data.heading_jitter_deg = _hdg_jitter_ema;
    }

    // --- Coherence alarm: straight-line nav only ---
    if (!nav_control) return;
    if (yaw_active) { _bad_since = null; return; }
    if (white_rabbit.mission.pause_mission) { _bad_since = null; return; }
    // Camera steers on the sidewalk — GPS bearing and heading may legitimately
    // diverge as the path curves. Don't alarm during sidewalk following.
    if (white_rabbit.mission.sidewalk_follow_active) { _bad_since = null; return; }

    const yaw_err = white_rabbit.robot_data && white_rabbit.robot_data.yaw_to_waypoint;
    if (typeof yaw_err !== 'number') { _bad_since = null; return; }

    const now = Date.now();

    if (Math.abs(yaw_err) > DISAGREE_DEG) {
        if (_bad_since === null) _bad_since = now;

        const held_ms     = now - _bad_since;
        const since_spoke = now - _last_announced;

        if (held_ms >= PERSIST_MS && since_spoke >= REPEAT_MS) {
            _last_announced = now;

            const gps_jitter  = (white_rabbit.robot_data && white_rabbit.robot_data.gps_jitter_m)     || 0;
            const gps_rejects = (white_rabbit.robot_data && white_rabbit.robot_data.gps_reject_streak) || 0;

            const gps_bad = gps_jitter >= GPS_JITTER_NOISY_M || gps_rejects >= GPS_REJECT_NOISY;
            const hdg_bad = _hdg_jitter_ema >= HDG_JITTER_NOISY_DEG;

            const deg = Math.round(Math.abs(yaw_err));
            const dir = yaw_err > 0 ? 'right' : 'left';

            let diagnosis;
            let voice_line;

            if (gps_bad && !hdg_bad) {
                diagnosis  = 'GPS jumping (jitter ' + gps_jitter.toFixed(1) + 'm, rejects ' + gps_rejects + '), compass flat (' + _hdg_jitter_ema.toFixed(2) + 'deg/tick)';
                voice_line = 'My G P S is jumping. My compass is steady. Trusting the compass.';
            } else if (hdg_bad && !gps_bad) {
                diagnosis  = 'Compass jumping (' + _hdg_jitter_ema.toFixed(2) + 'deg/tick), GPS flat (jitter ' + gps_jitter.toFixed(1) + 'm)';
                voice_line = 'My compass is jumping. My G P S is steady. Trusting the stars.';
            } else if (gps_bad && hdg_bad) {
                diagnosis  = 'Both jumping — GPS ' + gps_jitter.toFixed(1) + 'm, compass ' + _hdg_jitter_ema.toFixed(2) + 'deg/tick';
                voice_line = 'Both G P S and compass are unstable. Proceeding on what I know.';
            } else {
                // Both sensors are flat but they disagree — most likely a stale compass
                // offset rather than live sensor noise. compass_calibration will correct
                // this after the next 3 m of straight travel.
                diagnosis  = 'Both flat — GPS ' + gps_jitter.toFixed(1) + 'm, compass ' + _hdg_jitter_ema.toFixed(2) + 'deg/tick — offset likely wrong';
                voice_line = 'My path and compass are steady but disagree by ' + deg +
                             ' degrees to the ' + dir + '. My compass may need alignment.';
            }

            if (white_rabbit.logs && white_rabbit.logs.run_mission) {
                white_rabbit.logs.run_mission.log(white_rabbit,
                    'sensor_coherence: ' + deg + '° gap for ' +
                    (held_ms / 1000).toFixed(0) + 's — ' + diagnosis
                );
            }

            if (white_rabbit.voice) white_rabbit.voice.say(voice_line);
        }
    } else {
        _bad_since = null;
    }

};

// Reset at mission start — clean slate for jitter history and alarm state.
sensor_coherence.start = function () {
    _bad_since        = null;
    _last_announced   = 0;
    _prev_hdg_raw     = null;
    _hdg_jitter_ema   = 0;
};

module.exports = sensor_coherence;
