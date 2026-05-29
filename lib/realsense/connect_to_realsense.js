var spawn = require('child_process').spawn;
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

// Stream the current white_rabbit pitch and roll (radians) to the Python vision subprocess
// so it can rotate the depth back-projection into a white_rabbit-horizontal frame. Without
// this, pitching/rolling over potholes, bumps, or off-camber surfaces corrupts object
// heights, lateral positions, and centerline forward distances.
function start_pitch_stream(white_rabbit) {
	if (white_rabbit.realsense.pitch_send_interval) clearInterval(white_rabbit.realsense.pitch_send_interval);
	white_rabbit.realsense.pitch_send_interval = setInterval(function () {
		if (!white_rabbit.realsense.process || !white_rabbit.realsense.process.stdin || white_rabbit.realsense.process.stdin.destroyed) return;
		let pitch_rad = 0, roll_rad = 0;
		try { pitch_rad = white_rabbit.get_pitch(white_rabbit) || 0; } catch (e) { pitch_rad = 0; }
		try { roll_rad  = white_rabbit.get_roll(white_rabbit)  || 0; } catch (e) { roll_rad  = 0; }
		try {
			white_rabbit.realsense.process.stdin.write(JSON.stringify({ message: 'pitch', value: pitch_rad }) + '\n');
			white_rabbit.realsense.process.stdin.write(JSON.stringify({ message: 'roll',  value: roll_rad  }) + '\n');
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

	let vision = white_rabbit.realsense.vision || {};
	let script_path = path.isAbsolute(vision.script_path)
		? vision.script_path
		: path.resolve(process.cwd(), vision.script_path);
	let vision_config = {
		width: vision.width,
		height: vision.height,
		fps_normal: vision.fps_normal,
		fps_high_cpu: vision.fps_high_cpu,
		fps_critical_cpu: vision.fps_critical_cpu,
		cpu_high_threshold: vision.cpu_high_threshold,
		cpu_critical_threshold: vision.cpu_critical_threshold,
		camera_height_m: typeof vision.camera_height_m === 'number' ? vision.camera_height_m : 0.406,
		white_rabbit_width_m: typeof vision.white_rabbit_width_m === 'number' ? vision.white_rabbit_width_m : 0.432,
		white_rabbit_length_m: typeof vision.white_rabbit_length_m === 'number' ? vision.white_rabbit_length_m : 0.686,
		object_detection_enabled: vision.object_detection_enabled !== false,
		object_max_distance_m: typeof vision.object_max_distance_m === 'number' ? vision.object_max_distance_m : 2.0,
		object_min_height_m: typeof vision.object_min_height_m === 'number' ? vision.object_min_height_m : 0.127, // 5 inches
		object_min_area_px: typeof vision.object_min_area_px === 'number' ? vision.object_min_area_px : 200,
		segmentation_model_path: vision.segmentation_model_path
			? (path.isAbsolute(vision.segmentation_model_path)
				? vision.segmentation_model_path
				: path.resolve(process.cwd(), vision.segmentation_model_path))
			: '',
		segmentation_input_width: typeof vision.segmentation_input_width === 'number' ? vision.segmentation_input_width : 512,
		segmentation_input_height: typeof vision.segmentation_input_height === 'number' ? vision.segmentation_input_height : 256,
		// Appearance-based / SAM ground segmentation (see lib/realsense/mobilesam/)
		appearance_mode: vision.appearance_mode || 'blend',
		appearance_seed_y_frac: typeof vision.appearance_seed_y_frac === 'number' ? vision.appearance_seed_y_frac : 0.92,
		appearance_seed_ttl_ms: typeof vision.appearance_seed_ttl_ms === 'number' ? vision.appearance_seed_ttl_ms : 2000,
		sam_enabled: vision.sam_enabled !== false,
		sam_encoder_path: vision.sam_encoder_path
			? (path.isAbsolute(vision.sam_encoder_path)
				? vision.sam_encoder_path
				: path.resolve(process.cwd(), vision.sam_encoder_path))
			: '',
		sam_decoder_path: vision.sam_decoder_path
			? (path.isAbsolute(vision.sam_decoder_path)
				? vision.sam_decoder_path
				: path.resolve(process.cwd(), vision.sam_decoder_path))
			: '',
		sam_onnx_min_area_frac: typeof vision.sam_onnx_min_area_frac === 'number' ? vision.sam_onnx_min_area_frac : 0.02,
		edge_max_lookahead_m: typeof vision.edge_max_lookahead_m === 'number' ? vision.edge_max_lookahead_m : 2.5,
		dropoff_min_depth_jump_m: typeof vision.dropoff_min_depth_jump_m === 'number' ? vision.dropoff_min_depth_jump_m : 0.15,
		perspective_check_max_distance_m: typeof vision.perspective_check_max_distance_m === 'number' ? vision.perspective_check_max_distance_m : 2.0,
		perspective_min_narrowing_ratio: typeof vision.perspective_min_narrowing_ratio === 'number' ? vision.perspective_min_narrowing_ratio : 1.05
	};

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
