var get_pitch = function (white_rabbit) {
    if (white_rabbit.imu_data && white_rabbit.imu_data.connected) {
        return white_rabbit.imu_data.pitch * (Math.PI / 180); // convert deg to radians to match ATTITUDE.pitch units
    }
    return (white_rabbit.robot_data.ATTITUDE && white_rabbit.robot_data.ATTITUDE.pitch) || 0;
};

module.exports = get_pitch;
