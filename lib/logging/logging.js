var logging = function (rover, page) {

	var path = require('path');
	var fs = require('fs');

	this.page = page;

	// rover.dateFormat may be the dateformat function or an imported module object.
	var dateFormat;
	if (rover && rover.dateFormat) {
		if (typeof rover.dateFormat === 'function') {
			dateFormat = rover.dateFormat;
		} else if (rover.dateFormat.default && typeof rover.dateFormat.default === 'function') {
			dateFormat = rover.dateFormat.default;
		} else {
			dateFormat = require('dateformat');
		}
	} else {
		dateFormat = require('dateformat');
	}

	var date = dateFormat(new Date(), 'yyyy-mm-dd');
	var logsCount = (rover && rover.logs && rover.logs.count) ? rover.logs.count : 1;
	var dir = path.join('logger', date, String(logsCount));

	// ensure directory exists before creating transports
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch (err) {
		console.error('logging: failed to create log directory', dir, err);
	}

	var filename = path.join(dir, page + '-%DATE%.log');

	// Try to use winston with daily rotate transport; if unavailable fall back to console-only logger
	try {
		var winston = require('winston');
		require('winston-daily-rotate-file');

		var transport = new (winston.transports.DailyRotateFile)({
			filename: filename,
			datePattern: 'YYYY-MM-DD-HH',
			zippedArchive: false,
			maxSize: '20m',
			maxFiles: '30d'
		});

		this.logger = winston.createLogger({
			transports: [transport]
		});
	} catch (err) {
	// 	console.warn('logging: winston or rotate transport not available, using console fallback', err && err.message);
	// 	// simple logger that matches .info/.warn/.error/.debug
	// 	this.logger = {
	// 		info: function () { console.log.apply(console, arguments); },
	// 		warn: function () { console.warn.apply(console, arguments); },
	// 		error: function () { console.error.apply(console, arguments); },
	// 		debug: function () { console.debug ? console.debug.apply(console, arguments) : console.log.apply(console, arguments); }
	// 	};
	 }

};

logging.prototype.log = function (rover, message) {
	var dateFormat;
	if (rover && rover.dateFormat) {
		if (typeof rover.dateFormat === 'function') dateFormat = rover.dateFormat;
		else if (rover.dateFormat.default && typeof rover.dateFormat.default === 'function') dateFormat = rover.dateFormat.default;
		else dateFormat = require('dateformat');
	} else dateFormat = require('dateformat');

	var timestamp = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss');

	//this.logger.info(timestamp + ' ' + this.page + ': ' + message);
};

module.exports = logging;