'use strict';

// Noah's remembered sense of where the sidewalk edge is.
//
// When vision confidence flickers — dappled light, leaf shadows, brief obstructions —
// Noah doesn't immediately fall back to pure GPS. He holds the last known good
// lateral correction, provided two guards pass:
//   1. The remembered correction was within 1 m (within the pipe radius Scott describes)
//   2. At least one positioning sensor (GPS or compass) is steady
//
// Call with (white_rabbit, confidence, lateral_m) after a good detection to save.
// Call with (white_rabbit, confidence, null) during a dropout to query.
// Returns { lateral_m, source, age_ms } or null.
//
// This is the sidewalk version of closing your eyes and walking forward on a
// known heading — Noah stays on the path because he knows where it was and
// knows he hasn't drifted.

const BELIEF_HOLD_MS   = 3000;   // max age of held belief before discarded
const CROSSTRACK_MAX_M = 1.0;    // max |believed lateral| (m) to trust during dropout
const GPS_NOISY_M      = 1.5;    // gps_jitter_m above this = GPS unsteady
const HDG_NOISY_DEG    = 2.5;    // heading_jitter_deg above this = compass unsteady

let _believed_lat_m = null;
let _believed_ts    = null;

var vision_belief = function (white_rabbit, confidence, lateral_m) {

    const now = Date.now();

    if (lateral_m !== null && lateral_m !== undefined) {
        // Good detection — save belief and return
        _believed_lat_m = lateral_m;
        _believed_ts    = now;
        return { lateral_m: lateral_m, source: 'vision', age_ms: 0 };
    }

    // Confidence dropout — try to return a held belief
    if (_believed_lat_m === null || _believed_ts === null) return null;

    let age_ms = now - _believed_ts;
    if (age_ms > BELIEF_HOLD_MS) {
        _believed_lat_m = null;
        _believed_ts    = null;
        return null;
    }

    // Guard 1: last known correction must be within the 1 m pipe radius.
    // If the rover was already > 1 m off-center when we lost confidence, we can't
    // assume it's still in the same position — the scene may have changed.
    if (Math.abs(_believed_lat_m) > CROSSTRACK_MAX_M) {
        _believed_lat_m = null;
        _believed_ts    = null;
        return null;
    }

    // Guard 2: at least one positioning sensor must be steady.
    // If both GPS and compass are jumping, there's no anchor to confirm position.
    let gps_jitter = white_rabbit.robot_data && typeof white_rabbit.robot_data.gps_jitter_m === 'number'
        ? white_rabbit.robot_data.gps_jitter_m : null;
    let hdg_jitter = white_rabbit.imu_data && typeof white_rabbit.imu_data.heading_jitter_deg === 'number'
        ? white_rabbit.imu_data.heading_jitter_deg : null;

    let gps_steady = gps_jitter === null || gps_jitter < GPS_NOISY_M;
    let hdg_steady = hdg_jitter === null || hdg_jitter < HDG_NOISY_DEG;

    if (gps_jitter !== null && !gps_steady && hdg_jitter !== null && !hdg_steady) return null;

    // Fade linearly with age so the correction gracefully releases rather than snapping
    let fade = Math.max(0, 1.0 - age_ms / BELIEF_HOLD_MS);
    return { lateral_m: _believed_lat_m * fade, source: 'belief', age_ms: age_ms };

};

vision_belief.reset = function () {
    _believed_lat_m = null;
    _believed_ts    = null;
};

module.exports = vision_belief;
