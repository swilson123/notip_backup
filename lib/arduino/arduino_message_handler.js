
var arduino_message_handler = function (white_rabbit, data) {
	const is_truthy = function (v) {
		return v === true || v === 1 || v === '1' || v === 'true';
	};

	try {
		white_rabbit.arduino.received_data = JSON.parse(data.replaceAll("'", '"'));

		//console.log("Received data: ", white_rabbit.arduino.received_data);

		if (white_rabbit.arduino.received_data.auto_delivery == 0 && white_rabbit.mission.auto_delivery) {
			console.log("Package Delivered! Return to dock");
			if (typeof white_rabbit.create_arduino_message === 'function') {
				white_rabbit.create_arduino_message(white_rabbit, 'stow_arm', 0);
			}
			// Mark that we are now waiting for the Arduino to confirm stow complete.
			// This gates follow_the_light so boot-time stowed=1 heartbeats can't
			// trigger docking before a mission has even started.
			if (white_rabbit.dock) {
				white_rabbit.dock.awaiting_stow_ack = true;
				white_rabbit.dock.stow_command_sent_at = Date.now();
			}
			white_rabbit.mission.auto_delivery = false;
			white_rabbit.mission.package_delivered = true;
			white_rabbit.mission.current_mission_seq -= 2;
			if (white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
				white_rabbit.learning.add('successful_delivery', {
					method: 'arduino',
					lat:    white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude,
					lng:    white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude
				});
			}
		}

		if (white_rabbit.dock && white_rabbit.dock.awaiting_stow_ack && is_truthy(white_rabbit.arduino.received_data.stowed)) {
			white_rabbit.dock.awaiting_stow_ack = false;
			if (!white_rabbit.dock.stow_confirmed) {
				white_rabbit.dock.stow_confirmed = true;
				console.log('Arduino reports stowed=true. Starting follow_the_light.');
				white_rabbit.follow_the_light(white_rabbit);
			}
		}
		

		white_rabbit.logs.arduino_message_handler.log(white_rabbit, 'Received data: ' + JSON.stringify(white_rabbit.arduino.received_data));
	}
	catch (e) {
		// Silently drop malformed fragments — the brace accumulator in
		// connect_to_arduino.js prevents this in normal operation.
		white_rabbit.logs.arduino_message_handler.log(white_rabbit, 'parse error (fragment dropped): ' + data.slice(0, 40));
	}

};

module.exports = arduino_message_handler;
