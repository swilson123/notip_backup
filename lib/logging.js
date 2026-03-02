"use strict";

var util = require('util'),
    fs = require('fs'),
    path = require('path');

var production = (process.env.NODE_ENV || '').toLowerCase() === 'production';

module.exports = {
    middleware: function (req, res, next) {
        console.info(req.method, req.url, res.statusCode);
        next();
    },
    production: production
};

// Defensive logging setup: try to load winston and daily rotate transports.
// If those modules aren't available in the runtime (e.g., during partial installs),
// fall back to a console-based no-frills logger so requiring this module doesn't throw.
try {
    require('winston-daily-rotate-file');
    var winston = require('winston');
    // create a logger instance compatible with older and newer winston versions
    var logger = winston.createLogger ? winston.createLogger() : new winston.Logger();

    var os = require('os');
    var hostname = os.hostname();
    var logpath = './logger/log';

    // write to a daily rotating file log
    if (logger.add && winston.transports && winston.transports.DailyRotateFile) {
        logger.add(new winston.transports.DailyRotateFile({
            filename: logpath,
            datePattern: 'yyyy-MM-dd.',
            prepend: true,
            timestamp: true,
            localTime: true,
            json: false,
            level: 'info',
            handleExceptions: true,
            exitOnError: false
        }));
    }

    // output log entries to console
    if (logger.add && winston.transports && winston.transports.Console) {
        logger.add(new winston.transports.Console({
            colorize: true,
            timestamp: true,
            level: 'info'
        }));
    }

    function formatArgs(args) {
        return [util.format.apply(util.format, Array.prototype.slice.call(args))];
    }

    console.log = function () {
        logger.info.apply(logger, formatArgs(arguments));
    };
    console.info = function () {
        logger.info.apply(logger, formatArgs(arguments));
    };
    console.warn = function () {
        logger.warn.apply(logger, formatArgs(arguments));
    };
    console.error = function () {
        logger.error.apply(logger, formatArgs(arguments));
    };
    console.debug = function () {
        logger.debug.apply(logger, formatArgs(arguments));
    };
} catch (err) {
    // fallback: leave console as-is but provide small shims for consistency
    console.warn('winston/daily-rotate-file not available, falling back to console logging');
    // ensure console.debug exists
    if (!console.debug) console.debug = console.log;
}