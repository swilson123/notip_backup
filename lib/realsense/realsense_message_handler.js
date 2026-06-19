
const path_map_lib = require('./path_map');

function to_number(value, fallback) {
	let parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

// Clock zones the RealSense camera covers (10→11, 11→12, 12→1, 1→2)
var VISION_ZONE_NUMBERS = [10, 11, 12, 1, 2];
// An object must be continuously detected for this long before its zone light activates
var VISION_CONFIRM_MS = 1000;

function ensure_vision_zones(white_rabbit) {
	if (!white_rabbit.realsense.vision_zones) {
		white_rabbit.realsense.vision_zones = {};
		VISION_ZONE_NUMBERS.forEach(function (z) {
			white_rabbit.realsense.vision_zones[z] = { light: 'green', first_seen_ts: null, last_raw_threat: 'green' };
		});
	}
	return white_rabbit.realsense.vision_zones;
}

function clock_to_zone(clock_direction) {
	let zone = Math.round(clock_direction);
	if (zone < 1) zone = 12;
	if (zone > 12) zone = 1;
	return zone;
}

function update_vision_zones(white_rabbit) {
	let vision_zones = ensure_vision_zones(white_rabbit);
	let vision = white_rabbit.realsense.vision || {};
	let stop_dist = typeof vision.object_emergency_stop_m === 'number' ? vision.object_emergency_stop_m : 1.0;
	let now = Date.now();

	// Determine the worst raw threat for each camera zone from the current object list
	let zone_raw_threat = {};
	VISION_ZONE_NUMBERS.forEach(function (z) { zone_raw_threat[z] = 'green'; });

	white_rabbit.realsense.objects.forEach(function (obj) {
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
			// No threat — clear immediately so the white_rabbit is never stuck
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

var DEFAULT_DETECTION_HISTORY_MS = 10000;

var realsense_message_handler = function (white_rabbit, data) {
	let parsed_message = null;

	try {
		parsed_message = JSON.parse(data);
		white_rabbit.realsense.received_data = parsed_message;
		if (!white_rabbit.realsense.json_received) {
			white_rabbit.realsense.json_received = true;
			console.log('realsense_message_handler: JSON data received from RealSense');
		}
	}
	catch (e) {
		console.log('realsense_message_handler:', e)
		white_rabbit.logs.realsense_message_handler.log(white_rabbit, 'Invalid JSON: ' + data);
		return;
	}

	if (!parsed_message) {
		return;
	}

	if (parsed_message.message_type === 'path_detection') {
		let detection = white_rabbit.realsense.path_detection;
		detection.x_angle_deg = to_number(parsed_message.x_angle_deg, 0);
		detection.offset_meters = to_number(parsed_message.offset_meters, 0);
		detection.path_width_meters = to_number(parsed_message.path_width_meters, 0);
		detection.confidence = Math.max(0, Math.min(1, to_number(parsed_message.confidence, 0)));
		detection.left_boundary_visible = !!parsed_message.left_boundary_visible;
		detection.right_boundary_visible = !!parsed_message.right_boundary_visible;
		detection.centerline = Array.isArray(parsed_message.centerline) ? parsed_message.centerline : [];
		detection.nearest_edge_m = (typeof parsed_message.nearest_edge_m === 'number') ? parsed_message.nearest_edge_m : null;
		detection.nearest_edge_side = (parsed_message.nearest_edge_side === 'left' || parsed_message.nearest_edge_side === 'right') ? parsed_message.nearest_edge_side : null;
		detection.nearest_edge_clearance_m = (typeof parsed_message.nearest_edge_clearance_m === 'number') ? parsed_message.nearest_edge_clearance_m : null;
		detection.nearest_edge_type = (parsed_message.nearest_edge_type === 'dropoff' || parsed_message.nearest_edge_type === 'boundary') ? parsed_message.nearest_edge_type : null;
		// Edge-as-guiding-key fields (steering signal: x_angle_deg above is derived from these)
		detection.edge_left_m = (typeof parsed_message.edge_left_m === 'number') ? parsed_message.edge_left_m : null;
		detection.edge_left_conf = to_number(parsed_message.edge_left_conf, 0);
		detection.edge_left_x_m = (typeof parsed_message.edge_left_x_m === 'number') ? parsed_message.edge_left_x_m : null;
		detection.edge_left_y_m = (typeof parsed_message.edge_left_y_m === 'number') ? parsed_message.edge_left_y_m : null;
		detection.edge_left_known = !!parsed_message.edge_left_known;
		detection.edge_left_known_age_ms = (typeof parsed_message.edge_left_known_age_ms === 'number') ? parsed_message.edge_left_known_age_ms : null;
		detection.edge_right_m = (typeof parsed_message.edge_right_m === 'number') ? parsed_message.edge_right_m : null;
		detection.edge_right_conf = to_number(parsed_message.edge_right_conf, 0);
		detection.edge_right_x_m = (typeof parsed_message.edge_right_x_m === 'number') ? parsed_message.edge_right_x_m : null;
		detection.edge_right_y_m = (typeof parsed_message.edge_right_y_m === 'number') ? parsed_message.edge_right_y_m : null;
		detection.edge_right_known = !!parsed_message.edge_right_known;
		detection.edge_right_known_age_ms = (typeof parsed_message.edge_right_known_age_ms === 'number') ? parsed_message.edge_right_known_age_ms : null;
		detection.edge_used = (parsed_message.edge_used === 'left' || parsed_message.edge_used === 'right') ? parsed_message.edge_used : 'none';
		detection.edge_target_offset_m = (typeof parsed_message.edge_target_offset_m === 'number') ? parsed_message.edge_target_offset_m : null;
		detection.edge_forward_m = (typeof parsed_message.edge_forward_m === 'number') ? parsed_message.edge_forward_m : null;
		detection.edge_guidance_valid = !!parsed_message.edge_guidance_valid;
		detection.timestamp = to_number(parsed_message.timestamp, Date.now());
		detection.fps_current = to_number(parsed_message.fps_current, detection.fps_current || 0);
		detection.fps_target = to_number(parsed_message.fps_target, detection.fps_target || detection.fps_current || 0);
		detection.cpu_percent = to_number(parsed_message.cpu_percent, detection.cpu_percent || 0);
		detection.source = parsed_message.source || 'realsense_vision';
		white_rabbit.realsense.last_status = parsed_message.status || 'tracking';
		white_rabbit.realsense.connected = true;

		white_rabbit.realsense.objects = Array.isArray(parsed_message.objects) ? parsed_message.objects : [];

		// Append this frame to rolling detection history and prune expired entries
		if (!white_rabbit.realsense.path_detection_history) {
			white_rabbit.realsense.path_detection_history = [];
		}
		let history_window_ms = (white_rabbit.realsense.vision && typeof white_rabbit.realsense.vision.detection_history_ms === 'number')
			? white_rabbit.realsense.vision.detection_history_ms
			: DEFAULT_DETECTION_HISTORY_MS;
		white_rabbit.realsense.path_detection_history.push({
			timestamp:             detection.timestamp,
			offset_meters:         detection.offset_meters,
			confidence:            detection.confidence,
			path_width_meters:     detection.path_width_meters,
			left_boundary_visible: detection.left_boundary_visible,
			right_boundary_visible:detection.right_boundary_visible
		});
		let cutoff = Date.now() - history_window_ms;
		while (white_rabbit.realsense.path_detection_history.length > 0 &&
		       white_rabbit.realsense.path_detection_history[0].timestamp < cutoff) {
			white_rabbit.realsense.path_detection_history.shift();
		}

		// World-frame sidewalk map: persist centerline observations across frames
		// so the white_rabbit can anticipate turns and ride through transient bad frames.
		// On a GPS jump we skip ingest and leave last_pose anchored to the previous
		// known-good pose; the map keeps its prior content unmodified.
		let path_map = white_rabbit.realsense.path_map;
		if (path_map) {
			let vis = white_rabbit.realsense.vision || {};
			let white_rabbit_lat = white_rabbit.robot_data.robot_latitude;
			let white_rabbit_lng = white_rabbit.robot_data.robot_longitude;
			let heading_deg = path_map_lib.get_white_rabbit_heading(white_rabbit);
			let eph_m = (white_rabbit.robot_data.GPS_RAW_INT && typeof white_rabbit.robot_data.GPS_RAW_INT.eph === 'number')
				? white_rabbit.robot_data.GPS_RAW_INT.eph / 100 : 1.0;
			let pose_valid = typeof white_rabbit_lat === 'number' && typeof white_rabbit_lng === 'number'
			              && typeof heading_deg === 'number';
			let now_ts = Date.now();

			if (pose_valid) {
				let jump_floor = typeof vis.gps_jump_floor_m === 'number' ? vis.gps_jump_floor_m : 0.5;
				let jump_mult  = typeof vis.gps_jump_speed_multiplier === 'number' ? vis.gps_jump_speed_multiplier : 3.0;
				let is_jump = path_map_lib.detect_gps_jump(path_map, white_rabbit_lat, white_rabbit_lng, eph_m, jump_floor, jump_mult);

				if (is_jump) {
					path_map.last_jump_ts = now_ts;
				} else {
					path_map.last_pose = { lat: white_rabbit_lat, lng: white_rabbit_lng, ts: now_ts };
					if (detection.confidence > 0) {
						let merge_r = typeof vis.path_map_merge_radius_m === 'number' ? vis.path_map_merge_radius_m : 0.25;
						path_map_lib.ingest_centerline(
							path_map, detection.centerline, detection.confidence,
							white_rabbit_lat, white_rabbit_lng, heading_deg, now_ts, merge_r
						);
					}
				}

				let max_age_ms  = (typeof vis.path_map_max_age_s === 'number' ? vis.path_map_max_age_s : 5.0) * 1000;
				let max_behind  = typeof vis.path_map_max_behind_m === 'number' ? vis.path_map_max_behind_m : 2.0;
				let max_points  = typeof vis.path_map_max_points === 'number' ? vis.path_map_max_points : 120;
				path_map_lib.prune(path_map, white_rabbit_lat, white_rabbit_lng, heading_deg, max_age_ms, max_behind, max_points);
			}

			if (!path_map.last_log_ts || now_ts - path_map.last_log_ts >= 1000) {
				path_map.last_log_ts = now_ts;
				let oldest_ts = now_ts;
				for (let i = 0; i < path_map.points.length; i++) {
					if (path_map.points[i].observed_at < oldest_ts) oldest_ts = path_map.points[i].observed_at;
				}
				let age_s = path_map.points.length ? (now_ts - oldest_ts) / 1000 : 0;
				let jump_tag = (path_map.last_jump_ts && now_ts - path_map.last_jump_ts < 5000) ? ' [jump<5s]' : '';
				white_rabbit.logs.realsense_message_handler.log(white_rabbit,
					'path_map: ' + path_map.points.length + 'pts oldest_age=' + age_s.toFixed(1) + 's' + jump_tag);
			}
		}

		// Apply 1-second clock-zone filter: builds white_rabbit.realsense.vision_zones with red/yellow/green per zone
		update_vision_zones(white_rabbit);

		if (!white_rabbit.realsense.last_detection_log_ts || Date.now() - white_rabbit.realsense.last_detection_log_ts >= 1000) {
			white_rabbit.realsense.last_detection_log_ts = Date.now();
			let obj_summary = white_rabbit.realsense.objects.length
				? white_rabbit.realsense.objects.map(function(o) {
					return o.clock_direction_str + ' ' + o.distance_m + 'm [' + o.threat_level + ']';
				  }).join(', ')
				: 'none';
			let vz = white_rabbit.realsense.vision_zones || {};
			let zone_lights = VISION_ZONE_NUMBERS.map(function (z) {
				return 'z' + z + ':' + (vz[z] ? vz[z].light[0] : 'g');
			}).join(' ');
			let cl = detection.centerline || [];
			let fmt_signed = function (n) { return (n >= 0 ? '+' : '') + n.toFixed(2); };
			let cl_summary;
			if (cl.length === 0) {
				cl_summary = 'empty';
			} else {
				let near = cl[0], far = cl[cl.length - 1];
				cl_summary = cl.length + 'pts near=[' + near.forward_m.toFixed(1) + 'm,' + fmt_signed(near.lateral_offset_m)
					+ '] far=[' + far.forward_m.toFixed(1) + 'm,' + fmt_signed(far.lateral_offset_m) + ']';
			}
			let edge_summary = 'none';
			if (typeof detection.nearest_edge_clearance_m === 'number') {
				edge_summary = detection.nearest_edge_type + '/' + detection.nearest_edge_side
					+ ' @ ' + detection.nearest_edge_m.toFixed(2) + 'm clearance=' + detection.nearest_edge_clearance_m.toFixed(3) + 'm';
			}
			// Confidence shown as a 1-99 integer (matches the LCD) so it can be monitored
			// live on this feed and the threshold tuned on the Node side. '--' = not seen.
			let conf99 = function (c) {
				if (typeof c !== 'number' || !isFinite(c)) return '--';
				let raw = c > 1.5 ? c : c * 100;   // accept either 0-1 or already-percent
				return String(Math.max(1, Math.min(99, Math.round(raw)))).padStart(2, '0');
			};
			let fmt_e = function (m, c, x, y, known, age_ms) {
				let edge = (m === null ? '--' : m.toFixed(2)) + 'm@C' + (m === null ? '--' : conf99(c));
				let xy = ' xy=[' + (x === null ? '--' : x.toFixed(2)) + ',' + (y === null ? '--' : y.toFixed(2)) + ']';
				let tag = known ? ' known' : ' unknown';
				let age = (typeof age_ms === 'number') ? ' age=' + age_ms.toFixed(0) + 'ms' : '';
				return edge + xy + tag + age;
			};
			let guide_summary = 'valid=' + (detection.edge_guidance_valid ? '1' : '0')
				+ ' use=' + detection.edge_used
				+ ' L=' + fmt_e(detection.edge_left_m, detection.edge_left_conf, detection.edge_left_x_m, detection.edge_left_y_m, detection.edge_left_known, detection.edge_left_known_age_ms)
				+ ' R=' + fmt_e(detection.edge_right_m, detection.edge_right_conf, detection.edge_right_x_m, detection.edge_right_y_m, detection.edge_right_known, detection.edge_right_known_age_ms)
				+ ' target=' + (detection.edge_target_offset_m === null ? '--' : detection.edge_target_offset_m.toFixed(2)) + 'm'
				+ ' @' + (detection.edge_forward_m === null ? '--' : detection.edge_forward_m.toFixed(2)) + 'm';
			let log_line = 'Received path detection: offset=' + detection.offset_meters.toFixed(3)
				+ 'm width=' + detection.path_width_meters.toFixed(2) + 'm'
				+ ' confidence=C' + conf99(detection.confidence)
				+ ' guide=' + guide_summary
				+ ' centerline=' + cl_summary
				+ ' edge=' + edge_summary
				+ ' fps=' + detection.fps_current
				+ ' cpu=' + detection.cpu_percent
				+ ' objects=' + obj_summary
				+ ' vision=[' + zone_lights + ']';
			white_rabbit.logs.realsense_message_handler.log(white_rabbit, log_line);
			white_rabbit.logs.realsense_message_handler.log(white_rabbit, 'RAW: ' + JSON.stringify(parsed_message));
		}

		if (white_rabbit.edge_trail) white_rabbit.edge_trail(white_rabbit, detection);

		return;
	}

	if (parsed_message.message_type === 'status') {
		white_rabbit.realsense.last_status = parsed_message.status || 'status';
		white_rabbit.logs.realsense_message_handler.log(white_rabbit, 'Vision status: ' + JSON.stringify(parsed_message));
		return;
	}

	white_rabbit.logs.realsense_message_handler.log(white_rabbit, 'Received data: ' + JSON.stringify(white_rabbit.realsense.received_data));

};

module.exports = realsense_message_handler;
