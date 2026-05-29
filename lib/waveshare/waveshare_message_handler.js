
var waveshare_message_handler = function (white_rabbit, data) {

	const payload = (typeof data === 'string') ? data : JSON.stringify(data);
	white_rabbit.logs.waveshare_message_handler.log(white_rabbit, 'Received data: ' + payload);

	// Cache per-wheel RPM feedback AND cumulative encoder position on white_rabbit
	// state so consumers (voice nudges, odometry-based motion, stall detection)
	// can read it without re-parsing the Modbus frame. Driver 1 carries motors
	// 1 & 3, driver 2 carries 2 & 4.
	if (data && data.source === 'zling' && typeof data.driver === 'number') {
		if (!white_rabbit.zling.actual_rpm_by_id) {
			white_rabbit.zling.actual_rpm_by_id = { 1: 0, 2: 0, 3: 0, 4: 0, last_updated_ts: 0 };
		}
		if (!white_rabbit.zling.actual_position_pulses_by_id) {
			white_rabbit.zling.actual_position_pulses_by_id = { 1: 0, 2: 0, 3: 0, 4: 0, last_updated_ts: 0 };
		}
		const ts = data.timestamp || Date.now();
		if (data.driver === 1) {
			white_rabbit.zling.actual_rpm_by_id[3] = data.left_feedback_rpm  || 0;
			white_rabbit.zling.actual_rpm_by_id[1] = data.right_feedback_rpm || 0;
			if (typeof data.left_position_pulses  === 'number') white_rabbit.zling.actual_position_pulses_by_id[3] = data.left_position_pulses;
			if (typeof data.right_position_pulses === 'number') white_rabbit.zling.actual_position_pulses_by_id[1] = data.right_position_pulses;
		} else if (data.driver === 2) {
			white_rabbit.zling.actual_rpm_by_id[4] = data.left_feedback_rpm  || 0;
			white_rabbit.zling.actual_rpm_by_id[2] = data.right_feedback_rpm || 0;
			if (typeof data.left_position_pulses  === 'number') white_rabbit.zling.actual_position_pulses_by_id[4] = data.left_position_pulses;
			if (typeof data.right_position_pulses === 'number') white_rabbit.zling.actual_position_pulses_by_id[2] = data.right_position_pulses;
		}
		white_rabbit.zling.actual_rpm_by_id.last_updated_ts             = ts;
		white_rabbit.zling.actual_position_pulses_by_id.last_updated_ts = ts;
	}
};

module.exports = waveshare_message_handler;