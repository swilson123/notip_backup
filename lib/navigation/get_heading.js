var get_heading = function (white_rabbit) {

    // Prefer VFR_HUD heading from the Pixhawk EKF (fed by BNO055 quaternion via att_pos_mocap).
    // typeof guard: heading=0 (North) is valid but falsy — cannot use truthiness check.
    var vfr = white_rabbit.robot_data && white_rabbit.robot_data.VFR_HUD && white_rabbit.robot_data.VFR_HUD.heading;
    if (typeof vfr === 'number') return vfr;

    // IMU fallback: direct BNO055 heading with software compass offset applied.
    var imu = white_rabbit.imu_data && white_rabbit.imu_data.heading;
    if (typeof imu === 'number') return imu;

    return 0;

};

module.exports = get_heading;
