var create_arduino_message = function (rover, message, value) {

//Available commands to send to arduino
//Commands: deliver_package, belt, arm

	if (rover.arduino.serial) {
		try {
			console.log('Sending to arduino: ', message + ' with value: ' + value);
			rover.logs.arduino_message_handler.log(rover, 'Sending to arduino: ' + message);
			rover.arduino.serial.write('{"message": "' + message + '", "value": "' + value + '"}\n');
		} catch (e) {
			console.log(e);
			rover.logs.arduino_message_handler.error('Error writing to arduino port: ', e);
		}

	} else {
		console.log('Arduino Port not connected! Message failed to send:', message);
	}
};

module.exports = create_arduino_message;
