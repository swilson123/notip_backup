//sends message to radio and websocket........................
var connect_to_robot_pixhawk = function (rover) {
	if (rover.pixhawk_port.connected === false) {

		rover.logs.server.log(rover, "connecting to pixhawk");
		if (rover.pixhawk_port.comName) {
			rover.pixhawk_port.serial = new rover.SerialPort({
				path: rover.pixhawk_port.comName,
				baudRate: rover.pixhawk_port.baudrate
			});

			//When port is open, start up mavlink
			rover.pixhawk_port.serial.on('open', function () {

				//Create mavlink server to stream robot data...........................

				rover.pixhawk_port.mavlink = new MAVLink(null, rover.pixhawk_port.targetSystem, rover.pixhawk_port.targetComponent);
				rover.pixhawk_port.connected = true;

				rover.request_data_stream(rover);

				rover.pixhawk_port.serial.on('data', function (data) {

					//console.log(data);
					rover.pixhawk_port.mavlink.parseBuffer(data);
				});

				//rover.pixhawk_heartbeat(rover);



				//On pixhawk usb/serial port message...........................
				rover.pixhawk_port.mavlink.on("message", function (message) {

					if (message.name == 'HEARTBEAT') {
						//rover.pixhawk_heartbeat(rover);
					}

					rover.pixhawk_message_handler(rover, message);

				});

				rover.pixhawk_port.mavlink.on("error", function (e) {
					rover.logs.server.log(rover, "rover.pixhawk_port.mavlink: ", e);
				});


			});

			//Pixhawk Serial port closed......................................
			rover.pixhawk_port.serial.on('close', function (e) {

				rover.logs.server.log(rover, "Pixhawk Port closed");
				clearInterval(rover.update_signal_int);
				rover.pixhawk_port.serial = null;
				rover.pixhawk_port.connected = false;
				rover.pixhawk_port.comName = null;

			});

			//Pixhawk Serial port error......................................
			rover.pixhawk_port.serial.on('error', function (e) {

				rover.logs.server.log(rover, "Pixhawk Port error - " + e);
				rover.pixhawk_port.serial = null;
				rover.pixhawk_port.connected = false;
				rover.pixhawk_port.comName = null;

			});

		}
		else {

			rover.logs.server.log(rover, "Missing pixhawk port");

		}
	}
};


module.exports = connect_to_robot_pixhawk;