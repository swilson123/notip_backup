//sends message to radio and websocket........................
var connect_to_robot_pixhawk = function (white_rabbit) {
	var pixhawk_port = white_rabbit.pixhawk_port;

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

		white_rabbit.logs.server.log(white_rabbit, "connecting to pixhawk");
		if (port_path) {
			pixhawk_port.comName = port_path;
			pixhawk_port.opening = true;

			try {
				pixhawk_port.serial = new white_rabbit.SerialPort({
					path: port_path,
					baudRate: pixhawk_port.baudrate
				});
			}
			catch (e) {
				reset_connection_state();
				white_rabbit.logs.server.log(white_rabbit, "Pixhawk Port open failed - " + e);

				if (!pixhawk_port.disconnect_ts) {
					pixhawk_port.disconnect_ts = Date.now();
				}
				var _count    = pixhawk_port._reconnect_count || 0;
				var _delay_ms = Math.min(5000 * Math.pow(2, _count), 30000);
				pixhawk_port._reconnect_count = _count + 1;
				setTimeout(function () { connect_to_robot_pixhawk(white_rabbit); }, _delay_ms);
				return;
			}

			//When port is open, start up mavlink
			pixhawk_port.serial.on('open', function () {

				//Create mavlink server to stream robot data...........................
				white_rabbit.logs.server.log(white_rabbit, "Pixhawk port opened: " + pixhawk_port.comName);

				pixhawk_port.mavlink = new MAVLink(null, pixhawk_port.targetSystem, pixhawk_port.targetComponent);
				clear_heartbeat_timeout();
				pixhawk_port.heartbeatTimeout = setTimeout(function () {
					if (pixhawk_port.connected === false && pixhawk_port.serial) {
						white_rabbit.logs.server.log(white_rabbit, "Pixhawk open but HEARTBEAT not received, retrying");
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
							white_rabbit.logs.server.log(white_rabbit, "Pixhawk HEARTBEAT received");
							pixhawk_port.connected = true;
							pixhawk_port.opening = false;
							clear_heartbeat_timeout();
							white_rabbit.request_data_stream(white_rabbit);

							// Sands of Time restore — announce if we were dark.
							if (pixhawk_port.disconnect_ts) {
								var dark_s = ((Date.now() - pixhawk_port.disconnect_ts) / 1000).toFixed(0);
								pixhawk_port.disconnect_ts    = null;
								pixhawk_port._reconnect_count = 0;
								white_rabbit.logs.server.log(white_rabbit, 'Pixhawk: reconnected after ' + dark_s + 's');
								if (white_rabbit.voice) white_rabbit.voice.say('Pixhawk restored.');
							}
						}
						
					
					}

					white_rabbit.pixhawk_message_handler(white_rabbit, message);

				});

				pixhawk_port.mavlink.on("error", function (e) {
					white_rabbit.logs.server.log(white_rabbit, "white_rabbit.pixhawk_port.mavlink: ", e);
				});


			});

			//Pixhawk Serial port closed......................................
			pixhawk_port.serial.on('close', function (e) {

				white_rabbit.logs.server.log(white_rabbit, "Pixhawk Port closed");
				clearInterval(white_rabbit.update_signal_int);

				var was_connected = pixhawk_port.connected;
				reset_connection_state();

				// Last known GPS, attitude, and battery remain on white_rabbit.robot_data
				// (the stars still shine). Stamp once, voice once, then backoff reconnect.
				if (was_connected && !pixhawk_port.disconnect_ts) {
					pixhawk_port.disconnect_ts = Date.now();
					white_rabbit.logs.server.log(white_rabbit, 'Pixhawk: disconnected — holding last position and attitude');
					if (white_rabbit.voice) white_rabbit.voice.say('Pixhawk signal lost. Holding last position.');
				}
				var count    = pixhawk_port._reconnect_count || 0;
				var delay_ms = Math.min(5000 * Math.pow(2, count), 30000);
				pixhawk_port._reconnect_count = count + 1;
				setTimeout(function () { connect_to_robot_pixhawk(white_rabbit); }, delay_ms);

			});

			//Pixhawk Serial port error......................................
			pixhawk_port.serial.on('error', function (e) {

				white_rabbit.logs.server.log(white_rabbit, "Pixhawk Port error - " + e);

				var was_connected = pixhawk_port.connected;
				reset_connection_state();

				if (was_connected && !pixhawk_port.disconnect_ts) {
					pixhawk_port.disconnect_ts = Date.now();
					if (white_rabbit.voice) white_rabbit.voice.say('Pixhawk signal lost. Holding last position.');
				}
				var count    = pixhawk_port._reconnect_count || 0;
				var delay_ms = Math.min(5000 * Math.pow(2, count), 30000);
				pixhawk_port._reconnect_count = count + 1;
				setTimeout(function () { connect_to_robot_pixhawk(white_rabbit); }, delay_ms);

			});

		}
		else {

			white_rabbit.logs.server.log(white_rabbit, "Missing pixhawk port");

		}
	}
};


module.exports = connect_to_robot_pixhawk;