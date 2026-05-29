var zling_motor_test = function (white_rabbit) {

    var motor_speed_cmd = 0;
    setTimeout(async () => {
        motor_speed_cmd = 100;
        white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd * -1, "zling_motor_test");
        white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "zling_motor_test");
        white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd, "zling_motor_test");
        white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "zling_motor_test");

    }, 1000);


    setTimeout(async () => {
        motor_speed_cmd = -100;
        white_rabbit.move_white_rabbit(white_rabbit, 1, motor_speed_cmd * -1, "zling_motor_test");
        white_rabbit.move_white_rabbit(white_rabbit, 2, motor_speed_cmd, "zling_motor_test");
        white_rabbit.move_white_rabbit(white_rabbit, 3, motor_speed_cmd, "zling_motor_test");
        white_rabbit.move_white_rabbit(white_rabbit, 4, motor_speed_cmd * -1, "zling_motor_test");

    }, 5000);

    //Stop motors after 10 seconds
    setTimeout(async () => {
        clearInterval(feedbackInterval);
        await white_rabbit.motor.motor1_client.writeRegister(white_rabbit.zling.REG_L_TARGET_RPM, 0);
        await white_rabbit.motor.motor1_client.writeRegister(white_rabbit.zling.REG_R_TARGET_RPM, 0);
        await white_rabbit.motor.motor2_client.writeRegister(white_rabbit.zling.REG_L_TARGET_RPM, 0);
        await white_rabbit.motor.motor2_client.writeRegister(white_rabbit.zling.REG_R_TARGET_RPM, 0);
        console.log("Test Complete: Motors Stopped.");
        white_rabbit.motor.motor1_client.close();
        white_rabbit.motor.motor2_client.close();
    }, 10000);

};

module.exports = zling_motor_test;