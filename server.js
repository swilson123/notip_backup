//From Terminal navigate to this folder and run: node server.js
//This code should be installed on truck and drone............

const { execSync, spawn } = require('child_process');

// ── Single instance ─────────────────────────────────────────────────────────
// Kill any OTHER `node server.js` already running (a previous launch that didn't
// exit) before we start, so two instances never run at once fighting over the
// camera / LiDAR / GPIO / serial ports. Also clear orphaned hardware children
// from a hung previous instance. Notes:
//   - The [n]ode bracket trick stops this helper's own shell from matching the
//     pattern (its command line contains "[n]ode...", never literal "node...").
//   - grep -vx <pid> excludes our own process.
//   - trailing `true` keeps execSync from throwing when nothing matched.
try {
	execSync(
		"pgrep -f '[n]ode.*[/ ]server\\.js' | grep -vx " + process.pid + " | xargs -r kill 2>/dev/null; " +
		"pkill -f ultra_simple 2>/dev/null; pkill -f sidewalk_vision.py 2>/dev/null; true",
		{ stdio: 'ignore' }
	);
} catch (e) { /* nothing else running, or pgrep/pkill unavailable */ }

process.on('uncaughtException', function (err) {
	console.error('Process Caught exception: ', err);
});

process.on('exit', function (code) {
	console.error('process exit', code);
});

const notip_init = require('./lib/notip.js');


//Fetch setup params......................
var fs = require('fs');
var data = fs.readFileSync('./setup.json');
var setup = null;

try {
	setup = JSON.parse(data);

	notip_init(setup);
} catch (err) {
	console.log('There has been an error parsing the setup JSON.');
	console.log(err);
}


// ── Graceful shutdown ────────────────────────────────────────────────────────
// Without this, Ctrl+C does NOT stop the process: the memory/learning modules
// register process.once('SIGINT') listeners that only flush and never exit —
// and registering ANY SIGINT listener overrides Node's default exit-on-SIGINT.
// Combined with the always-on timers, open serial ports, and spawned children
// (ultra_simple, sidewalk_vision.py, gpioset), the event loop stays alive
// forever. This handler kills the children and force-exits so one Ctrl+C stops it.
var shutting_down = false;
function shutdown(signal) {
	if (shutting_down) return;
	shutting_down = true;
	console.log('\nReceived ' + signal + ' — shutting down notip...');
	['ultra_simple', 'sidewalk_vision.py', 'gpioset'].forEach(function (pat) {
		try { spawn('pkill', ['-f', pat], { stdio: 'ignore' }); } catch (e) {}
	});
	// Let the once('exit')/flush handlers run, then hard-exit rather than waiting
	// on timers/ports/children that would otherwise hold the loop open forever.
	setTimeout(function () { process.exit(0); }, 300);
}
process.on('SIGINT',  function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
