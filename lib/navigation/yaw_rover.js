var yaw_rover = function (rover, degrees, motor_speed_cmd) {
	//yaw_rover command.....................
	console.log("Yawing rover by degrees:", degrees);

	//Rest last motor speed command to 0 for yawing
	rover.motor.last_motor_speed_cmd = 0;


	if (motor_speed_cmd > 50) {
		motor_speed_cmd = 50;
	}

	rover.servo_send_command(rover, 11, 1750);

	rover.servo_send_command(rover, 12, 1750);
	rover.servo_send_command(rover, 13, 1750);
	rover.servo_send_command(rover, 14, 1750);

	setTimeout(() => {
		//front passenger counterclockwise
		if (degrees < 0) {
			rover.move_rover(rover, 1, motor_speed_cmd * -1, "yaw_rover");
		}
		else {
			//front passenger clockwise
			rover.move_rover(rover, 1, motor_speed_cmd, "yaw_rover");
		}

	}, 10);

	setTimeout(() => {
		if (degrees < 0) {
			rover.move_rover(rover, 4, motor_speed_cmd * -1, "yaw_rover");
		}
		else {
			//rear driver clockwise
			rover.move_rover(rover, 4, motor_speed_cmd, "yaw_rover");
		}
	}, 20);
	setTimeout(() => {
		//front driver side
		if (degrees < 0) {
			rover.move_rover(rover, 3, motor_speed_cmd * -1, "yaw_rover");
		}
		else {
			//front driver side clockwise
			rover.move_rover(rover, 3, motor_speed_cmd, "yaw_rover");
		}


	}, 30);
	setTimeout(() => {
		//rear passenger side

		if (degrees < 0) {
			rover.move_rover(rover, 2, motor_speed_cmd * -1, "yaw_rover");
		}
		else {
			//rear passenger clockwise
			rover.move_rover(rover, 2, motor_speed_cmd, "yaw_rover");
		}


	}, 40);

};


module.exports = yaw_rover;