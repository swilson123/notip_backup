var init_logs = function (rover) {

	const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
	const cutoff = Date.now() - THIRTY_DAYS_MS;

	if (rover.fs.existsSync('logger')) {
		rover.fs.readdirSync('logger').forEach(function (folder) {
			const folderDate = new Date(folder).getTime();
			if (!isNaN(folderDate) && folderDate < cutoff) {
				try {
					rover.fs.rmSync('logger/' + folder, { recursive: true, force: true });
					console.log('Deleted old log folder: logger/' + folder);
				} catch (err) {
					console.log('Failed to delete log folder logger/' + folder + ': ' + err.message);
				}
			}
		});
	}

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