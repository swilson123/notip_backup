var radio_commands = function (white_rabbit, message) {
	var is_valid_pwm = function (value) {
		return Number.isFinite(value) && value >= 800 && value <= 2200;
	};

	// Reject boot/failsafe frames (0/65535/missing channels) so RC-dependent
	// actions cannot trigger when a transmitter is not actually connected.
	var has_valid_rc_frame = (
		is_valid_pwm(message.chan1_raw) &&
		is_valid_pwm(message.chan3_raw) &&
		is_valid_pwm(message.chan4_raw) &&
		is_valid_pwm(message.chan7_raw) &&
		is_valid_pwm(message.chan9_raw) &&
		is_valid_pwm(message.chan11_raw)
	);

	if (!has_valid_rc_frame) {
		white_rabbit.rc_contoller.connected = false;
		return;
	}

	if (typeof white_rabbit.rc_contoller.mission_switch_armed !== 'boolean') {
		white_rabbit.rc_contoller.mission_switch_armed = false;
	}

	//console.log("rc: ",message);
	//throttle command.....................
	white_rabbit.rc_contoller.connected = true;
	if (message.chan11_raw >= 1500) {
		white_rabbit.rc_contoller.mission_switch_armed = true;
	}


	white_rabbit.radio_claw_commands(white_rabbit, message);

	white_rabbit.radio_dock_commands(white_rabbit, message);

	if (message.chan9_raw > 1500 && white_rabbit.rplidar.avoid_object) {
		console.log("LIDAR Obstacle Avoidance Disabled");
		white_rabbit.rplidar.avoid_object = false;
		white_rabbit.mission.path_clear = true;
	}
	else if (message.chan9_raw <= 1500 && !white_rabbit.rplidar.avoid_object) {
		console.log("LIDAR Obstacle Avoidance Enabled");
		white_rabbit.rplidar.avoid_object = true;
	}

	if (
		message.chan11_raw < 1500 &&
		white_rabbit.rc_contoller.mission_switch_armed &&
		!white_rabbit.robot_data.mission_mode
	) {
		if (!white_rabbit.rc_contoller.connected) {
			console.log("Mission mode request ignored: RC controller not connected");
			return;
		}
		white_rabbit.rc_contoller.mission_switch_armed = false;
		white_rabbit.robot_data.mission_mode = true;
		white_rabbit.mission.first_leg_committed = false;
		white_rabbit.mission.first_leg_start_lat = white_rabbit.robot_data.robot_latitude || null;
		white_rabbit.mission.first_leg_start_lng = white_rabbit.robot_data.robot_longitude || null;

		// Start every mission with a clean avoidance state so navigation engages
		// immediately. If path_clear were left false (from a prior object detection,
		// an arm-time reset, or a previous mission) avoid_object would treat the
		// start as mid-avoidance and creep the rover forward without ever entering
		// mission navigation — the "just moves forward, never enters mission mode"
		// bug. Real obstacles still flip path_clear=false reactively once detected.
		white_rabbit.mission.path_clear = true;
		white_rabbit.mission.avoidance_timed_out = false;
		white_rabbit.mission.realsense_blocked_since = null;
		white_rabbit.mission.avoidance_start_grace_until = Date.now() + 4000;
		white_rabbit.mission.avoidance_turn = null;

		// Defensive: if something left a mission_interval running while
		// mission_mode was reset externally, don't double-spawn.
		if (white_rabbit.mission.mission_interval) {
			clearInterval(white_rabbit.mission.mission_interval);
		}
		white_rabbit.mission.mission_interval = setInterval(() => {
			white_rabbit.run_mission(white_rabbit);
		}, 250);

		if (white_rabbit.compass_calibration) white_rabbit.compass_calibration.start();

	}
	else if (message.chan11_raw >= 1500) {

		if (white_rabbit.robot_data.mission_mode) {
			white_rabbit.robot_data.mission_mode = false;
			clearInterval(white_rabbit.mission.mission_interval);
			white_rabbit.mission.first_leg_committed = false;
			white_rabbit.mission.first_leg_start_lat = null;
			white_rabbit.mission.first_leg_start_lng = null;
			console.log("Mission mode disabled by RC");
			white_rabbit.mission.avoidance_start_grace_until = null;
			//stop the white_rabbit	
			white_rabbit.move_white_rabbit(white_rabbit, 1, 0, "radio_commands");
			white_rabbit.move_white_rabbit(white_rabbit, 2, 0, "radio_commands");
			white_rabbit.move_white_rabbit(white_rabbit, 3, 0, "radio_commands");
			white_rabbit.move_white_rabbit(white_rabbit, 4, 0, "radio_commands");

			//turn wheels straight
			white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
			white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
			white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
			white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);
		}
	}

	// Voice override: while a voice motion command (nudge / spin) is running
	// in RC mode, suppress the stick-driven motor path so the nudge can
	// complete. Any stick deflection cancels the override and hands control
	// straight back to the operator — operator intent always wins.
	if (!white_rabbit.robot_data.mission_mode && Date.now() < (white_rabbit.voice_override_until || 0)) {
		var stick_deflected =
			message.chan3_raw < 1450 || message.chan3_raw > 1550 ||   // throttle
			message.chan4_raw < 1450 || message.chan4_raw > 1550 ||   // yaw
			message.chan1_raw < 1450 || message.chan1_raw > 1550;     // steering
		if (stick_deflected) {
			white_rabbit.voice_override_until = 0;
			if (white_rabbit.voice_nudge_timeout) {
				clearTimeout(white_rabbit.voice_nudge_timeout);
				white_rabbit.voice_nudge_timeout = null;
			}
			if (white_rabbit.voice_spin_interval) {
				clearInterval(white_rabbit.voice_spin_interval);
				white_rabbit.voice_spin_interval = null;
			}
			if (white_rabbit.mission) white_rabbit.mission.pause_mission = false;
			// fall through to the normal RC handler below
		} else {
			return;
		}
	}

	if (!white_rabbit.robot_data.mission_mode) {




		var throttle = message.chan3_raw;
		//console.log("throttle: ",throttle);

		var motor_speed_cmd = 0;


		if (!white_rabbit.rc_contoller.pause_cmd) {

			white_rabbit.rc_contoller.pause_cmd = true;

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
				//white_rabbit.servo_send_command(white_rabbit, 11, message.chan1_raw, true);
				//white_rabbit.servo_send_command(white_rabbit, 13, white_rabbit.opposite_pwm(message.chan1_raw), true);

				if (message.chan1_raw > 1450 && message.chan1_raw < 1550) {


					message.chan1_raw = 1550;
				}

				//console.log("Raw Steering PWM: ", message.chan1_raw);
				white_rabbit.motor.steering_angle_deg = white_rabbit.pwm_to_angle(message.chan1_raw);

				//console.log("Steering Angle Deg: ", white_rabbit.motor.steering_angle_deg);


				var steering_and_rpm = white_rabbit.calc_steering_and_rpm(white_rabbit, white_rabbit.motor.steering_angle_deg, motor_speed_cmd);

				//console.log("Steering Angles: ", steering_and_rpm.servo_angles_deg);
				//console.log("Motor RPMs: ", steering_and_rpm.motor_rpm);

				white_rabbit.servo_send_command(white_rabbit, 11, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_driver).servo1, true);
				white_rabbit.servo_send_command(white_rabbit, 13, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.front_passenger).servo2, true);
				white_rabbit.servo_send_command(white_rabbit, 12, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_driver).servo2, true);
				white_rabbit.servo_send_command(white_rabbit, 14, white_rabbit.angle_to_pwm(steering_and_rpm.servo_angles_deg.back_passenger).servo1, true);

				//All wheel drive logic
				//front passenger
				white_rabbit.move_white_rabbit(white_rabbit, 1, steering_and_rpm.motor_rpm.front_passenger, "radio_commands");
				//rear passenger side
				white_rabbit.move_white_rabbit(white_rabbit, 2, steering_and_rpm.motor_rpm.back_passenger, "radio_commands");
				//front driver side
				white_rabbit.move_white_rabbit(white_rabbit, 3, steering_and_rpm.motor_rpm.front_driver, "radio_commands");
				//rear driver side
				white_rabbit.move_white_rabbit(white_rabbit, 4, steering_and_rpm.motor_rpm.back_driver, "radio_commands");


				setTimeout(() => {
					//unpause rc controller
					white_rabbit.rc_contoller.pause_cmd = false;
				}, 250);

			}
			else {




				//4 tire steering logic
				var chan4_offset = message.chan4_raw - 1500;
				var yaw_degrees = chan4_offset < 0 ? -90 : 90;
				var yaw_motor_speed_cmd = Math.min(50, Math.round(Math.abs(chan4_offset) / 10));

				white_rabbit.yaw_white_rabbit(white_rabbit, yaw_degrees, yaw_motor_speed_cmd);

				setTimeout(() => {
					//unpause rc controller
					white_rabbit.rc_contoller.pause_cmd = false;
				}, 250);

			}

		}

	}

};


module.exports = radio_commands;