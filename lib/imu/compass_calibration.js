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

let _snapshot    = null;   // { lat, lng, raw_heading }
let _last_cal_ts = 0;
let _cal_count   = 0;

function signed_diff(a, b) {
    return ((a - b + 540) % 360) - 180;
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

var compass_calibration = function (white_rabbit) {

    if (!white_rabbit.imu || white_rabbit.imu.auto_calibrate === false) return;

    const lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
    const lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
    const raw = white_rabbit.imu_data  && white_rabbit.imu_data.heading_raw;

    if (!lat || !lng || raw === undefined || raw === null) return;

    // Require the magnetometer to be at least minimally calibrated before trusting it.
    // BNO055 calibration status: 0 = uncalibrated, 3 = fully calibrated.
    // mag < 1 means the readings are too noisy to derive an offset from.
    const mag_cal = white_rabbit.imu_data && white_rabbit.imu_data.calibration && white_rabbit.imu_data.calibration.mag;
    if (typeof mag_cal === 'number' && mag_cal < 1) return;

    const now = Date.now();
    if (_last_cal_ts > 0 && (now - _last_cal_ts) < RECALIBRATE_INTERVAL_MS) return;

    if (!_snapshot) {
        _snapshot = { lat, lng, raw_heading: raw };
        return;
    }

    // gps_distance returns km — convert to metres.
    const dist = white_rabbit.gps_distance(_snapshot.lat, _snapshot.lng, lat, lng) * 1000;
    if (dist < MIN_TRAVEL_M) return;

    // If the rover curved significantly, the GPS bearing no longer matches the
    // compass direction — discard and re-snapshot from the current position.
    const heading_change = Math.abs(signed_diff(raw, _snapshot.raw_heading));
    if (heading_change > MAX_HEADING_CHANGE_DEG) {
        _snapshot = { lat, lng, raw_heading: raw };
        return;
    }

    const gps_bearing    = white_rabbit.get_bearing(_snapshot.lat, _snapshot.lng, lat, lng);
    const ideal_offset   = signed_diff(gps_bearing, raw);
    const current_offset = white_rabbit.imu.compass_offset_deg;

    const log = (msg) => {
        if (white_rabbit.logs && white_rabbit.logs.run_mission) {
            white_rabbit.logs.run_mission.log(white_rabbit, msg);
        } else {
            console.log(msg);
        }
    };

    let new_offset;
    let should_persist = false;

    if (_cal_count === 0) {
        // First GPS-track lock after boot: snap directly to truth with no clamp.
        // The rover has driven 3 m straight with consistent heading — GPS bearing
        // is reliable. Any wrong stored offset is corrected in one shot. This
        // eliminates the need to manually set compass_offset_deg each boot.
        new_offset = ((ideal_offset) + 540) % 360 - 180;
        should_persist = true;
        log(
            'compass_calibration FIRST-LOCK SNAP: dist=' + dist.toFixed(1) + 'm' +
            ' gps=' + gps_bearing.toFixed(1) + '°' +
            ' raw=' + raw.toFixed(1) + '°' +
            ' ideal_offset=' + ideal_offset.toFixed(1) + '°' +
            ' old=' + current_offset.toFixed(1) + '° → new=' + new_offset.toFixed(1) + '°' +
            ' (saved to disk)'
        );
        if (white_rabbit.voice) white_rabbit.voice.say('Stars aligned. Noah knows which way is north.');
        // Reset the heading belief so it re-initializes from the corrected heading,
        // not the (now-wrong) pre-snap value.
        if (white_rabbit.heading_belief) white_rabbit.heading_belief.reset();
    } else {
        // Ongoing maintenance calibration.
        // If GPS jitter is very low, GPS has proven itself reliable — it has earned
        // the right to correct the compass without the 3°/cycle clamp. A flat GPS
        // is a trustworthy truth-teller; let it immediately balance a drifting compass.
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
            'compass_calibration: dist=' + dist.toFixed(1) + 'm' +
            ' gps=' + gps_bearing.toFixed(1) + '°' +
            ' raw=' + raw.toFixed(1) + '°' +
            ' ideal_offset=' + ideal_offset.toFixed(1) + '°' +
            ' old=' + current_offset.toFixed(1) + '° → new=' + new_offset.toFixed(1) + '°' +
            mode_label +
            (should_persist ? ' (saved)' : '')
        );
    }

    white_rabbit.imu.compass_offset_deg = new_offset;

    if (should_persist) {
        persist_offset(new_offset, log);
    }

    _last_cal_ts = now;
    _cal_count++;
    _snapshot = { lat, lng, raw_heading: raw };

};

// Call at each mission start so the new mission calibrates immediately
// rather than waiting out the previous mission's 30 s cooldown.
compass_calibration.start = function () {
    _snapshot    = null;
    _last_cal_ts = 0;
};

module.exports = compass_calibration;
