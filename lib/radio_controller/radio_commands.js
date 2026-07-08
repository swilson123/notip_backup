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
	if (typeof white_rabbit.rc_contoller.mission_start_pending !== 'boolean') {
		white_rabbit.rc_contoller.mission_start_pending = false;
	}

	//console.log("rc: ",message);
	//throttle command.....................
	white_rabbit.rc_contoller.connected = true;

	// RC edge-capture logging — active only during a data-collection session
	// (started/stopped by the real vehicle arm/disarm switch — see
	// white_rabbit.robot_data.is_armed transitions in pixhawk_message_handler.js).
	// Sampled off every valid RC frame rather than the mission tick, so it keeps
	// recording independent of whichever switch (chan11 RC/Mission) is driving.
	//
	// mission_mode true means follow_the_yellow_brick_road/carrot are actually
	// driving Noah, not the sticks — log what THEY commanded (white_rabbit.motor.*,
	// set every tick in follow_the_yellow_brick_road.js) instead of the idle stick
	// position, or this would just log "stick centered" the whole autonomous run.
	if (white_rabbit.rc_edge_capture && white_rabbit.rc_edge_capture.active && white_rabbit.rc_edge_capture.logger) {
		var _capture_pd = (white_rabbit.realsense && white_rabbit.realsense.path_detection) || {};
		var _capture_steer_deg, _capture_servo_angles, _capture_speed_cmd;
		if (white_rabbit.robot_data.mission_mode) {
			_capture_steer_deg = white_rabbit.motor.steering_angle_deg;
			_capture_servo_angles = white_rabbit.motor.servo_angles_deg || {};
			_capture_speed_cmd = white_rabbit.motor.speed_cmd;
		} else {
			_capture_steer_deg = white_rabbit.pwm_to_angle(message.chan1_raw);
			// servo_angles_deg is a fixed Ackermann-geometry function of steer_deg alone
			// (base_rpm only affects motor_rpm) — safe to recompute here for logging.
			_capture_servo_angles = white_rabbit.calc_steering_and_rpm(white_rabbit, _capture_steer_deg, 0).servo_angles_deg;
			_capture_speed_cmd = null;
		}
		white_rabbit.rc_edge_capture.logger.log(white_rabbit, {
			// Epoch ms, same unit/clock as this session's frame_<epoch ms>.jpg screenshots
			// (see realsense_vision.py _render_display and the capture_dir this session
			// gets in pixhawk_message_handler.js) -- the logger line itself is only
			// timestamped to the second, so this is what actually lets a frame be matched
			// to the log lines around it.
			ts:           Date.now(),
			mode:         white_rabbit.robot_data.mission_mode ? 'auto' : 'rc',
			lat:          white_rabbit.robot_data.robot_latitude,
			lng:          white_rabbit.robot_data.robot_longitude,
			hdg:          white_rabbit.get_heading(white_rabbit),
			el_x:         _capture_pd.edge_left_x_m,
			el_y:         _capture_pd.edge_left_y_m,
			el_c:         _capture_pd.edge_left_conf,
			er_x:         _capture_pd.edge_right_x_m,
			er_y:         _capture_pd.edge_right_y_m,
			er_c:         _capture_pd.edge_right_conf,
			steer_pwm:    message.chan1_raw,
			steer_deg:    _capture_steer_deg,
			servo_fd:     _capture_servo_angles.front_driver,
			servo_fp:     _capture_servo_angles.front_passenger,
			servo_bd:     _capture_servo_angles.back_driver,
			servo_bp:     _capture_servo_angles.back_passenger,
			speed_cmd:    _capture_speed_cmd,
			throttle_pwm: message.chan3_raw
		});
	}

	if (message.chan11_raw >= 1500) {
		white_rabbit.rc_contoller.mission_switch_armed = true;
		white_rabbit.rc_contoller.mission_start_pending = false;
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
		white_rabbit.rc_contoller.mission_start_pending = true;
		white_rabbit.mission.first_leg_committed = false;
		white_rabbit.mission.first_leg_start_lat = white_rabbit.robot_data.robot_latitude || null;
		white_rabbit.mission.first_leg_start_lng = white_rabbit.robot_data.robot_longitude || null;

		let undock_in_progress = !!white_rabbit.dock.undock_interval ||
			white_rabbit.dock.dock_state === 'docked' ||
			white_rabbit.dock.dock_state === 'undocking_ramp' ||
			white_rabbit.dock.dock_state === 'undocked' ||
			(white_rabbit.dock.start_mission_after_undock && white_rabbit.dock.dock_state !== 'undocked_completed');
		if (undock_in_progress) {
			console.log("Mission start queued until undock completes");
			return;
		}

		white_rabbit.rc_contoller.mission_start_pending = false;
		white_rabbit.robot_data.mission_mode = true;
		white_rabbit.dock.manual_dock_required = false;

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
		}, 100);

		if (white_rabbit.compass_calibration) white_rabbit.compass_calibration.start();

	}
	else if (message.chan11_raw >= 1500) {

		if (white_rabbit.robot_data.mission_mode) {
			white_rabbit.robot_data.mission_mode = false;
			clearInterval(white_rabbit.mission.mission_interval);
			white_rabbit.mission.first_leg_committed = false;
			white_rabbit.mission.first_leg_start_lat = null;
			white_rabbit.mission.first_leg_start_lng = null;
			white_rabbit.rc_contoller.mission_start_pending = false;
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