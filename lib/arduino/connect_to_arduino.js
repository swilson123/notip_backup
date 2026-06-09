var connect_to_arduino = function (white_rabbit) {
	if (white_rabbit.arduino.port_path) {

		white_rabbit.arduino.serial = new white_rabbit.SerialPort({path: white_rabbit.arduino.port_path, baudRate: white_rabbit.arduino.baudrate});

		//When port is open
		white_rabbit.arduino.serial.on('open', function () {

			console.log('Connected to arduino on port: ' + white_rabbit.arduino.port_path);
			white_rabbit.logs.arduino_message_handler.log(white_rabbit, 'Connected to arduino on port: ' + white_rabbit.arduino.port_path);
			white_rabbit.arduino.connected = true;

			if (white_rabbit.arduino.disconnect_ts) {
				var dark_s = ((Date.now() - white_rabbit.arduino.disconnect_ts) / 1000).toFixed(0);
				white_rabbit.arduino.disconnect_ts    = null;
				white_rabbit.arduino._reconnect_count = 0;
				console.log('Arduino: reconnected after ' + dark_s + 's');
				white_rabbit.logs.arduino_message_handler.log(white_rabbit, 'Arduino: reconnected after ' + dark_s + 's');
				if (white_rabbit.voice) white_rabbit.voice.say('Arduino restored.');
			}

			// Brace-depth accumulator — collects raw bytes until a complete
			// JSON object {...} is assembled, then fires the message handler.
			// Protects against messages fragmented across serial TX buffer flushes.
			let _json_buf  = '';
			let _brace_depth = 0;

			white_rabbit.arduino.serial.on('data', function (chunk) {
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
							white_rabbit.arduino_message_handler(white_rabbit, _json_buf);
							_json_buf = '';
						}
					}
				}
			});

		});

		white_rabbit.arduino.serial.on('close', function (e) {
			console.log('white_rabbit.arduino.serial close: ', e);
			white_rabbit.arduino.connected = false;

			// Last known delivery and arm state remain on white_rabbit.arduino.received_data.
			// The 30s delivery timeout safety net is still running if mid-delivery.
			if (!white_rabbit.arduino.disconnect_ts) {
				white_rabbit.arduino.disconnect_ts = Date.now();
				white_rabbit.logs.arduino_message_handler.log(white_rabbit, 'Arduino disconnected — delivery mechanism offline');
				if (white_rabbit.voice) white_rabbit.voice.say('Arduino signal lost. Awaiting reconnect.');
			}
			var count    = white_rabbit.arduino._reconnect_count || 0;
			var delay_ms = Math.min(5000 * Math.pow(2, count), 30000);
			white_rabbit.arduino._reconnect_count = count + 1;
			setTimeout(function () { connect_to_arduino(white_rabbit); }, delay_ms);
		});

		white_rabbit.arduino.serial.on('error', function (e) {
			console.log('white_rabbit.arduino.serial error: ', e);
			white_rabbit.logs.arduino_message_handler.log(white_rabbit, 'Arduino serial error: ' + e.message);
		});


	}
	else{
		console.log('No arduino port defined');
	}
};

module.exports = connect_to_arduino;
