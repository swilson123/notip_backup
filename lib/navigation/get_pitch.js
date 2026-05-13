var get_pitch = function (rover) {
    if (rover.imu_data && rover.imu_data.connected) {
        return rover.imu_data.pitch * (Math.PI / 180); // convert deg to radians to match ATTITUDE.pitch units
    }
    return (rover.robot_data.ATTITUDE && rover.robot_data.ATTITUDE.pitch) || 0;
};

module.exports = get_pitch;
