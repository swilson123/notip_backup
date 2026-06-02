'use strict';
const fs   = require('fs');
const path = require('path');

const SETUP_PATH         = path.join(__dirname, '../../setup.json');
const SETUP_EXAMPLE_PATH = path.join(__dirname, '../../setup_example.json');

const MIN_TRAVEL_M            = 3.0;
const RECALIBRATE_INTERVAL_MS = 30000;
const MAX_HEADING_CHANGE_DEG  = 15;
const BLEND_ALPHA             = 0.3;
const FIRST_CAL_ALPHA         = 0.3;
// Hard cap: never shift the offset more than this in one calibration cycle.
// Prevents a noisy GPS fix from slamming the heading mid-mission.
const MAX_OFFSET_CHANGE_DEG   = 3.0;

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
    const alpha          = _cal_count === 0 ? FIRST_CAL_ALPHA : BLEND_ALPHA;
    const delta          = signed_diff(ideal_offset, current_offset);
    const raw_change     = alpha * delta;
    const clamped_change = Math.max(-MAX_OFFSET_CHANGE_DEG, Math.min(MAX_OFFSET_CHANGE_DEG, raw_change));
    const new_offset     = ((current_offset + clamped_change) + 540) % 360 - 180;

    const log = (msg) => {
        if (white_rabbit.logs && white_rabbit.logs.run_mission) {
            white_rabbit.logs.run_mission.log(white_rabbit, msg);
        } else {
            console.log(msg);
        }
    };

    log(
        'compass_calibration: dist=' + dist.toFixed(1) + 'm' +
        ' gps=' + gps_bearing.toFixed(1) + '°' +
        ' raw=' + raw.toFixed(1) + '°' +
        ' ideal_offset=' + ideal_offset.toFixed(1) + '°' +
        ' old=' + current_offset.toFixed(1) + '°' +
        ' new=' + new_offset.toFixed(1) + '°'
    );

    white_rabbit.imu.compass_offset_deg = new_offset;

    if (white_rabbit.voice && _cal_count === 0) {
        white_rabbit.voice.say('Compass calibrated.');
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
