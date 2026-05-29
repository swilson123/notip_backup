var update_serialports = function (white_rabbit, show_ports) {

	// lazy-require serialport to avoid throwing at module load if native bindings missing
	if (!white_rabbit.SerialPort) {
		try {
			const sp = require('serialport');
			// serialport v9+ exports SerialPort and a static list() method that returns a Promise
			white_rabbit.SerialPort = sp.SerialPort || sp;
		} catch (err) {
			console.error('update_serialports: failed to require serialport', err);
			return;
		}
	}

	try {
		(async () => {
			const ports = await white_rabbit.SerialPort.list();
			ports.forEach(function (port) {
				if (show_ports) {
					//console.log(port.path);
				}
				
			});
		})();
	} catch (err) {
		console.error('update_serialports: error listing ports', err);
	}

};


module.exports = update_serialports;