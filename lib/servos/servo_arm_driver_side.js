var servo_arm_driver_side = function (rover, pwm_value) {

    
    // const data = {
    //     param1: 11,         // Servo number (e.g., 10 = SERVO10)
    //     param2: pwm_value, // 1000 = unlocked, 2000 = locked
    //     param3: 0,
    //     param4: 0,
    //     param5: 0,
    //     param6: 0,
    //     param7: 0
    // };

    // // Build MAVLink message
    // const mav_response = rover.mavlink_messages.MAV_CMD_DO_SET_SERVO(rover, data);

    // // Send to Pixhawk
    // rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);

};


module.exports = servo_arm_driver_side;