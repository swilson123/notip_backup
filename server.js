//From Terminal navigate to this folder and run: node server.js
//This code should be installed on truck and drone............

process.on('uncaughtException', function (err) {
	console.error('Process Caught exception: ', err);
});

process.on('error', function (err) {
	console.error('process error', err);
});

process.on('exit', function (code) {
	console.error('process exit', code);
});

const notip_init = require('./lib/notip.js');


//Fetch setup params......................
var fs = require('fs');
var data = fs.readFileSync('./setup.json');
var setup = null;
var white_rabbit = null;

try {
	setup = JSON.parse(data);

	white_rabbit = notip_init(setup);
} catch (err) {
	console.log('There has been an error parsing the setup JSON.');
	console.log(err);
}


// Graceful shutdown. Without this, Ctrl+C does not terminate: the learning/memory
// modules register SIGINT listeners (which overrides Node's default exit-on-SIGINT),
// and the many setInterval timers, open serial ports, and spawned child processes
// (ultra_simple, realsense_vision.py, gpioset, espeak, asr) keep the event loop
// alive. The process lingers, so the next `node server.js` stacks a second instance
// on top — both then fight over the camera/GPIO/serial ports. This handler kills the
// child we can reach and force-exits, letting flush-on-exit handlers run first.
var shutting_down = false;
function shutdown(signal) {
	if (shutting_down) return;
	shutting_down = true;
	console.log('\nReceived ' + signal + ' — shutting down notip...');

	try {
		if (white_rabbit && white_rabbit.realsense && white_rabbit.realsense.process) {
			white_rabbit.realsense.process.kill('SIGTERM');
		}
	} catch (e) {
		console.error('shutdown: realsense kill failed', e && e.message);
	}

	// Let the once('exit')/flush handlers run, then hard-exit rather than waiting
	// on timers/ports/children that would otherwise hold the loop open forever.
	setTimeout(function () { process.exit(0); }, 250);
}

process.on('SIGINT',  function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
