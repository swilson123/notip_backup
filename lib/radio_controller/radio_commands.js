var radio_commands = function (rover, message) {

	//console.log("rc: ",message);
	//throttle command.....................
	rover.rc_contoller.connected = true;


	rover.radio_claw_commands(rover, message);

	if (message.chan9_raw > 1500 && rover.rplidar.avoid_object) {
		console.log("LIDAR Obstacle Avoidance Disabled");
		rover.rplidar.avoid_object = false;
		rover.mission.path_clear = true;
	}
	else if (message.chan9_raw <= 1500 && !rover.rplidar.avoid_object) {
		console.log("LIDAR Obstacle Avoidance Enabled");
		rover.rplidar.avoid_object = true;
	}

	if (message.chan11_raw < 1500 && !rover.robot_data.mission_mode) {
		rover.robot_data.mission_mode = true;

		rover.mission.mission_interval = setInterval(() => {
			rover.run_mission(rover);
		}, 250);


	}
	else if (message.chan11_raw >= 1500) {

		if (rover.robot_data.mission_mode) {
			rover.robot_data.mission_mode = false;
			clearInterval(rover.mission.mission_interval);
			+		console.log("Mission mode disabled by RC");
			//stop the rover	
			rover.move_rover(rover, 1, 0, "radio_commands");
			rover.move_rover(rover, 2, 0, "radio_commands");
			rover.move_rover(rover, 3, 0, "radio_commands");
			rover.move_rover(rover, 4, 0, "radio_commands");

			//turn wheels straight
			rover.servo_send_command(rover, 11, 1500, false);
			rover.servo_send_command(rover, 12, 1500, false);
			rover.servo_send_command(rover, 13, 1500, false);
			rover.servo_send_command(rover, 14, 1500, false);
		}
	}

	if (!rover.robot_data.mission_mode) {




		var throttle = message.chan3_raw;
		//console.log("throttle: "throttle);

		var motor_speed_cmd = 0;


		if (!rover.rc_contoller.pause_cmd) {

			rover.rc_contoller.pause_cmd = true;

			if (throttle > 1900) {
				motor_speed_cmd = 200;

			} else if (throttle > 1850) {
				motor_speed_cmd = 175;
			}
			else if (throttle > 1800) {
				motor_speed_cmd = 150;
			}
			else if (throttle > 1750) {
				motor_speed_cmd = 125;
			}
			else if (throttle > 1700) {
				motor_speed_cmd = 100;
			}
			else if (throttle > 1650) {
				motor_speed_cmd = 75;
			}
			else if (throttle > 1600) {
				motor_speed_cmd = 50;
			}
			else if (throttle > 1550) {
				motor_speed_cmd = 25;
			}
			else if (throttle > 1450) {
				motor_speed_cmd = 0;
			}
			else if (throttle > 1400) {
				motor_speed_cmd = -25;
			}
			else if (throttle > 1350) {
				motor_speed_cmd = -50;
			}
			else if (throttle > 1300) {
				motor_speed_cmd = -75;
			}
			else if (throttle > 1250) {
				motor_speed_cmd = -100;
			}
			else if (throttle > 1200) {
				motor_speed_cmd = -125;
			}
			else if (throttle > 1150) {
				motor_speed_cmd = -150;
			}
			else if (throttle > 1100) {
				motor_speed_cmd = -175;
			}
			else {
				motor_speed_cmd = -200;
			}


			if (message.chan4_raw > 1450 && message.chan4_raw < 1550) {
				//2 tire steering logic
				// rover.servo_send_command(rover, 11, message.chan1_raw, true);
				// rover.servo_send_command(rover, 13, rover.opposite_pwm(message.chan1_raw), true);
				var steering_angle_deg = rover.pwm_to_angle(message.chan1_raw);
				console.log("Steering Angle Deg: ", steering_angle_deg);

				if (steering_angle_deg > 12) {
					steering_angle_deg = 12;
				}
				else if (steering_angle_deg < -12) {
					steering_angle_deg = -12;
				}

				var steering_and_rpm = rover.calc_steering_and_rpm(rover, steering_angle_deg, motor_speed_cmd);

				console.log("Steering Angles: ", steering_and_rpm.servo_angles_deg);
				console.log("Motor RPMs: ", steering_and_rpm.motor_rpm);

				rover.servo_send_command(rover, 11, rover.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_driver).servo1, true);
				rover.servo_send_command(rover, 13, rover.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_passenger).servo2, true);
				rover.servo_send_command(rover, 12, rover.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_driver).servo2, true);
				rover.servo_send_command(rover, 14, rover.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_passenger).servo1, true);

				//All wheel drive logic

				setTimeout(() => {
					if (message.chan1_raw > 1450 && message.chan1_raw < 1550) {
						rover.move_rover(rover, 1, steering_and_rpm.motor_rpm.front_passenger * -1, "radio_commands");
					}
					else {
						rover.move_rover(rover, 1, steering_and_rpm.motor_rpm.front_passenger, "radio_commands");
					}



				}, 10);


				//rear passenger side
				setTimeout(() => {
					if (message.chan1_raw > 1450 && message.chan1_raw < 1550) {
						rover.move_rover(rover, 2, steering_and_rpm.motor_rpm.back_passenger * -1, "radio_commands");
					} else {
						rover.move_rover(rover, 2, steering_and_rpm.motor_rpm.back_passenger, "radio_commands");
					}


				}, 20);

				setTimeout(() => {
					rover.move_rover(rover, 3, steering_and_rpm.motor_rpm.front_driver, "radio_commands");
				}, 30);

				setTimeout(() => {
					rover.move_rover(rover, 4, steering_and_rpm.motor_rpm.back_driver, "radio_commands");
				}, 40);


				setTimeout(() => {
					//unpause rc controller
					rover.rc_contoller.pause_cmd = false;
				}, 250);

			}
			else {



				//4 tire steering logic
				setTimeout(() => {
					//front passenger
					if (message.chan4_raw > 1450 && message.chan4_raw < 1550 || message.chan4_raw > 1900 || message.chan4_raw < 1100) {
						rover.move_rover(rover, 1, motor_speed_cmd * -1, "radio_commands");

					} else {
						rover.move_rover(rover, 1, motor_speed_cmd, "radio_commands");
					}

				}, 10);

				setTimeout(() => {

					//rear passenger side
					if (message.chan4_raw < 1450 || message.chan4_raw > 1550 || message.chan4_raw > 1900 || message.chan4_raw < 1100) {
						rover.move_rover(rover, 2, motor_speed_cmd, "radio_commands");
					} else {
						rover.move_rover(rover, 2, motor_speed_cmd * -1, "radio_commands");
					}

				}, 20);

				setTimeout(() => {
					//front driver side
					if (message.chan4_raw > 1900 || message.chan4_raw < 1100) {
						rover.move_rover(rover, 3, motor_speed_cmd * -1, "radio_commands");
					} else {
						rover.move_rover(rover, 3, motor_speed_cmd, "radio_commands");
					}


				}, 30);
				setTimeout(() => {
					//rear driver side

					rover.move_rover(rover, 4, motor_speed_cmd, "radio_commands");


				}, 40);

				setTimeout(() => {
					//unpause rc controller
					rover.rc_contoller.pause_cmd = false;
				}, 250);

			}

		}

	}

};


module.exports = radio_commands;