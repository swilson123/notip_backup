
var arduino_message_handler = function (white_rabbit, data) {

	try {
		white_rabbit.arduino.received_data = JSON.parse(data.replaceAll("'", '"'));

		if (white_rabbit.arduino.received_data.auto_delivery == 0 && white_rabbit.mission.auto_delivery) {
			console.log("Package Delivered! Return to dock");
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

		white_rabbit.logs.arduino_message_handler.log(white_rabbit, 'Received data: ' + JSON.stringify(white_rabbit.arduino.received_data));
	}
	catch (e) {
		// Silently drop malformed fragments — the brace accumulator in
		// connect_to_arduino.js prevents this in normal operation.
		white_rabbit.logs.arduino_message_handler.log(white_rabbit, 'parse error (fragment dropped): ' + data.slice(0, 40));
	}

};

module.exports = arduino_message_handler;
