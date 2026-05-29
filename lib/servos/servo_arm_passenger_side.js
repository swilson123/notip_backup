var servo_arm_passenger_side = function (white_rabbit, pwm_value) {

    
    // const data = {
    //     param1: 12,         // Servo number (e.g., 12 = SERVO12)
    //     param2: pwm_value, // 1000 = unlocked, 2000 = locked
    //     param3: 0,
    //     param4: 0,
    //     param5: 0,
    //     param6: 0,
    //     param7: 0
    // };

    // // Build MAVLink message
    // const mav_response = white_rabbit.mavlink_messages.MAV_CMD_DO_SET_SERVO(white_rabbit, data);

    // // Send to Pixhawk
    // white_rabbit.send_pixhawk_command(white_rabbit, mav_response[0], mav_response[1], null);

};


module.exports = servo_arm_passenger_side;