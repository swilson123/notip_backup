var ATTITUDE_STALE_MS = 2000;

var get_pitch = function (white_rabbit) {
    var now = Date.now();

    var imu_ts    = white_rabbit.imu_data && white_rabbit.imu_data.timestamp;
    var imu_fresh = white_rabbit.imu_data && white_rabbit.imu_data.connected
                    && imu_ts && (now - imu_ts) < ATTITUDE_STALE_MS;

    if (imu_fresh) return white_rabbit.imu_data.pitch * (Math.PI / 180);

    var att    = white_rabbit.robot_data && white_rabbit.robot_data.ATTITUDE;
    var att_ts = white_rabbit.robot_data && white_rabbit.robot_data.attitude_ts;
    var att_fresh = att && att_ts && (now - att_ts) < ATTITUDE_STALE_MS;

    if (att_fresh) return att.pitch;

    // Both stale — return last known. The star still shines.
    if (white_rabbit.imu_data && typeof white_rabbit.imu_data.pitch === 'number') {
        return white_rabbit.imu_data.pitch * (Math.PI / 180);
    }
    return (att && att.pitch) || 0;
};

module.exports = get_pitch;
