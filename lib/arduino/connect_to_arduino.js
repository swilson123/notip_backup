var connect_to_arduino = function (rover) {
	if (rover.arduino.port_path) {

		rover.arduino.serial = new rover.SerialPort({path: rover.arduino.port_path, baudRate: rover.arduino.baudrate});

		//When port is open
		rover.arduino.serial.on('open', function () {
			

			console.log('Connected to arduino on port: ' + rover.arduino.port_path);

			rover.logs.arduino_message_handler.log(rover, 'Connected to arduino on port: ' + rover.arduino.port_path);

			rover.arduino.connected = true;

			// Brace-depth accumulator — collects raw bytes until a complete
			// JSON object {...} is assembled, then fires the message handler.
			// Protects against messages fragmented across serial TX buffer flushes.
			let _json_buf  = '';
			let _brace_depth = 0;

			rover.arduino.serial.on('data', function (chunk) {
				const s = chunk.toString();
				for (let i = 0; i < s.length; i++) {
					const ch = s[i];
					if (ch === '{') {
						if (_brace_depth === 0) _json_buf = '';
						_brace_depth++;
					}
					if (_brace_depth > 0) _json_buf += ch;
					if (ch === '}' && _brace_depth > 0) {
						_brace_depth--;
						if (_brace_depth === 0) {
							rover.arduino_message_handler(rover, _json_buf);
							_json_buf = '';
						}
					}
				}
			});

		});

		rover.arduino.serial.on('close', function (e) {

			console.log('rover.arduino.serial close: ', e);
			rover.arduino.connected = false;

		});

		rover.arduino.serial.on('error', function (e) {

			console.log('rover.arduino.serial error: ', e);

		});


	}
	else{
		console.log('No arduino port defined');
	}
};

module.exports = connect_to_arduino;
