var spawn = require('child_process').spawn;
var spawnSync = require('child_process').spawnSync;
var path = require('path');

function reset_realsense_connection(white_rabbit) {
	white_rabbit.realsense.connected = false;
	white_rabbit.realsense.connecting = false;
	white_rabbit.realsense.transport = null;
	white_rabbit.realsense.process = null;
	white_rabbit.realsense.serial = null;
	white_rabbit.realsense.parser = null;
	white_rabbit.realsense.stdout_buffer = '';
	white_rabbit.realsense.stderr_buffer = '';
	if (white_rabbit.realsense.pitch_send_interval) {
		clearInterval(white_rabbit.realsense.pitch_send_interval);
		white_rabbit.realsense.pitch_send_interval = null;
	}
}

// Stream the current white_rabbit pitch, roll (radians), and compass heading (degrees) to
// the Python vision subprocess. Pitch/roll rotate the depth back-projection into a
// white_rabbit-horizontal frame so potholes/bumps/off-camber surfaces don't corrupt object
// heights, lateral positions, or centerline forward distances. Heading feeds
// _predict_and_score in realsense_vision.py: a real, physical edge is a fixed point in the
// world, so rotating last tick's accepted edge point by how much heading changed since
// predicts exactly where it must reappear now -- a shadow or color artifact won't obey
// that rotation, and confidence is marked down accordingly.
function start_pitch_stream(white_rabbit) {
	if (white_rabbit.realsense.pitch_send_interval) clearInterval(white_rabbit.realsense.pitch_send_interval);
	white_rabbit.realsense.pitch_send_interval = setInterval(function () {
		if (!white_rabbit.realsense.process || !white_rabbit.realsense.process.stdin || white_rabbit.realsense.process.stdin.destroyed) return;
		let pitch_rad = 0, roll_rad = 0, heading_deg = null;
		try { pitch_rad = white_rabbit.get_pitch(white_rabbit) || 0; } catch (e) { pitch_rad = 0; }
		try { roll_rad  = white_rabbit.get_roll(white_rabbit)  || 0; } catch (e) { roll_rad  = 0; }
		try { heading_deg = white_rabbit.get_heading(white_rabbit); } catch (e) { heading_deg = null; }
		try {
			white_rabbit.realsense.process.stdin.write(JSON.stringify({ message: 'pitch', value: pitch_rad }) + '\n');
			white_rabbit.realsense.process.stdin.write(JSON.stringify({ message: 'roll',  value: roll_rad  }) + '\n');
			if (typeof heading_deg === 'number' && !isNaN(heading_deg)) {
				white_rabbit.realsense.process.stdin.write(JSON.stringify({ message: 'heading', value: heading_deg }) + '\n');
			}
		} catch (e) {
			// Stream may have closed mid-write; the close handler will clean up
		}
	}, 100); // 10 Hz
}

function handle_realsense_stdout(white_rabbit, data) {
	white_rabbit.realsense.stdout_buffer += data;
	let lines = white_rabbit.realsense.stdout_buffer.split('\n');
	white_rabbit.realsense.stdout_buffer = lines.pop();

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i].trim();
		if (!line) {
			continue;
		}

		white_rabbit.realsense.connecting = false;
		white_rabbit.realsense_message_handler(white_rabbit, line);
	}
}

function start_realsense_vision(white_rabbit) {
	if (white_rabbit.realsense.process || white_rabbit.realsense.connecting) {
		return;
	}

	// Kill any orphaned realsense_vision.py processes from a previous crash or restart
	// so they don't hold the camera and cause "No device connected"
	spawnSync('pkill', ['-f', 'realsense_vision.py'], { stdio: 'ignore' });

	let vision = white_rabbit.realsense.vision || {};
	// The Python subprocess reads its config SOLELY from this JSON arg (not setup.json),
	// so forward the entire raw realsense_vision section — every setup.json key reaches the
	// detector and stays in sync. (Previously a hand-maintained subset silently dropped
	// edge_hough_detector, edge_roi_*, edge_line_*, edge_mask_threshold, camera_mount_pitch_deg,
	// etc., so tuning them did nothing.) Falls back to the curated object if raw is absent.
	let vision_raw = white_rabbit.realsense.vision_full || vision;
	let script_path = path.isAbsolute(vision.script_path)
		? vision.script_path
		: path.resolve(process.cwd(), vision.script_path);
	let resolve_model_path = function (p) {
		return p ? (path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)) : '';
	};
	let vision_config = Object.assign({}, vision_raw, {
		// Resolve relative model paths to absolute — the Python cwd can differ.
		segmentation_model_path: resolve_model_path(vision_raw.segmentation_model_path),
		sam_encoder_path: resolve_model_path(vision_raw.sam_encoder_path),
		sam_decoder_path: resolve_model_path(vision_raw.sam_decoder_path)
	});

	white_rabbit.realsense.connecting = true;
	white_rabbit.realsense.connected = false;
	white_rabbit.realsense.transport = 'vision';
	white_rabbit.realsense.last_status = 'starting';

	white_rabbit.realsense.process = spawn('nice', ['-n', '10', vision.python_path, script_path, JSON.stringify(vision_config)], {
		cwd: process.cwd(),
		stdio: ['pipe', 'pipe', 'pipe']
	});

	white_rabbit.logs.realsense_message_handler.log(white_rabbit, 'Starting realsense vision process: ' + script_path);
	white_rabbit.realsense.process.stdout.setEncoding('utf8');
	white_rabbit.realsense.process.stderr.setEncoding('utf8');

	start_pitch_stream(white_rabbit);

	white_rabbit.realsense.process.stdout.on('data', function (data) {
		handle_realsense_stdout(white_rabbit, data);
	});

	white_rabbit.realsense.process.stderr.on('data', function (data) {
		let message = data.toString().trim();
		if (!message) {
			return;
		}

		console.log('realsense vision stderr:', message);
		white_rabbit.logs.realsense_message_handler.log(white_rabbit, 'Vision stderr: ' + message);
	});

	white_rabbit.realsense.process.on('error', function (e) {
		console.log('white_rabbit.realsense.process error: ', e);
		white_rabbit.logs.realsense_message_handler.log(white_rabbit, 'Vision process error: ' + e.toString());
		reset_realsense_connection(white_rabbit);
	});

	white_rabbit.realsense.process.on('close', function (code) {
		console.log('realsense vision exited with code: ' + code);
		white_rabbit.logs.realsense_message_handler.log(white_rabbit, 'Vision process exited with code: ' + code);
		reset_realsense_connection(white_rabbit);
		setTimeout(function () {
			start_realsense_vision(white_rabbit);
		}, 5000);
	});
}

function connect_legacy_realsense(white_rabbit) {
	if (!white_rabbit.realsense.port_path) {
		console.log('No realsense port defined');
		return;
	}

	white_rabbit.realsense.serial = new white_rabbit.SerialPort({path: white_rabbit.realsense.port_path, baudRate: white_rabbit.realsense.baudrate});

	white_rabbit.realsense.serial.on('open', function () {
		console.log('Connected to realsense on port: ' + white_rabbit.realsense.port_path);
		white_rabbit.logs.realsense_message_handler.log(white_rabbit, 'Connected to realsense on port: ' + white_rabbit.realsense.port_path);
		white_rabbit.realsense.connected = true;
		white_rabbit.realsense.transport = 'serial';

		white_rabbit.realsense.serial.on('data', function () {
		});

		white_rabbit.realsense.parser = white_rabbit.realsense.serial.pipe(new white_rabbit.Readline(
			{
				delimiter: '\n'
			}));

		white_rabbit.realsense.parser.on('data', function (input) {
			white_rabbit.realsense_message_handler(white_rabbit, input);
		});

		white_rabbit.realsense.parser.on('error', function (e) {
			console.log('white_rabbit.realsense.parser: ', e);
		});
	});

	white_rabbit.realsense.serial.on('close', function (e) {
		console.log('white_rabbit.realsense.serial close: ', e);
		reset_realsense_connection(white_rabbit);
	});

	white_rabbit.realsense.serial.on('error', function (e) {
		console.log('white_rabbit.realsense.serial error: ', e);
		reset_realsense_connection(white_rabbit);
	});
}

var connect_to_realsense = function (white_rabbit) {
	if (white_rabbit.realsense.vision && white_rabbit.realsense.vision.enabled) {
		start_realsense_vision(white_rabbit);
		return;
	}

	connect_legacy_realsense(white_rabbit);
};

module.exports = connect_to_realsense;
