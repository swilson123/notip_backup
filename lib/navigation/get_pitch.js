// Single source of truth for pitch (radians).
// enable_imu (setup.json) true  → use the IMU pitch.
// enable_imu false / IMU absent → use the Pixhawk ATTITUDE pitch.
var get_pitch = function (white_rabbit) {
    if (white_rabbit.imu && white_rabbit.imu.enable_imu
        && white_rabbit.imu_data && white_rabbit.imu_data.connected
        && typeof white_rabbit.imu_data.pitch === 'number') {
        return white_rabbit.imu_data.pitch * (Math.PI / 180); // deg → rad to match ATTITUDE.pitch units
    }
    return (white_rabbit.robot_data.ATTITUDE && white_rabbit.robot_data.ATTITUDE.pitch) || 0;
};

module.exports = get_pitch;
