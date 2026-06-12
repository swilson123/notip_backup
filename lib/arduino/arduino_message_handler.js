
var arduino_message_handler = function (white_rabbit, data) {
	const is_truthy = function (v) {
		return v === true || v === 1 || v === '1' || v === 'true';
	};

	try {
		white_rabbit.arduino.received_data = JSON.parse(data.replaceAll("'", '"'));

		//console.log("Received data: ", white_rabbit.arduino.received_data);

		// Watch the heartbeat's auto_delivery field for the 1 -> 0 edge. The Arduino
		// holds auto_delivery=1 while running its delivery sequence and flips it back
		// to 0 once the belt has fully retracted — i.e. delivery is complete. That
		// falling edge is the trigger to stow the arm for the trip home. (Edge-detected
		// on the Arduino's own reported value, so it no longer depends on the Node-side
		// mission.auto_delivery timer lining up.)
		const auto_delivery_now = is_truthy(white_rabbit.arduino.received_data.auto_delivery);
		const auto_delivery_completed = (white_rabbit.arduino.last_auto_delivery === true) && !auto_delivery_now;
		white_rabbit.arduino.last_auto_delivery = auto_delivery_now;

		if (auto_delivery_completed) {
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
		// Retry the stow command, driven by the 1 Hz heartbeat: while we're still
		// waiting for the stow ack and the Arduino reports it is not yet stowed,
		// re-send stow_arm every 3 s. This recovers from a single dropped serial
		// packet — otherwise the one-shot stow above could be lost and Noah would
		// wait forever for a stowed=1 that never comes.
		else if (white_rabbit.dock && white_rabbit.dock.awaiting_stow_ack
			&& !is_truthy(white_rabbit.arduino.received_data.stowed)) {
			if (!white_rabbit.dock.stow_command_sent_at
				|| (Date.now() - white_rabbit.dock.stow_command_sent_at) > 3000) {
				if (typeof white_rabbit.create_arduino_message === 'function') {
					white_rabbit.create_arduino_message(white_rabbit, 'stow_arm', 0);
				}
				white_rabbit.dock.stow_command_sent_at = Date.now();
				console.log('Stow not yet confirmed — re-sending stow_arm.');
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
