var dock_rover = function (rover) {

	if (rover.robot_data.is_armed) {
		if (!rover.imu_data.connected && !rover.robot_data.ATTITUDE) {
			console.log("Dock waiting for ATTITUDE message");
			return;
		}

		var motor_speed_cmd = 25;
		var ramp_detect_pitch_delta = 0.12; // ~6.9 deg
		var level_pitch_tolerance = 0.07;   // ~4.0 deg
		var post_ramp_drive_ms = 3000;

		if (!rover.dock.dock_state) {
			console.log("Docking Rover");
			rover.dock.dock_state = "docking_ground";
			rover.dock.follow_state = {};   // reset IRLock follow state each dock attempt

			// Record ground pose once at dock start for pitch/heading reference.
			rover.dock.undock_latitude = rover.robot_data.robot_latitude;
			rover.dock.undock_longitude = rover.robot_data.robot_longitude;
			rover.dock.undock_pitch = rover.get_pitch(rover);
			rover.dock.undock_heading = rover.get_heading(rover);

			rover.dock.ramp_started_at = null;
		}
		else if (rover.dock.dock_state === "docking_ground") {
			// If IRLock beacon is visible, hand off to follow_the_light for precision
			// alignment and ramp climb using the IR beacon + pitch/roll compensation.
			// follow_the_light drives the motors and sets dock_state = 'docked_completed'.
			if (rover.irlock && rover.irlock.connected
					&& rover.irlock_message_handler.is_fresh(rover)) {
				rover.follow_the_light(rover);
				return;
			}

			// Beacon not visible — fall back to pitch-based approach.
			rover.move_rover(rover, 1, motor_speed_cmd, "dock_rover");
			rover.move_rover(rover, 4, motor_speed_cmd * -1, "dock_rover");
			rover.move_rover(rover, 3, motor_speed_cmd * -1, "dock_rover");
			rover.move_rover(rover, 2, motor_speed_cmd, "dock_rover");

			var pitch_delta = rover.get_pitch(rover) - rover.dock.undock_pitch;

			// Enter ramp state once pitch departs enough from initial ground pitch.
			if (Math.abs(pitch_delta) >= ramp_detect_pitch_delta) {
				rover.dock.dock_state = "docking_ramp";
				rover.dock.ramp_started_at = Date.now();
				console.log("Rover going up the ramp");
			}
		}
		else if (rover.dock.dock_state === "docking_ramp") {
			// Continue backing up while climbing ramp.
			rover.move_rover(rover, 1, motor_speed_cmd, "dock_rover");
			rover.move_rover(rover, 4, motor_speed_cmd * -1, "dock_rover");
			rover.move_rover(rover, 3, motor_speed_cmd * -1, "dock_rover");
			rover.move_rover(rover, 2, motor_speed_cmd, "dock_rover");

			var ramp_pitch_delta = rover.get_pitch(rover) - rover.dock.undock_pitch;
			var on_ramp_long_enough = rover.dock.ramp_started_at && (Date.now() - rover.dock.ramp_started_at > 1000);

			// Consider ramp complete when pitch settles near initial level after at least 1s on ramp.
			if (on_ramp_long_enough && Math.abs(ramp_pitch_delta) <= level_pitch_tolerance) {
				rover.dock.dock_state = "docking_top";
				console.log("Rover reached top of the ramp");
			}
		}
		else if (rover.dock.dock_state === "docking_top") {
			// Continue backing up for 3 seconds after reaching top of ramp.
			rover.move_rover(rover, 1, motor_speed_cmd, "dock_rover");
			rover.move_rover(rover, 4, motor_speed_cmd * -1, "dock_rover");
			rover.move_rover(rover, 3, motor_speed_cmd * -1, "dock_rover");
			rover.move_rover(rover, 2, motor_speed_cmd, "dock_rover");

			if (!rover.dock.dock_complete_timeout) {
				rover.dock.dock_complete_timeout = setTimeout(() => {
					rover.dock.dock_state = "docked_completed";
					rover.dock.dock_complete_timeout = null;
					console.log("Rover finished docking drive at top of ramp");
				}, post_ramp_drive_ms);
			}
		}
		else if (rover.dock.dock_state === "docked_completed") {
			// Record final dock pose.
			rover.dock.dock_latitude = rover.robot_data.robot_latitude;
			rover.dock.dock_longitude = rover.robot_data.robot_longitude;
			rover.dock.dock_pitch = rover.get_pitch(rover);
			rover.dock.dock_heading = rover.get_heading(rover);

			// Stop rover.
			rover.move_rover(rover, 1, 0, "dock_rover");
			rover.move_rover(rover, 4, 0, "dock_rover");
			rover.move_rover(rover, 3, 0, "dock_rover");
			rover.move_rover(rover, 2, 0, "dock_rover");

			// Stop dock loop once completed.
			if (rover.dock.dock_interval) {
				clearInterval(rover.dock.dock_interval);
				rover.dock.dock_interval = null;
			}

			rover.dock.dock_state = "docked";
			console.log("Dock complete, rover is now on the dock");
		}
	} else {
		console.log("Rover is disarmed.");
	}


};

module.exports = dock_rover;
