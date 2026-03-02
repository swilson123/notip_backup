//sends message to radio and websocket........................
var init_logs = function (rover) {


	// rover.dateFormat may be the dateformat function; support both possible shapes
	try {
		rover.date = (typeof rover.dateFormat === 'function') ? rover.dateFormat(new Date(), 'yyyy-mm-dd') : (rover.dateFormat && rover.dateFormat.default ? rover.dateFormat.default(new Date(), 'yyyy-mm-dd') : require('dateformat')(new Date(), 'yyyy-mm-dd'));
	} catch (err) {
		// fallback
		rover.date = require('dateformat')(new Date(), 'yyyy-mm-dd');
	}

	if (rover.fs.existsSync('logger/' + rover.date)) {

		rover.fs.readdir('logger/' + rover.date, function (err, files) {
			files.forEach(function (file) {

				if (parseInt(file) >= rover.logs.count) {

					rover.logs.count = parseInt(file) + 1;
				}
			});

			rover.create_logs(rover);
		});

	}
	else {
		rover.create_logs(rover);
	}



};


module.exports = init_logs;