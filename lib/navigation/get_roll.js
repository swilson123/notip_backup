var get_roll = function (white_rabbit) {
    if (white_rabbit.imu_data && white_rabbit.imu_data.connected) {
        return white_rabbit.imu_data.roll * (Math.PI / 180); // convert deg to radians to match ATTITUDE.roll units
    }
    return (white_rabbit.robot_data.ATTITUDE && white_rabbit.robot_data.ATTITUDE.roll) || 0;
};

module.exports = get_roll;
