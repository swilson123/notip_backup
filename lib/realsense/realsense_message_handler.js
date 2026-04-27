
function to_number(value, fallback) {
	let parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

var realsense_message_handler = function (rover, data) {
	let parsed_message = null;

	try {
		parsed_message = JSON.parse(data);
		rover.realsense.received_data = parsed_message;
	}
	catch (e) {
		console.log('realsense_message_handler:', e)
		rover.logs.realsense_message_handler.log(rover, 'Invalid JSON: ' + data);
		return;
	}

	if (!parsed_message) {
		return;
	}

	if (parsed_message.message_type === 'path_detection') {
		let detection = rover.realsense.path_detection;
		detection.offset_meters = to_number(parsed_message.offset_meters, 0);
		detection.path_width_meters = to_number(parsed_message.path_width_meters, 0);
		detection.confidence = Math.max(0, Math.min(1, to_number(parsed_message.confidence, 0)));
		detection.left_boundary_visible = !!parsed_message.left_boundary_visible;
		detection.right_boundary_visible = !!parsed_message.right_boundary_visible;
		detection.timestamp = to_number(parsed_message.timestamp, Date.now());
		detection.fps_current = to_number(parsed_message.fps_current, detection.fps_current || 0);
		detection.fps_target = to_number(parsed_message.fps_target, detection.fps_target || detection.fps_current || 0);
		detection.cpu_percent = to_number(parsed_message.cpu_percent, detection.cpu_percent || 0);
		detection.source = parsed_message.source || 'realsense_vision';
		rover.realsense.last_status = parsed_message.status || 'tracking';
		rover.realsense.connected = true;

		rover.realsense.objects = Array.isArray(parsed_message.objects) ? parsed_message.objects : [];

		console.log('realsense_message_handler: Received data:', rover.realsense.received_data);

		if (!rover.realsense.last_detection_log_ts || Date.now() - rover.realsense.last_detection_log_ts >= 1000) {
			rover.realsense.last_detection_log_ts = Date.now();
			let obj_summary = rover.realsense.objects.length
				? rover.realsense.objects.map(function(o) {
					return o.clock_direction_str + ' ' + o.distance_m + 'm [' + o.threat_level + ']';
				  }).join(', ')
				: 'none';
			rover.logs.realsense_message_handler.log(
				rover,
				'Received path detection: offset=' + detection.offset_meters.toFixed(3)
				+ 'm confidence=' + detection.confidence.toFixed(2)
				+ ' fps=' + detection.fps_current
				+ ' cpu=' + detection.cpu_percent
				+ ' objects=' + obj_summary
			);
		}

		return;
	}

	if (parsed_message.message_type === 'status') {
		rover.realsense.last_status = parsed_message.status || 'status';
		rover.logs.realsense_message_handler.log(rover, 'Vision status: ' + JSON.stringify(parsed_message));
		return;
	}

	rover.logs.realsense_message_handler.log(rover, 'Received data: ' + JSON.stringify(rover.realsense.received_data));
};

module.exports = realsense_message_handler;
