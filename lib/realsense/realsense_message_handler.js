
function to_number(value, fallback) {
	let parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

// Clock zones the RealSense camera covers (10→11, 11→12, 12→1, 1→2)
var VISION_ZONE_NUMBERS = [10, 11, 12, 1, 2];
// An object must be continuously detected for this long before its zone light activates
var VISION_CONFIRM_MS = 1000;

function ensure_vision_zones(rover) {
	if (!rover.realsense.vision_zones) {
		rover.realsense.vision_zones = {};
		VISION_ZONE_NUMBERS.forEach(function (z) {
			rover.realsense.vision_zones[z] = { light: 'green', first_seen_ts: null, last_raw_threat: 'green' };
		});
	}
	return rover.realsense.vision_zones;
}

function clock_to_zone(clock_direction) {
	let zone = Math.round(clock_direction);
	if (zone < 1) zone = 12;
	if (zone > 12) zone = 1;
	return zone;
}

function update_vision_zones(rover) {
	let vision_zones = ensure_vision_zones(rover);
	let vision = rover.realsense.vision || {};
	let stop_dist = typeof vision.object_emergency_stop_m === 'number' ? vision.object_emergency_stop_m : 1.0;
	let now = Date.now();

	// Determine the worst raw threat for each camera zone from the current object list
	let zone_raw_threat = {};
	VISION_ZONE_NUMBERS.forEach(function (z) { zone_raw_threat[z] = 'green'; });

	rover.realsense.objects.forEach(function (obj) {
		let zone = clock_to_zone(obj.clock_direction);
		if (VISION_ZONE_NUMBERS.indexOf(zone) === -1) return;
		if (obj.confidence < 0.5) return;

		// red  = in-path high-threat within stop distance  → stop
		// yellow = any other medium/high threat             → proceed slowly
		let obj_light = 'green';
		if (obj.in_rover_path && obj.threat_level === 'high' && obj.distance_m <= stop_dist) {
			obj_light = 'red';
		} else if (obj.threat_level === 'high' || obj.threat_level === 'medium') {
			obj_light = 'yellow';
		}

		// Escalate zone threat (red > yellow > green)
		if (obj_light === 'red' ||
				(obj_light === 'yellow' && zone_raw_threat[zone] === 'green')) {
			zone_raw_threat[zone] = obj_light;
		}
	});

	// Apply 1-second confirmation filter per zone
	VISION_ZONE_NUMBERS.forEach(function (z) {
		let vz = vision_zones[z];
		let raw = zone_raw_threat[z];

		if (raw === 'green') {
			// No threat — clear immediately so the rover is never stuck
			vz.light = 'green';
			vz.first_seen_ts = null;
			vz.last_raw_threat = 'green';
		} else {
			// Reset the confirmation timer if the threat level escalated
			// (e.g. yellow → red) so the new level must also be sustained for 1 s
			if (raw !== vz.last_raw_threat) {
				vz.first_seen_ts = now;
			} else if (vz.first_seen_ts === null) {
				vz.first_seen_ts = now;
			}
			vz.last_raw_threat = raw;

			if ((now - vz.first_seen_ts) >= VISION_CONFIRM_MS) {
				// Object confirmed for 1 s — activate the light at the current threat level
				vz.light = raw;
			} else {
				// Not yet confirmed — stay green (don't latch a previous red/yellow)
				vz.light = 'green';
			}
		}
	});
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

		// Apply 1-second clock-zone filter: builds rover.realsense.vision_zones with red/yellow/green per zone
		update_vision_zones(rover);

		if (!rover.realsense.last_detection_log_ts || Date.now() - rover.realsense.last_detection_log_ts >= 1000) {
			rover.realsense.last_detection_log_ts = Date.now();
			let obj_summary = rover.realsense.objects.length
				? rover.realsense.objects.map(function(o) {
					return o.clock_direction_str + ' ' + o.distance_m + 'm [' + o.threat_level + ']';
				  }).join(', ')
				: 'none';
			let vz = rover.realsense.vision_zones || {};
			let zone_lights = VISION_ZONE_NUMBERS.map(function (z) {
				return 'z' + z + ':' + (vz[z] ? vz[z].light[0] : 'g');
			}).join(' ');
			let log_line = 'Received path detection: offset=' + detection.offset_meters.toFixed(3)
				+ 'm confidence=' + detection.confidence.toFixed(2)
				+ ' fps=' + detection.fps_current
				+ ' cpu=' + detection.cpu_percent
				+ ' objects=' + obj_summary
				+ ' vision=[' + zone_lights + ']';
			//console.log('realsense_message_handler:', log_line);
			//console.log('realsense_message_handler data:', JSON.stringify(parsed_message, null, 2));
			rover.logs.realsense_message_handler.log(rover, log_line);
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
