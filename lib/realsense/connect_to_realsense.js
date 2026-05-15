var spawn = require('child_process').spawn;
var path = require('path');

function reset_realsense_connection(rover) {
	rover.realsense.connected = false;
	rover.realsense.connecting = false;
	rover.realsense.transport = null;
	rover.realsense.process = null;
	rover.realsense.serial = null;
	rover.realsense.parser = null;
	rover.realsense.stdout_buffer = '';
	rover.realsense.stderr_buffer = '';
}

function handle_realsense_stdout(rover, data) {
	rover.realsense.stdout_buffer += data;
	let lines = rover.realsense.stdout_buffer.split('\n');
	rover.realsense.stdout_buffer = lines.pop();

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i].trim();
		if (!line) {
			continue;
		}

		rover.realsense.connecting = false;
		rover.realsense_message_handler(rover, line);
	}
}

function start_realsense_vision(rover) {
	if (rover.realsense.process || rover.realsense.connecting) {
		return;
	}

	let vision = rover.realsense.vision || {};
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
		rover_width_m: typeof vision.rover_width_m === 'number' ? vision.rover_width_m : 0.432,
		rover_length_m: typeof vision.rover_length_m === 'number' ? vision.rover_length_m : 0.686,
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
		segmentation_input_height: typeof vision.segmentation_input_height === 'number' ? vision.segmentation_input_height : 256
	};

	rover.realsense.connecting = true;
	rover.realsense.connected = true;
	rover.realsense.transport = 'vision';
	rover.realsense.last_status = 'starting';

	rover.realsense.process = spawn('nice', ['-n', '10', vision.python_path, script_path, JSON.stringify(vision_config)], {
		cwd: process.cwd(),
		stdio: ['pipe', 'pipe', 'pipe']
	});

	rover.logs.realsense_message_handler.log(rover, 'Starting realsense vision process: ' + script_path);
	rover.realsense.process.stdout.setEncoding('utf8');
	rover.realsense.process.stderr.setEncoding('utf8');

	rover.realsense.process.stdout.on('data', function (data) {
		handle_realsense_stdout(rover, data);
	});

	rover.realsense.process.stderr.on('data', function (data) {
		let message = data.toString().trim();
		if (!message) {
			return;
		}

		console.log('realsense vision stderr:', message);
		rover.logs.realsense_message_handler.log(rover, 'Vision stderr: ' + message);
	});

	rover.realsense.process.on('error', function (e) {
		console.log('rover.realsense.process error: ', e);
		rover.logs.realsense_message_handler.log(rover, 'Vision process error: ' + e.toString());
		reset_realsense_connection(rover);
	});

	rover.realsense.process.on('close', function (code) {
		console.log('realsense vision exited with code: ' + code);
		rover.logs.realsense_message_handler.log(rover, 'Vision process exited with code: ' + code);
		reset_realsense_connection(rover);
		setTimeout(function () {
			start_realsense_vision(rover);
		}, 5000);
	});
}

function connect_legacy_realsense(rover) {
	if (!rover.realsense.port_path) {
		console.log('No realsense port defined');
		return;
	}

	rover.realsense.serial = new rover.SerialPort({path: rover.realsense.port_path, baudRate: rover.realsense.baudrate});

	rover.realsense.serial.on('open', function () {
		console.log('Connected to realsense on port: ' + rover.realsense.port_path);
		rover.logs.realsense_message_handler.log(rover, 'Connected to realsense on port: ' + rover.realsense.port_path);
		rover.realsense.connected = true;
		rover.realsense.transport = 'serial';

		rover.realsense.serial.on('data', function () {
		});

		rover.realsense.parser = rover.realsense.serial.pipe(new rover.Readline(
			{
				delimiter: '\n'
			}));

		rover.realsense.parser.on('data', function (input) {
			rover.realsense_message_handler(rover, input);
		});

		rover.realsense.parser.on('error', function (e) {
			console.log('rover.realsense.parser: ', e);
		});
	});

	rover.realsense.serial.on('close', function (e) {
		console.log('rover.realsense.serial close: ', e);
		reset_realsense_connection(rover);
	});

	rover.realsense.serial.on('error', function (e) {
		console.log('rover.realsense.serial error: ', e);
		reset_realsense_connection(rover);
	});
}

var connect_to_realsense = function (rover) {
	if (rover.realsense.vision && rover.realsense.vision.enabled) {
		start_realsense_vision(rover);
		return;
	}

	connect_legacy_realsense(rover);
};

module.exports = connect_to_realsense;
