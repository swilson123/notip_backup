// Single source of truth for heading.
// enable_imu (setup.json) true  → use the IMU heading (offset already baked in by connect_to_imu).
// enable_imu false / IMU absent → use the Pixhawk EKF heading (VFR_HUD) + compass_offset_deg.
var get_heading = function (white_rabbit) {
    if (white_rabbit.imu && white_rabbit.imu.enable_imu
        && white_rabbit.imu_data && white_rabbit.imu_data.connected
        && typeof white_rabbit.imu_data.heading === 'number') {
        return white_rabbit.imu_data.heading;
    }
    var offset = (white_rabbit.imu && typeof white_rabbit.imu.compass_offset_deg === 'number')
        ? white_rabbit.imu.compass_offset_deg : 0;
    var vfr = white_rabbit.robot_data && white_rabbit.robot_data.VFR_HUD && white_rabbit.robot_data.VFR_HUD.heading;
    if (typeof vfr === 'number') return ((vfr + offset) % 360 + 360) % 360;
    return (white_rabbit.imu_data && white_rabbit.imu_data.heading) || 0;
};

module.exports = get_heading;
