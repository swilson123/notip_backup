//sends message to radio and websocket........................
var update_mav_mode = function (rover, mav_mode) {

	if (rover.MavStates[mav_mode] != 'MAV_STATE_UNINIT') {
		rover.flight_data.mav_state = rover.MavStates[mav_mode];


		rover.logs.update_mav_mode.log(rover, 'Mav State - ' + rover.flight_data.mav_state);
		console.log('Mav State - ' + rover.flight_data.mav_state);



		//Mav State............................................................
		if (rover.flight_data.mav_state == 'MAV_STATE_ACTIVE') {

			// //Reset Previous mission params.......
			// rover.reset_rover(rover);

			// console.log('Auto Flight Mode started: Request Full Mission');

			// rover.servos.bed.set_pwm = rover.servos.dump_tailer.max_pwm;
			// rover.servo_bed(rover, rover.servos.bed.set_pwm);

			// //request full mission.......
			// var mav_response = rover.mavlink_messages.MISSION_REQUEST_LIST(rover);

			// rover.send_pixhawk_command(rover, mav_response[0], mav_response[1], null);


		}
		else if (rover.flight_data.mav_state == 'MAV_STATE_CRITICAL') {



		}
		else if (rover.flight_data.mav_state == 'MAV_STATE_EMERGENCY') {



		}
		else if (rover.flight_data.mav_state == 'MAV_STATE_BOOT') {

			rover.disarm_robot(rover, null);


		}
		else if (rover.flight_data.mav_state == 'MAV_STATE_CALIBRATING') {


			rover.disarm_robot(rover, null);

		}
		else if (rover.flight_data.mav_state == 'MAV_STATE_POWEROFF') {

			rover.disarm_robot(rover, null);


		}
		else if (rover.flight_data.mav_state == 'MAV_STATE_FLIGHT_TERMINATION') {

			rover.disarm_robot(rover, null);


		}
		else if (rover.flight_data.mav_state == 'MAV_STATE_STANDBY') {

			rover.disarm_robot(rover, null);
			rover.servos.bed.set_pwm = rover.servos.dump_tailer.min_pwm;
			rover.servo_bed(rover, rover.servos.bed.set_pwm);

		}
		else {
			console.log('Unknown Mav State: ' + rover.flight_data.mav_state);
		}

	}

};


module.exports = update_mav_mode;