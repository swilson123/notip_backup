var init_logs = function (white_rabbit) {

	const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
	const cutoff = Date.now() - THIRTY_DAYS_MS;

	if (white_rabbit.fs.existsSync('logger')) {
		white_rabbit.fs.readdirSync('logger').forEach(function (folder) {
			const folderDate = new Date(folder).getTime();
			if (!isNaN(folderDate) && folderDate < cutoff) {
				try {
					white_rabbit.fs.rmSync('logger/' + folder, { recursive: true, force: true });
					console.log('Deleted old log folder: logger/' + folder);
				} catch (err) {
					console.log('Failed to delete log folder logger/' + folder + ': ' + err.message);
				}
			}
		});
	}

	// white_rabbit.dateFormat may be the dateformat function; support both possible shapes
	try {
		white_rabbit.date = (typeof white_rabbit.dateFormat === 'function') ? white_rabbit.dateFormat(new Date(), 'yyyy-mm-dd') : (white_rabbit.dateFormat && white_rabbit.dateFormat.default ? white_rabbit.dateFormat.default(new Date(), 'yyyy-mm-dd') : require('dateformat')(new Date(), 'yyyy-mm-dd'));
	} catch (err) {
		// fallback
		white_rabbit.date = require('dateformat')(new Date(), 'yyyy-mm-dd');
	}

	if (white_rabbit.fs.existsSync('logger/' + white_rabbit.date)) {

		white_rabbit.fs.readdir('logger/' + white_rabbit.date, function (err, files) {
			files.forEach(function (file) {

				if (parseInt(file) >= white_rabbit.logs.count) {

					white_rabbit.logs.count = parseInt(file) + 1;
				}
			});

			white_rabbit.create_logs(white_rabbit);
		});

	}
	else {
		white_rabbit.create_logs(white_rabbit);
	}



};


module.exports = init_logs;