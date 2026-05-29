//sends message to radio and websocket........................
var update_mav_mode = function (white_rabbit, mav_mode) {

	if (white_rabbit.MavStates[mav_mode] != 'MAV_STATE_UNINIT') {
		white_rabbit.flight_data.mav_state = white_rabbit.MavStates[mav_mode];


		white_rabbit.logs.update_mav_mode.log(white_rabbit, 'Mav State - ' + white_rabbit.flight_data.mav_state);
		console.log('Mav State - ' + white_rabbit.flight_data.mav_state);



		//Mav State............................................................
		if (white_rabbit.flight_data.mav_state == 'MAV_STATE_ACTIVE') {

			// //Reset Previous mission params.......
			// white_rabbit.reset_white_rabbit(white_rabbit);

			// console.log('Auto Flight Mode started: Request Full Mission');

			// white_rabbit.servos.bed.set_pwm = white_rabbit.servos.dump_tailer.max_pwm;
			// white_rabbit.servo_bed(white_rabbit, white_rabbit.servos.bed.set_pwm);

			// //request full mission.......
			// var mav_response = white_rabbit.mavlink_messages.MISSION_REQUEST_LIST(white_rabbit);

			// white_rabbit.send_pixhawk_command(white_rabbit, mav_response[0], mav_response[1], null);


		}
		else if (white_rabbit.flight_data.mav_state == 'MAV_STATE_CRITICAL') {



		}
		else if (white_rabbit.flight_data.mav_state == 'MAV_STATE_EMERGENCY') {



		}
		else if (white_rabbit.flight_data.mav_state == 'MAV_STATE_BOOT') {

			white_rabbit.disarm_robot(white_rabbit, null);


		}
		else if (white_rabbit.flight_data.mav_state == 'MAV_STATE_CALIBRATING') {


			white_rabbit.disarm_robot(white_rabbit, null);

		}
		else if (white_rabbit.flight_data.mav_state == 'MAV_STATE_POWEROFF') {

			white_rabbit.disarm_robot(white_rabbit, null);


		}
		else if (white_rabbit.flight_data.mav_state == 'MAV_STATE_FLIGHT_TERMINATION') {

			white_rabbit.disarm_robot(white_rabbit, null);


		}
		else if (white_rabbit.flight_data.mav_state == 'MAV_STATE_STANDBY') {

			white_rabbit.disarm_robot(white_rabbit, null);
			white_rabbit.servos.bed.set_pwm = white_rabbit.servos.dump_tailer.min_pwm;
			white_rabbit.servo_bed(white_rabbit, white_rabbit.servos.bed.set_pwm);

		}
		else {
			console.log('Unknown Mav State: ' + white_rabbit.flight_data.mav_state);
		}

	}

};


module.exports = update_mav_mode;