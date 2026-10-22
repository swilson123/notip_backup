//NTRIP client for the Ohio Real Time Network (Trimble NtripCaster) - same request as notip_car's NTRIP client.
//Noah's own internet is the first choice for RTK: corrections go straight into the Pixhawk, no radio hop.
var create_ntrip_client = function (white_rabbit) {
	if (!white_rabbit.ntrip.address || !white_rabbit.ntrip.mountpoint) {
		return;
	}
	if (!white_rabbit.ntrip.username || !white_rabbit.ntrip.password) {
		return;
	}
	if (white_rabbit.ntrip.client || !white_rabbit.ntrip.GGA) {
		return;
	}

	white_rabbit.ntrip.connected = false;
	white_rabbit.ntrip.last_data_time = Date.now();
	white_rabbit.ntrip.splitter = white_rabbit.rtcm_frame_splitter();
	white_rabbit.ntrip.client = new white_rabbit.net.Socket();

	white_rabbit.ntrip.client.connect(white_rabbit.ntrip.port_number, white_rabbit.ntrip.address, function () {
		white_rabbit.logs.ntrip.log(white_rabbit, 'NTRIP Client Connected - Mountpoint: ' + white_rabbit.ntrip.mountpoint);
		var base64_user_pass = Buffer.from(white_rabbit.ntrip.username + ':' + white_rabbit.ntrip.password).toString('base64');
		var useragent = 'NTRIP White Rabbit Client';

		white_rabbit.ntrip.client.write('GET /' + white_rabbit.ntrip.mountpoint + ' HTTP/1.1' + '\r\nUser-Agent: ' + useragent + '\r\nAuthorization: Basic ' + base64_user_pass + '\r\n\r\n');
	});

	white_rabbit.ntrip.client.on('data', function (data) {
		white_rabbit.ntrip.last_data_time = Date.now();

		if (!white_rabbit.ntrip.connected) {
			var response = data.toString('latin1');

			if (response.indexOf('SOURCETABLE') >= 0 || response.indexOf('404 Not Found') >= 0) {
				white_rabbit.logs.ntrip.log(white_rabbit, 'NTRIP mount point does not exist: ' + white_rabbit.ntrip.mountpoint);
				return;
			}
			if (response.indexOf('401 Unauthorized') >= 0) {
				white_rabbit.logs.ntrip.log(white_rabbit, 'NTRIP unauthorized - check ntrip_credentials.json');
				return;
			}
			if (response.indexOf('ICY 200 OK') >= 0 || response.indexOf('HTTP/1.0 200 OK') >= 0 || response.indexOf('HTTP/1.1 200 OK') >= 0) {
				white_rabbit.logs.ntrip.log(white_rabbit, 'NTRIP stream accepted');
				white_rabbit.ntrip.connected = true;
				white_rabbit.ntrip.connected_time = Date.now();
				white_rabbit.ntrip.rtk_reached = false;
				white_rabbit.ntrip.client.write(white_rabbit.ntrip.GGA);
				white_rabbit.ntrip.last_location_update = Date.now();

				//Corrections can arrive in the same packet as the response header
				var header_end = response.indexOf('\r\n\r\n');
				data = header_end >= 0 ? data.slice(header_end + 4) : Buffer.alloc(0);
			}
			else {
				return;
			}
		}

		if (data.length === 0) {
			return;
		}

		white_rabbit.ntrip.last_rtcm_time = Date.now();
		white_rabbit.ntrip.bytes += data.length;

		white_rabbit.ntrip.splitter.push(data).forEach(function (frame) {
			white_rabbit.send_rtcm_to_pixhawk(white_rabbit, frame);
		});
	});

	white_rabbit.ntrip.client.on('close', function () {
		white_rabbit.logs.ntrip.log(white_rabbit, 'NTRIP Client closed');
		white_rabbit.ntrip.client = null;
		white_rabbit.ntrip.connected = false;
		white_rabbit.ntrip.healthy = false;
		white_rabbit.ntrip.last_close_time = Date.now();
	});

	white_rabbit.ntrip.client.on('error', function (e) {
		//No internet = the same error every reconnect, only log when it changes
		if (white_rabbit.ntrip.last_error !== e.message) {
			white_rabbit.ntrip.last_error = e.message;
			white_rabbit.logs.ntrip.log(white_rabbit, 'NTRIP Client error: ' + e.message);
		}
	});
};


module.exports = create_ntrip_client;
