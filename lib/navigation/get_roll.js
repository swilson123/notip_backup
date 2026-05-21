var get_roll = function (rover) {
    if (rover.imu_data && rover.imu_data.connected) {
        return rover.imu_data.roll * (Math.PI / 180); // convert deg to radians to match ATTITUDE.roll units
    }
    return (rover.robot_data.ATTITUDE && rover.robot_data.ATTITUDE.roll) || 0;
};

module.exports = get_roll;
