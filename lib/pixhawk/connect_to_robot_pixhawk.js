//sends message to radio and websocket........................
var connect_to_robot_pixhawk = function (rover) {
	var pixhawk_port = rover.pixhawk_port;

	var clear_heartbeat_timeout = function () {
		if (pixhawk_port.heartbeatTimeout) {
			clearTimeout(pixhawk_port.heartbeatTimeout);
			pixhawk_port.heartbeatTimeout = null;
		}
	};

	var reset_connection_state = function () {
		clear_heartbeat_timeout();
		pixhawk_port.serial = null;
		pixhawk_port.mavlink = null;
		pixhawk_port.connected = false;
		pixhawk_port.opening = false;
	};

	if (pixhawk_port.connected === false) {
		if (pixhawk_port.opening || pixhawk_port.serial) {
			return;
		}

		var port_path = pixhawk_port.comName || pixhawk_port.configuredComName;

		rover.logs.server.log(rover, "connecting to pixhawk");
		if (port_path) {
			pixhawk_port.comName = port_path;
			pixhawk_port.opening = true;

			try {
				pixhawk_port.serial = new rover.SerialPort({
					path: port_path,
					baudRate: pixhawk_port.baudrate
				});
			}
			catch (e) {
				reset_connection_state();
				rover.logs.server.log(rover, "Pixhawk Port open failed - " + e);
				return;
			}

			//When port is open, start up mavlink
			pixhawk_port.serial.on('open', function () {

				//Create mavlink server to stream robot data...........................
				rover.logs.server.log(rover, "Pixhawk port opened: " + pixhawk_port.comName);

				pixhawk_port.mavlink = new MAVLink(null, pixhawk_port.targetSystem, pixhawk_port.targetComponent);
				clear_heartbeat_timeout();
				pixhawk_port.heartbeatTimeout = setTimeout(function () {
					if (pixhawk_port.connected === false && pixhawk_port.serial) {
						rover.logs.server.log(rover, "Pixhawk open but HEARTBEAT not received, retrying");
						if (pixhawk_port.serial.isOpen) {
							pixhawk_port.serial.close();
						}
						else {
							reset_connection_state();
						}
					}
				}, pixhawk_port.heartbeatTimeoutMs || 10000);

				pixhawk_port.serial.on('data', function (data) {

					//console.log(data);
					if (pixhawk_port.mavlink) {
						pixhawk_port.mavlink.parseBuffer(data);
					}
				});

				


				//On pixhawk usb/serial port message...........................
				pixhawk_port.mavlink.on("message", function (message) {

					if (message.name == 'HEARTBEAT') {

						if(!pixhawk_port.connected){
							rover.logs.server.log(rover, "Pixhawk HEARTBEAT received");
							pixhawk_port.connected = true;
							pixhawk_port.opening = false;
							clear_heartbeat_timeout();
							rover.request_data_stream(rover);
						}
						
					
					}

					rover.pixhawk_message_handler(rover, message);

				});

				pixhawk_port.mavlink.on("error", function (e) {
					rover.logs.server.log(rover, "rover.pixhawk_port.mavlink: ", e);
				});


			});

			//Pixhawk Serial port closed......................................
			pixhawk_port.serial.on('close', function (e) {

				rover.logs.server.log(rover, "Pixhawk Port closed");
				clearInterval(rover.update_signal_int);
				reset_connection_state();

			});

			//Pixhawk Serial port error......................................
			pixhawk_port.serial.on('error', function (e) {

				rover.logs.server.log(rover, "Pixhawk Port error - " + e);
				reset_connection_state();

			});

		}
		else {

			rover.logs.server.log(rover, "Missing pixhawk port");

		}
	}
};


module.exports = connect_to_robot_pixhawk;