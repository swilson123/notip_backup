var zling_motor_test = function (rover) {

    var motor_speed_cmd = 0;
    setTimeout(async () => {
        motor_speed_cmd = 100;
        rover.move_rover(rover, 1, motor_speed_cmd * -1, "zling_motor_test");
        rover.move_rover(rover, 2, motor_speed_cmd, "zling_motor_test");
        rover.move_rover(rover, 3, motor_speed_cmd, "zling_motor_test");
        rover.move_rover(rover, 4, motor_speed_cmd * -1, "zling_motor_test");

    }, 1000);


    setTimeout(async () => {
        motor_speed_cmd = -100;
        rover.move_rover(rover, 1, motor_speed_cmd * -1, "zling_motor_test");
        rover.move_rover(rover, 2, motor_speed_cmd, "zling_motor_test");
        rover.move_rover(rover, 3, motor_speed_cmd, "zling_motor_test");
        rover.move_rover(rover, 4, motor_speed_cmd * -1, "zling_motor_test");

    }, 5000);

    //Stop motors after 10 seconds
    setTimeout(async () => {
        clearInterval(feedbackInterval);
        await rover.motor.motor1_client.writeRegister(rover.zling.REG_L_TARGET_RPM, 0);
        await rover.motor.motor1_client.writeRegister(rover.zling.REG_R_TARGET_RPM, 0);
        await rover.motor.motor2_client.writeRegister(rover.zling.REG_L_TARGET_RPM, 0);
        await rover.motor.motor2_client.writeRegister(rover.zling.REG_R_TARGET_RPM, 0);
        console.log("Test Complete: Motors Stopped.");
        rover.motor.motor1_client.close();
        rover.motor.motor2_client.close();
    }, 10000);

};

module.exports = zling_motor_test;