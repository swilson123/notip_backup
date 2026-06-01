var create_arduino_message = function (white_rabbit, message, value) {

//Available commands to send to arduino
//Commands: deliver_package, stow_arm, belt, arm, telescope

	if (white_rabbit.arduino.serial) {
		try {
			console.log('Sending to arduino: ', message + ' with value: ' + value);
			white_rabbit.logs.arduino_message_handler.log(white_rabbit, 'Sending to arduino: ' + message);
			white_rabbit.arduino.serial.write('{"message": "' + message + '", "value": "' + value + '"}\n');
		} catch (e) {
			console.log(e);
			white_rabbit.logs.arduino_message_handler.error('Error writing to arduino port: ', e);
		}

	} else {
		console.log('Arduino Port not connected! Message failed to send:', message);
	}
};

module.exports = create_arduino_message;
