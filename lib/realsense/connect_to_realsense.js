var connect_to_realsense = function (rover) {
	if (rover.realsense.port_path) {

		rover.realsense.serial = new rover.SerialPort({path: rover.realsense.port_path, baudRate: rover.realsense.baudrate});

		//When port is open
		rover.realsense.serial.on('open', function () {
			

			console.log('Connected to realsense on port: ' + rover.realsense.port_path);

			rover.logs.realsense_message_handler.log(rover, 'Connected to realsense on port: ' + rover.realsense.port_path);

			rover.realsense.connected = true;

			rover.realsense.serial.on('data', function (data) {

				//console.log(data);
			});

			rover.realsense.parser = rover.realsense.serial.pipe(new rover.Readline(
				{
					delimiter: '\r\n'
				}));


			rover.realsense.parser.on('data', function (input) {

				//console.log('realsense Data:', input);

				rover.realsense_message_handler(rover, input);

			});

			rover.realsense.parser.on('error', function (e) {
				console.log('rover.realsense.parser: ', e);

			});

		});

		rover.realsense.serial.on('close', function (e) {

			console.log('rover.realsense.serial close: ', e);
			rover.realsense.connected = false;

		});

		rover.realsense.serial.on('error', function (e) {

			console.log('rover.realsense.serial error: ', e);

		});


	}
	else{
		console.log('No realsense port defined');
	}
};

module.exports = connect_to_realsense;
