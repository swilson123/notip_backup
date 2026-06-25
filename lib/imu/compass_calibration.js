'use strict';
const fs   = require('fs');
const path = require('path');

const SETUP_PATH         = path.join(__dirname, '../../setup.json');
const SETUP_EXAMPLE_PATH = path.join(__dirname, '../../setup_example.json');

// --- Calibration design --------------------------------------------------
// One calibration sample = a single straight ~2 m segment. We measure the
// distance travelled from WHEEL ODOMETRY (the same encoder feedback the voice
// nudges use), then compare the GPS bearing over that segment against the raw
// compass heading to derive the compass offset.
//
// Two guards keep the sample honest:
//   1. Steering gate — only build a segment while commanded steering stays
//      within MAX_STEER_DEG. If Noah turns, the GPS bearing no longer matches
//      the compass heading, so the in-progress segment is discarded.
//   2. Odometry vs GPS cross-check — the wheel-odometry distance and the GPS
//      straight-line distance must agree within ODO_GPS_AGREE_FRAC. A big
//      mismatch means wheel slip or a GPS jump, so the sample is rejected.
//
// Entry points:
//   compass_calibration(white_rabbit)                  — per-tick, in-mission
//   compass_calibration.calibrate_undock_segment(...)  — bottom-of-ramp undock
//   compass_calibration.start()                        — reset between missions
const SEGMENT_DISTANCE_M       = 2.0;    // straight-line distance for one sample ("2 m ahead")
const MAX_STEER_DEG            = 5.0;    // gate: only calibrate when steering stays within this
const ODO_GPS_AGREE_FRAC       = 0.35;   // odometry vs GPS distance must agree within this fraction
const MAX_SEG_HEADING_CHANGE_DEG = 8.0;  // raw heading must not swing more than this over the segment
const RECALIBRATE_INTERVAL_MS  = 30000;  // cooldown between accepted in-mission calibrations
const BLEND_ALPHA              = 0.3;
const FIRST_CAL_ALPHA          = 0.3;
// Hard cap: never shift the offset more than this in one calibration cycle.
// Prevents a noisy GPS fix from slamming the heading mid-mission.
const MAX_OFFSET_CHANGE_DEG    = 3.0;

let _snapshot    = null;   // { lat, lng, raw_heading, odo_pulses }
let _last_cal_ts = 0;
let _cal_count   = 0;

function signed_diff(a, b) {
    return ((a - b + 540) % 360) - 180;
}

// Wheel odometry geometry — same drivetrain constants the voice nudges measure
// with (voice_config). distance_m = avg|Δpulses| / (cpr / (π·wheel_diameter)).
function pulses_per_m(white_rabbit) {
    const vcfg = white_rabbit.voice_config || {};
    const wheel_diam_m = typeof vcfg.wheel_diameter_m === 'number' ? vcfg.wheel_diameter_m : 0.254;
    const cpr          = typeof vcfg.cpr_pulses_per_rev === 'number' ? vcfg.cpr_pulses_per_rev : 16385;
    return cpr / (Math.PI * wheel_diam_m);
}

function snapshot_pulses(white_rabbit) {
    const p = white_rabbit.zling && white_rabbit.zling.actual_position_pulses_by_id;
    if (!p) return null;
    return { 1: p[1] | 0, 2: p[2] | 0, 3: p[3] | 0, 4: p[4] | 0 };
}

// Distance (m) travelled since `start_pulses`, averaged across all four wheels.
// Returns null when there is no encoder feed to measure against.
function odo_distance_m(white_rabbit, start_pulses) {
    const now = white_rabbit.zling && white_rabbit.zling.actual_position_pulses_by_id;
    if (!now || !start_pulses) return null;
    let sum_abs_delta = 0;
    for (let id = 1; id <= 4; id++) {
        sum_abs_delta += Math.abs((now[id] | 0) - (start_pulses[id] | 0));
    }
    return (sum_abs_delta / 4) / pulses_per_m(white_rabbit);
}

function log_fn(white_rabbit) {
    return (msg) => {
        if (white_rabbit.logs && white_rabbit.logs.run_mission) {
            white_rabbit.logs.run_mission.log(white_rabbit, msg);
        } else {
            console.log(msg);
        }
    };
}

function persist_offset(new_offset, log) {
    for (const p of [SETUP_PATH, SETUP_EXAMPLE_PATH]) {
        try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!data.imu) data.imu = {};
            data.imu.compass_offset_deg = parseFloat(new_offset.toFixed(2));
            const tmp = p + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 4));
            fs.renameSync(tmp, p);
        } catch (e) {
            log('compass_calibration: write failed for ' + path.basename(p) + ': ' + e.message);
        }
    }
}

// Core: blend one measured straight segment into imu.compass_offset_deg and
// persist it. Returns true if the sample was accepted. `odo_dist_m` of 0 (or
// null) disables the odometry/GPS cross-check (no encoder feed available).
function apply_segment(white_rabbit, start_lat, start_lng, start_raw, end_lat, end_lng, end_raw, odo_dist_m, source, force) {
    // `force` (undock bottom-of-ramp) bypasses the auto_calibrate master switch
    // so that calibration always takes place on undock; the correctness guards
    // below still apply so a curved drive or wheel slip can't corrupt the offset.
    if (!white_rabbit.imu || (!force && white_rabbit.imu.auto_calibrate === false)) return false;
    const log = log_fn(white_rabbit);

    const gps_dist_m = white_rabbit.gps_distance(start_lat, start_lng, end_lat, end_lng) * 1000;

    // Straightness guard — raw heading must not have swung over the segment.
    if (start_raw != null && end_raw != null
        && Math.abs(signed_diff(end_raw, start_raw)) > MAX_SEG_HEADING_CHANGE_DEG) {
        log('compass_calibration: reject ' + source + ' — heading swung '
            + Math.abs(signed_diff(end_raw, start_raw)).toFixed(1) + '° over segment (not straight)');
        return false;
    }

    // Odometry/GPS cross-check — a big mismatch means wheel slip or a GPS jump.
    if (odo_dist_m && odo_dist_m > 0
        && Math.abs(gps_dist_m - odo_dist_m) > ODO_GPS_AGREE_FRAC * odo_dist_m) {
        log('compass_calibration: reject ' + source + ' — odo=' + odo_dist_m.toFixed(2)
            + 'm vs gps=' + gps_dist_m.toFixed(2) + 'm disagree');
        return false;
    }

    const gps_bearing = white_rabbit.get_bearing(start_lat, start_lng, end_lat, end_lng);
    // Heading held during the segment — midpoint of start/end raw on a straight run.
    const seg_raw = (start_raw != null && end_raw != null)
        ? (start_raw + signed_diff(end_raw, start_raw) / 2 + 360) % 360
        : (end_raw != null ? end_raw : start_raw);

    const ideal_offset   = signed_diff(gps_bearing, seg_raw);
    const current_offset = white_rabbit.imu.compass_offset_deg || 0;
    const alpha          = _cal_count === 0 ? FIRST_CAL_ALPHA : BLEND_ALPHA;
    const raw_change     = alpha * signed_diff(ideal_offset, current_offset);
    const clamped_change = Math.max(-MAX_OFFSET_CHANGE_DEG, Math.min(MAX_OFFSET_CHANGE_DEG, raw_change));
    const new_offset     = ((current_offset + clamped_change) + 540) % 360 - 180;

    log(
        'compass_calibration[' + source + ']:' +
        ' odo=' + (odo_dist_m ? odo_dist_m.toFixed(2) : '--') + 'm' +
        ' gps=' + gps_dist_m.toFixed(2) + 'm' +
        ' bearing=' + gps_bearing.toFixed(1) + '°' +
        ' raw=' + (seg_raw != null ? seg_raw.toFixed(1) : '--') + '°' +
        ' ideal_offset=' + ideal_offset.toFixed(1) + '°' +
        ' old=' + current_offset.toFixed(1) + '°' +
        ' new=' + new_offset.toFixed(1) + '°'
    );

    white_rabbit.imu.compass_offset_deg = new_offset;
    persist_offset(new_offset, log);

    // Always announce on a completed (accepted) calibration.
    if (white_rabbit.voice) {
        white_rabbit.voice.say('Compass calibration complete.');
    }

    _cal_count++;
    _last_cal_ts = Date.now();
    return true;
}

// In-mission, per-tick calibration. Builds a straight ~2 m segment from wheel
// odometry while steering stays within MAX_STEER_DEG, then blends the result.
var compass_calibration = function (white_rabbit) {

    if (!white_rabbit.imu || white_rabbit.imu.auto_calibrate === false) return;

    const lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
    const lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
    const raw = white_rabbit.imu_data  && white_rabbit.imu_data.heading_raw;

    if (!lat || !lng || raw === undefined || raw === null) return;

    // Steering gate: only calibrate on (near) straight driving. If Noah is
    // steering more than MAX_STEER_DEG, drop the in-progress segment and wait
    // until he straightens out before snapshotting again.
    const steer = (white_rabbit.mission && white_rabbit.mission.nav_control)
        ? Math.abs(white_rabbit.mission.nav_control.last_two_wheel_steering_deg || 0)
        : 0;
    if (steer > MAX_STEER_DEG) { _snapshot = null; return; }

    // Cooldown between accepted calibrations — start each new segment fresh.
    if (_last_cal_ts > 0 && (Date.now() - _last_cal_ts) < RECALIBRATE_INTERVAL_MS) {
        _snapshot = null;
        return;
    }

    if (!_snapshot) {
        _snapshot = { lat, lng, raw_heading: raw, odo_pulses: snapshot_pulses(white_rabbit) };
        return;
    }

    // Prefer wheel odometry for the distance gate; fall back to GPS if encoders
    // are silent (cross-check is skipped in that case).
    const odo  = odo_distance_m(white_rabbit, _snapshot.odo_pulses);
    const dist = (odo != null) ? odo : white_rabbit.gps_distance(_snapshot.lat, _snapshot.lng, lat, lng) * 1000;
    if (dist < SEGMENT_DISTANCE_M) return;

    apply_segment(white_rabbit, _snapshot.lat, _snapshot.lng, _snapshot.raw_heading,
        lat, lng, raw, odo != null ? odo : 0, 'mission');

    // Re-snapshot from here for the next segment (apply_segment set the cooldown).
    _snapshot = { lat, lng, raw_heading: raw, odo_pulses: snapshot_pulses(white_rabbit) };
};

// Bottom-of-ramp calibration. down_the_rabbit_hole snapshots position + raw
// heading at the bottom of the ramp; after the straight ~2 m post-ramp drive it
// calls this with that snapshot, the current pose, and the odometry distance it
// already measured. Run BEFORE the undock heading is recorded so that heading
// is captured with a fresh offset. ALWAYS runs on undock — independent of the
// auto_calibrate switch (force) — so the compass is calibrated every undock.
compass_calibration.calibrate_undock_segment = function (white_rabbit, start, odo_dist_m) {
    if (!white_rabbit.imu) return false;
    if (!start || !start.lat || !start.lng || start.raw_heading == null) return false;

    const lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
    const lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
    const raw = white_rabbit.imu_data  && white_rabbit.imu_data.heading_raw;
    if (!lat || !lng || raw == null) return false;

    return apply_segment(white_rabbit, start.lat, start.lng, start.raw_heading,
        lat, lng, raw, odo_dist_m || 0, 'undock', true);
};

// Manual field calibration: the operator declares Noah's TRUE current heading
// (e.g. by voice — "set compass 360" means "you are facing 360°/north right
// now"). Solve the offset so the fused heading reads that value going forward:
// offset = signed_diff(target_heading, raw_heading). Persisted to both setup
// files. Returns the new offset, or null if there's no raw heading to anchor
// against. Sets the cooldown so auto-calibration doesn't immediately blend the
// manual value away.
compass_calibration.set_heading = function (white_rabbit, target_heading_deg) {
    if (!white_rabbit.imu) return null;
    // Use IMU raw heading when available; fall back to Pixhawk VFR_HUD when IMU is disabled.
    let raw = white_rabbit.imu_data && white_rabbit.imu_data.heading_raw;
    if (raw === undefined || raw === null) {
        raw = white_rabbit.robot_data && white_rabbit.robot_data.VFR_HUD
            && white_rabbit.robot_data.VFR_HUD.heading;
    }
    if (raw === undefined || raw === null
        || typeof target_heading_deg !== 'number' || !isFinite(target_heading_deg)) return null;

    const target = ((target_heading_deg % 360) + 360) % 360;
    const new_offset = signed_diff(target, raw);
    const log = log_fn(white_rabbit);
    log('compass_calibration[manual]: target=' + target.toFixed(1) + '°'
        + ' raw=' + raw.toFixed(1) + '° → offset=' + new_offset.toFixed(1) + '°');

    white_rabbit.imu.compass_offset_deg = new_offset;
    persist_offset(new_offset, log);
    _last_cal_ts = Date.now();
    return new_offset;
};

// Call at each mission start so the new mission calibrates immediately
// rather than waiting out the previous mission's 30 s cooldown.
compass_calibration.start = function () {
    _snapshot    = null;
    _last_cal_ts = 0;
};

module.exports = compass_calibration;
