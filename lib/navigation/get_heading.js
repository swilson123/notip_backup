var get_heading = function (rover) {
    if (rover.imu_data && rover.imu_data.connected) {
        return rover.imu_data.heading;
    }
    return (rover.robot_data.VFR_HUD && rover.robot_data.VFR_HUD.heading) || 0;
};

module.exports = get_heading;
