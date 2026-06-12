// Single source of truth for roll (radians).
// enable_imu (setup.json) true  → use the IMU roll.
// enable_imu false / IMU absent → use the Pixhawk ATTITUDE roll.
var get_roll = function (white_rabbit) {
    if (white_rabbit.imu && white_rabbit.imu.enable_imu
        && white_rabbit.imu_data && white_rabbit.imu_data.connected
        && typeof white_rabbit.imu_data.roll === 'number') {
        return white_rabbit.imu_data.roll * (Math.PI / 180); // deg → rad to match ATTITUDE.roll units
    }
    return (white_rabbit.robot_data.ATTITUDE && white_rabbit.robot_data.ATTITUDE.roll) || 0;
};

module.exports = get_roll;
