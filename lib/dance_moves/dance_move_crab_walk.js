// Dance move — crab walk back and forth.
//
// Uses white_rabbit.crab_white_rabbit (lib/navigation/crab_white_rabbit.js):
// steers all four wheels to the same near-full-lock "horizontal" angle
// yaw_white_rabbit's spin-in-place angle (1750 PWM) continues toward, then
// drives all four wheels together so the chassis translates sideways.
// Reversing the wheel drive direction crabs back the other way with no
// re-steering needed in between.
//
// Bounded the same way lib/voice/voice_manager.js's nudge_forward() is:
// closed-loop on the ZLAC8015D's cumulative encoder pulses
// (white_rabbit.zling.actual_position_pulses_by_id), not a timer — so
// "how far" is a measured distance, not a guess. Each leg targets
// CRAB_DISTANCE_M and alternates direction, so the whole move's footprint
// never exceeds that one distance in either direction from where it
// started — a small fraction of a 10x10 ft area.

const { sleep } = require('./dance_utils');

const CRAB_DISTANCE_M = 0.45;   // ~1.5 ft per leg
const LEG_COUNT = 4;             // there, back, there, back
const ODOM_TICK_MS = 50;
const PAUSE_BETWEEN_LEGS_MS = 200;

var crab_leg = function (white_rabbit, target_m, dir_sign) {
	return new Promise(function (resolve) {
		const voice_cfg = white_rabbit.voice_config || {};
		const dance_cfg = white_rabbit.dance_moves_config || {};
		const rpm = dance_cfg.crab_rpm || 25;
		const wheel_diam_m = voice_cfg.wheel_diameter_m || 0.254;
		const cpr = voice_cfg.cpr_pulses_per_rev || 16385;
		const stall_ms = voice_cfg.stall_timeout_ms || 2000;
		const max_ms = 8000;   // hard cap per leg — well over what CRAB_DISTANCE_M needs at this rpm

		const wheel_circ_m = Math.PI * wheel_diam_m;
		const pulses_per_m = cpr / wheel_circ_m;
		const target_pulses = target_m * pulses_per_m;

		const pos = (white_rabbit.zling && white_rabbit.zling.actual_position_pulses_by_id) || {};
		const start_pos = { 1: pos[1] | 0, 2: pos[2] | 0, 3: pos[3] | 0, 4: pos[4] | 0 };

		let max_abs_delta_pulses = 0;
		let last_motion_ts = Date.now();
		const t_start = Date.now();

		const interval = setInterval(function () {
			const now = Date.now();
			const cur = (white_rabbit.zling && white_rabbit.zling.actual_position_pulses_by_id) || {};
			const deltas = [1, 2, 3, 4].map(function (id) { return Math.abs((cur[id] | 0) - start_pos[id]); });
			const avg_abs_delta = (deltas[0] + deltas[1] + deltas[2] + deltas[3]) / 4;

			if (avg_abs_delta > max_abs_delta_pulses + 5) {
				max_abs_delta_pulses = avg_abs_delta;
				last_motion_ts = now;
			}

			const cancelled = white_rabbit.dance_moves_state && white_rabbit.dance_moves_state.cancel_requested;
			white_rabbit.crab_white_rabbit(white_rabbit, cancelled ? 0 : rpm * dir_sign);

			const reached = avg_abs_delta >= target_pulses;
			const stalled = (now - last_motion_ts) >= stall_ms;
			const timed_out = (now - t_start) >= max_ms;

			if (reached || stalled || timed_out || cancelled) {
				clearInterval(interval);
				white_rabbit.crab_white_rabbit(white_rabbit, 0);
				if (stalled) console.error('dance_moves: crab leg stalled at ' + (avg_abs_delta / pulses_per_m).toFixed(2) + 'm of ' + target_m.toFixed(2) + 'm');
				if (timed_out) console.error('dance_moves: crab leg timed out at ' + (avg_abs_delta / pulses_per_m).toFixed(2) + 'm of ' + target_m.toFixed(2) + 'm');
				resolve();
			}
		}, ODOM_TICK_MS);
	});
};

var dance_move_crab_walk = async function (white_rabbit) {
	console.log('dance_moves: crab walk');
	let dir_sign = Math.random() < 0.5 ? 1 : -1;
	for (let i = 0; i < LEG_COUNT; i++) {
		if (white_rabbit.dance_moves_state && white_rabbit.dance_moves_state.cancel_requested) break;
		await crab_leg(white_rabbit, CRAB_DISTANCE_M, dir_sign);
		dir_sign *= -1;
		await sleep(PAUSE_BETWEEN_LEGS_MS);
	}
	// Re-center steering — crab_white_rabbit leaves the servos at full lock.
	white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
	white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
	white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
	white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);
};

module.exports = dance_move_crab_walk;
