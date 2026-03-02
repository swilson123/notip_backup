var connect_to_arduino = function (rover) {
	if (rover.arduino.port_path) {

		rover.arduino.serial = new rover.SerialPort({path: rover.arduino.port_path, baudRate: rover.arduino.baudrate});

		//When port is open
		rover.arduino.serial.on('open', function () {
			

			console.log('Connected to arduino on port: ' + rover.arduino.port_path);

			rover.logs.arduino_message_handler.log(rover, 'Connected to arduino on port: ' + rover.arduino.port_path);

			rover.arduino.connected = true;

			rover.arduino.serial.on('data', function (data) {

				//console.log(data);
			});

			rover.arduino.parser = rover.arduino.serial.pipe(new rover.Readline(
				{
					delimiter: '\r\n'
				}));


			rover.arduino.parser.on('data', function (input) {

				//console.log('arduino Data:', input);

				rover.arduino_message_handler(rover, input);

			});

			rover.arduino.parser.on('error', function (e) {
				console.log('rover.arduino.parser: ', e);

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
