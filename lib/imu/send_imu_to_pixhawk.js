var send_imu_to_pixhawk = function (rover) {


    // Will Pixhawk use this as the default heading? Not yet — you need two ArduPilot param changes:

    // Parameter	Value	Why
    // EKF3_SRC1_YAW	6 (ExternalNav)	Tells EKF3 to use ATT_POS_MOCAP as its yaw source
    // COMPASS_USE	0	Stops the internal compass competing with it
    // Without those, ArduPilot receives the messages but silently ignores them for navigation. Once set, the EKF will use your IMU quaternion as the authoritative heading.

    // Set them in Mission Planner (Full Parameter List) or via MAVLink PARAM_SET. After changing EKF3_SRC1_YAW, reboot the Pixhawk.

    clearInterval(rover.imu_send_to_pixhawk_interval);
    rover.imu_send_to_pixhawk_interval = setInterval(() => {
        if (!rover.imu_data || !rover.imu_data.connected) return;

        const q = rover.imu_data.quaternion;
        const msg = new rover.mavlink.messages.att_pos_mocap(
            Date.now() * 1000,
            [q.w, q.x, q.y, q.z],
            0, 0, 0
        );

        rover.send_pixhawk_command(rover, 'att_pos_mocap', msg);
    }, 100);
};

module.exports = send_imu_to_pixhawk;
