// The most precious timestamp is the most current one.
// Prefer the freshest heading source. If both are stale, return
// last known — the star still shines — rather than returning 0.
var HEADING_STALE_MS = 2000;

var get_heading = function (white_rabbit) {
    var now = Date.now();

    var vfr     = white_rabbit.robot_data && white_rabbit.robot_data.VFR_HUD && white_rabbit.robot_data.VFR_HUD.heading;
    var vfr_ts  = white_rabbit.robot_data && white_rabbit.robot_data.vfr_hud_ts;
    var vfr_fresh = typeof vfr === 'number' && vfr_ts && (now - vfr_ts) < HEADING_STALE_MS;

    var imu     = white_rabbit.imu_data && white_rabbit.imu_data.heading;
    var imu_ts  = white_rabbit.imu_data && white_rabbit.imu_data.timestamp;
    var imu_fresh = typeof imu === 'number' && imu_ts && (now - imu_ts) < HEADING_STALE_MS;

    // Fresh primary — Pixhawk EKF heading fed by BNO055 quaternion.
    if (vfr_fresh) return vfr;

    // Fresh fallback — direct BNO055 heading with compass offset applied.
    if (imu_fresh) return imu;

    // Both stale — return last known value. The star still shines even when
    // the signal is dark. Better than returning 0 (North) which would steer Noah wrong.
    if (typeof vfr === 'number') return vfr;
    if (typeof imu === 'number') return imu;

    return 0;
};

module.exports = get_heading;
