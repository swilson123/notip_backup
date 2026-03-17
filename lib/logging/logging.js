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

	var pagePath = path.join(dir, page);
	var pageDir = path.dirname(pagePath);
	try {
		fs.mkdirSync(pageDir, { recursive: true });
	} catch (err) {
		console.error('logging: failed to create page log directory', pageDir, err);
	}

	var filename = path.join(dir, page + '-%DATE%.log');
	this.fs = fs;
	this.path = path;
	this.baseDir = dir;
	this.pageDir = pageDir;
	this.pagePath = page;

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
		console.warn('logging: winston or rotate transport not available, using console fallback', err && err.message);
		// no-op logger: file append path below is the source of truth for log persistence
		this.logger = {
			info: function () { },
			warn: function () { },
			error: function () { },
			debug: function () { }
		};
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
	var fileDate = dateFormat(new Date(), 'yyyy-mm-dd-HH');
	var msg;
	if (typeof message === 'string') {
		msg = message;
	} else {
		try {
			msg = JSON.stringify(message);
		} catch (e) {
			msg = String(message);
		}
	}
	var line = timestamp + ' ' + this.page + ': ' + msg + '\n';

	if (this.logger && typeof this.logger.info === 'function') {
		this.logger.info(line.trim());
	}

	// Guaranteed write path (independent of winston transport state)
	if (this.fs && this.baseDir) {
		var plainFile = this.path.join(this.baseDir, this.pagePath + '-' + fileDate + '.log');
		this.fs.appendFile(plainFile, line, function (err) {
			if (err) {
				console.error('logging: appendFile failed', plainFile, err.message || err);
			}
		});
	}
};

module.exports = logging;