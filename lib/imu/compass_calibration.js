'use strict';
const fs   = require('fs');
const path = require('path');

const SETUP_PATH         = path.join(__dirname, '../../setup.json');
const SETUP_EXAMPLE_PATH = path.join(__dirname, '../../setup_example.json');

const MIN_TRAVEL_M            = 3.0;
const RECALIBRATE_INTERVAL_MS = 30000;
const MAX_HEADING_CHANGE_DEG  = 15;
const BLEND_ALPHA             = 0.3;
// Hard cap for ongoing maintenance cycles — prevents a noisy GPS fix from
// slamming the heading mid-mission.
const MAX_OFFSET_CHANGE_DEG   = 3.0;
// Minimum correction worth saving to disk on maintenance cycles.
const MIN_PERSIST_CHANGE_DEG  = 0.5;
// A heading sample older than this is ignored — we only calibrate against a
// live sensor reading paired with the live GPS position.
const HEADING_FRESH_MS        = 2000;
// Steering must be within this many degrees of dead-center on all four wheels
// for the run to count as "straight" — a curve makes GPS course diverge from
// heading. RC injects a ~1° minimum, so the tolerance sits above that.
const STRAIGHT_TOL_DEG        = 3;
// The forward motor command must be this fresh. A stale command means we are not
// actively driving (e.g. parked, or being transported in the dock vehicle), so
// the rover's motion is not its own and must not be calibrated against.
const FORWARD_FRESH_MS        = 1500;
// The four steering servos in white_rabbit.servos (ids 11–14).
const STEERING_SERVOS = ['motor_front_driver', 'motor_back_driver', 'motor_front_passenger', 'motor_back_passenger'];

// Calibrate only while the rover is driving straight forward under its own power:
//  - a fresh, positive motor command (forward, and actually being driven now —
//    reverse would put GPS course ~180° off heading and flip the offset),
//  - all four steering servos centered (a straight run, so GPS course == heading).
function driving_straight_forward(white_rabbit) {
    const m = white_rabbit.motor || {};
    if (typeof m.motor_speed_cmd !== 'number' || m.motor_speed_cmd <= 0) return false;
    if (!m.motor_speed_cmd_ts || (Date.now() - m.motor_speed_cmd_ts) > FORWARD_FRESH_MS) return false;

    const servos = white_rabbit.servos || {};
    for (const name of STEERING_SERVOS) {
        const s = servos[name];
        if (!s || typeof s.commanded_pwm !== 'number') return false;
        const angle = typeof white_rabbit.pwm_to_angle === 'function'
            ? white_rabbit.pwm_to_angle(s.commanded_pwm) : 0;
        if (Math.abs(angle) > STRAIGHT_TOL_DEG) return false;
    }
    return true;
}

// Per-source calibration state, keyed by source id. Each heading sensor (the
// external IMU magnetometer, the Pixhawk EKF heading) tracks its own travel
// snapshot, cooldown timer, and lock count independently.
const _states = {};
function source_state(id) {
    return _states[id] || (_states[id] = { snapshot: null, last_ts: 0, count: 0 });
}

// Tracks which sources have already spoken their first-lock announcement. Kept
// OUTSIDE _states so compass_calibration.start() (called every mission) does not
// reset it — the operator hears the "aligned" voice once per session, not on
// every mission start or every recalibration.
const _voiced = {};

function signed_diff(a, b) {
    return ((a - b + 540) % 360) - 180;
}

// Persist a single offset key to both setup files, preserving everything else.
function persist_offset(key, new_offset, log) {
    for (const p of [SETUP_PATH, SETUP_EXAMPLE_PATH]) {
        try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!data.imu) data.imu = {};
            data.imu[key] = parseFloat(new_offset.toFixed(2));
            const tmp = p + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 4));
            fs.renameSync(tmp, p);
        } catch (e) {
            log('compass_calibration: write failed for ' + path.basename(p) + ': ' + e.message);
        }
    }
}

// Motor-encoder odometry. The ZLAC8015D drivers report cumulative pulse counts
// per wheel; converting them gives the exact straight-line distance traveled —
// more precise than GPS displacement, which jitters by a metre or more.
const FEEDBACK_FRESH_MS = 1500;
const DEFAULT_WHEEL_DIAM_M = 0.254;
const DEFAULT_CPR          = 16385;

function pulses_per_m(white_rabbit) {
    const cfg = white_rabbit.voice_config || {};
    const wheel_diam_m = (typeof cfg.wheel_diameter_m   === 'number') ? cfg.wheel_diameter_m   : DEFAULT_WHEEL_DIAM_M;
    const cpr          = (typeof cfg.cpr_pulses_per_rev === 'number') ? cfg.cpr_pulses_per_rev : DEFAULT_CPR;
    return cpr / (Math.PI * wheel_diam_m);
}

function odo_pulses(white_rabbit) {
    const pos = white_rabbit.zling && white_rabbit.zling.actual_position_pulses_by_id;
    if (!pos) return null;
    return { 1: pos[1] | 0, 2: pos[2] | 0, 3: pos[3] | 0, 4: pos[4] | 0, ts: pos.last_updated_ts || 0 };
}

// Exact distance (m) traveled since `start` from fresh encoder feedback, or null
// if odometry is unavailable/stale (caller falls back to GPS displacement).
function odo_distance_m(start, white_rabbit) {
    const cur = odo_pulses(white_rabbit);
    if (!start || !cur) return null;
    if (!cur.ts || (Date.now() - cur.ts) > FEEDBACK_FRESH_MS) return null;
    const ppm = pulses_per_m(white_rabbit);
    if (!(ppm > 0)) return null;
    const d = [1, 2, 3, 4].map(id => Math.abs(cur[id] - start[id]));
    const avg_abs_delta = (d[0] + d[1] + d[2] + d[3]) / 4;
    return avg_abs_delta / ppm;
}

// Calibrate one heading source against GPS course-over-ground. The offset is
// derived as (GPS bearing over a straight 3 m run) − (the source's raw heading),
// so heading = raw + offset matches the direction the rover actually traveled.
//
// src: {
//   id          unique state key
//   offset_key  white_rabbit.imu key this source's offset lives in
//   label       log prefix
//   voice       first-lock announcement (optional)
//   get_raw(wr) returns the live raw heading (deg) or null if absent/stale
//   ready(wr)   optional gate (e.g. magnetometer must be calibrated)
// }
function calibrate_source(white_rabbit, src, log) {
    const st = source_state(src.id);

    const lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
    const lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
    const raw = src.get_raw(white_rabbit);

    if (!lat || !lng || raw === undefined || raw === null) return;
    if (typeof src.ready === 'function' && !src.ready(white_rabbit)) return;

    // Only accumulate a baseline while driving straight forward. Any turn, stop,
    // reverse, or passive transport drops the snapshot so the eventual 3 m segment
    // is guaranteed to be one clean straight run under the rover's own power.
    if (!driving_straight_forward(white_rabbit)) {
        st.snapshot = null;
        return;
    }

    const now = Date.now();
    if (st.last_ts > 0 && (now - st.last_ts) < RECALIBRATE_INTERVAL_MS) return;

    if (!st.snapshot) {
        st.snapshot = { lat, lng, raw_heading: raw, pulses: odo_pulses(white_rabbit) };
        return;
    }

    // Distance traveled: prefer exact motor-encoder odometry; fall back to GPS
    // displacement when feedback is stale/absent. gps_distance returns km.
    let dist        = odo_distance_m(st.snapshot.pulses, white_rabbit);
    let dist_source = 'odo';
    if (dist === null) {
        dist        = white_rabbit.gps_distance(st.snapshot.lat, st.snapshot.lng, lat, lng) * 1000;
        dist_source = 'gps';
    }
    if (dist < MIN_TRAVEL_M) return;

    // If the rover curved significantly, the GPS bearing no longer matches the
    // heading — discard and re-snapshot from the current position.
    const heading_change = Math.abs(signed_diff(raw, st.snapshot.raw_heading));
    if (heading_change > MAX_HEADING_CHANGE_DEG) {
        st.snapshot = { lat, lng, raw_heading: raw, pulses: odo_pulses(white_rabbit) };
        return;
    }

    const gps_bearing    = white_rabbit.get_bearing(st.snapshot.lat, st.snapshot.lng, lat, lng);
    const ideal_offset   = signed_diff(gps_bearing, raw);
    const current_offset = (white_rabbit.imu && typeof white_rabbit.imu[src.offset_key] === 'number')
        ? white_rabbit.imu[src.offset_key] : 0;

    let new_offset;
    let should_persist = false;

    if (st.count === 0) {
        // First GPS-track lock after boot: snap directly to truth with no clamp.
        // The rover has driven 3 m straight with consistent heading — GPS bearing
        // is reliable. Any wrong stored offset is corrected in one shot.
        new_offset = ((ideal_offset) + 540) % 360 - 180;
        should_persist = true;
        log(
            src.label + ' FIRST-LOCK SNAP: dist=' + dist.toFixed(1) + 'm(' + dist_source + ')' +
            ' gps=' + gps_bearing.toFixed(1) + '°' +
            ' raw=' + raw.toFixed(1) + '°' +
            ' ideal_offset=' + ideal_offset.toFixed(1) + '°' +
            ' old=' + current_offset.toFixed(1) + '° → new=' + new_offset.toFixed(1) + '°' +
            ' (saved to disk)'
        );
        if (src.voice && white_rabbit.voice && !_voiced[src.id]) {
            white_rabbit.voice.say(src.voice);
            _voiced[src.id] = true;
        }
        // Reset the heading belief so it re-initializes from the corrected heading,
        // not the (now-wrong) pre-snap value.
        if (white_rabbit.heading_belief) white_rabbit.heading_belief.reset();
    } else {
        // Ongoing maintenance calibration — the heading fine-tunes the more the
        // rover drives on good GPS.
        // If GPS jitter is very low, GPS has proven itself reliable — it has earned
        // the right to correct the heading without the 3°/cycle clamp.
        const gps_jitter     = white_rabbit.robot_data && white_rabbit.robot_data.gps_jitter_m;
        const gps_very_flat  = typeof gps_jitter === 'number' && gps_jitter < 0.8;

        const delta          = signed_diff(ideal_offset, current_offset);

        let applied_change;
        let mode_label;
        if (gps_very_flat) {
            // GPS is flat: trust it fully — large correction applied without clamp.
            applied_change = 0.8 * delta;
            mode_label     = ' [GPS flat — strong correction]';
            should_persist = true;
        } else {
            // Normal maintenance: gentle 3°/cycle clamp keeps mid-run noise from yanking heading.
            const raw_change = BLEND_ALPHA * delta;
            applied_change   = Math.max(-MAX_OFFSET_CHANGE_DEG, Math.min(MAX_OFFSET_CHANGE_DEG, raw_change));
            mode_label       = '';
            should_persist   = Math.abs(applied_change) >= MIN_PERSIST_CHANGE_DEG;
        }

        new_offset = ((current_offset + applied_change) + 540) % 360 - 180;

        log(
            src.label + ': dist=' + dist.toFixed(1) + 'm(' + dist_source + ')' +
            ' gps=' + gps_bearing.toFixed(1) + '°' +
            ' raw=' + raw.toFixed(1) + '°' +
            ' ideal_offset=' + ideal_offset.toFixed(1) + '°' +
            ' old=' + current_offset.toFixed(1) + '° → new=' + new_offset.toFixed(1) + '°' +
            mode_label +
            (should_persist ? ' (saved)' : '')
        );
    }

    if (!white_rabbit.imu) white_rabbit.imu = {};
    white_rabbit.imu[src.offset_key] = new_offset;

    if (should_persist) {
        persist_offset(src.offset_key, new_offset, log);
    }

    st.last_ts  = now;
    st.count++;
    st.snapshot = { lat, lng, raw_heading: raw, pulses: odo_pulses(white_rabbit) };
}

var compass_calibration = function (white_rabbit) {

    if (!white_rabbit.imu || white_rabbit.imu.auto_calibrate === false) return;

    const log = (msg) => {
        if (white_rabbit.logs && white_rabbit.logs.run_mission) {
            white_rabbit.logs.run_mission.log(white_rabbit, msg);
        } else {
            console.log(msg);
        }
    };

    // Source 1 — external BNO055 IMU magnetometer heading. Corrects
    // imu.compass_offset_deg, which connect_to_imu bakes into imu_data.heading.
    calibrate_source(white_rabbit, {
        id:         'imu',
        offset_key: 'compass_offset_deg',
        label:      'compass_calibration[imu]',
        voice:      'Stars aligned. Noah knows which way is north.',
        get_raw: (wr) => {
            if (!(wr.imu && wr.imu.enabled !== false)) return null;
            const r  = wr.imu_data && wr.imu_data.heading_raw;
            const ts = wr.imu_data && wr.imu_data.timestamp;
            if (typeof r !== 'number') return null;
            if (ts && (Date.now() - ts) > HEADING_FRESH_MS) return null;
            return r;
        },
        ready: (wr) => {
            // BNO055 mag calibration: 0 = uncalibrated, 3 = full. mag < 1 is too noisy.
            const mag = wr.imu_data && wr.imu_data.calibration && wr.imu_data.calibration.mag;
            return !(typeof mag === 'number' && mag < 1);
        }
    }, log);

    // Source 2 — Pixhawk EKF heading (VFR_HUD), the primary nav heading. Corrects
    // imu.pixhawk_offset_deg, applied to the Pixhawk heading in get_heading. This
    // lets the heading fine-tune itself the more Noah drives on good GPS, even with
    // the external IMU disabled.
    calibrate_source(white_rabbit, {
        id:         'pixhawk',
        offset_key: 'pixhawk_offset_deg',
        label:      'compass_calibration[pixhawk]',
        voice:      'Pixhawk heading aligned to the stars.',
        get_raw: (wr) => {
            const r  = wr.robot_data && wr.robot_data.VFR_HUD && wr.robot_data.VFR_HUD.heading;
            const ts = wr.robot_data && wr.robot_data.vfr_hud_ts;
            if (typeof r !== 'number') return null;
            if (ts && (Date.now() - ts) > HEADING_FRESH_MS) return null;
            return r;
        }
    }, log);
};

// Call at each mission start so a new mission calibrates immediately rather than
// waiting out the previous mission's 30 s cooldown. Resets every source's travel
// state, but NOT _voiced — the first-lock announcement stays spoken-once-per-session.
compass_calibration.start = function () {
    for (const k of Object.keys(_states)) delete _states[k];
};

module.exports = compass_calibration;
