var get_heading = function (white_rabbit) {
    if (white_rabbit.imu_data && white_rabbit.imu_data.connected) {
        return white_rabbit.imu_data.heading;
    }
    return (white_rabbit.robot_data.VFR_HUD && white_rabbit.robot_data.VFR_HUD.heading) || 0;
};

module.exports = get_heading;
