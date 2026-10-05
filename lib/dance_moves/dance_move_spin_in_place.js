// Dance move — spin in place, yawing back and forth (a twist to the music).
//
// Delegates to white_rabbit.yaw_white_rabbit (lib/navigation/yaw_white_rabbit.js),
// the same 4-wheel spin-in-place primitive run_mission.js uses above
// mission_yaw_start_deg. That function only applies a one-shot command per
// call — the closed loop lives here, the same pattern
// lib/voice/voice_manager.js's nudge_spin() uses: accumulate signed
// ATTITUDE.yaw deltas each tick so jitter that briefly reverses doesn't
// inflate progress.
//
// The twist is a list of heading targets relative to the start heading:
// +SWING, -SWING, +SWING, ... then back to 0. Each tick drives toward the
// current target; once the accumulated offset crosses it, the next target
// takes over and the wheels reverse. Ending on 0 leaves Noah facing the way
// he started. First direction is random so back-to-back routines don't
// always twist the same way. Bounded in place — no lateral travel.

const { signed_angle_delta_rad } = require('./dance_utils');

const TICK_MS = 50;
const SWING_DEG = 45;               // twist this far each side of the start heading
const SWING_COUNT = 6;              // number of +/- swings before returning to center
const SEGMENT_TIMEOUT_MS = 4000;    // per-target safety cap
const FALLBACK_MS_PER_DEG = 12;     // no yaw feedback: time-based twist (~45° in ~0.5s)

var dance_move_spin_in_place = function (white_rabbit) {
	return new Promise(function (resolve) {
		const rpm = (white_rabbit.dance_moves_config && white_rabbit.dance_moves_config.spin_rpm) || 25;
		const first_sign = Math.random() < 0.5 ? -1 : 1;   // +1 = CW = right, matches yaw_white_rabbit's convention
		console.log('dance_moves: spin in place (twist, first ' + (first_sign > 0 ? 'right' : 'left') + ')');

		const targets_deg = [];
		for (let i = 0; i < SWING_COUNT; i++) targets_deg.push((i % 2 === 0 ? first_sign : -first_sign) * SWING_DEG);
		targets_deg.push(0);

		const has_yaw = !!(white_rabbit.robot_data && white_rabbit.robot_data.ATTITUDE && white_rabbit.robot_data.ATTITUDE.yaw != null);
		let prev_yaw = has_yaw ? white_rabbit.robot_data.ATTITUDE.yaw : null;
		let offset_deg = 0;          // accumulated heading offset from start (+ = right)
		let from_deg = 0;            // offset at the start of the current segment (fallback timing)
		let idx = 0;
		let t_segment = Date.now();

		const interval = setInterval(function () {
			if (has_yaw) {
				const cur_yaw = white_rabbit.robot_data && white_rabbit.robot_data.ATTITUDE
					? white_rabbit.robot_data.ATTITUDE.yaw : null;
				if (cur_yaw != null) {
					offset_deg += signed_angle_delta_rad(prev_yaw, cur_yaw) * 180 / Math.PI;
					prev_yaw = cur_yaw;
				}
			}

			const target = targets_deg[idx];
			const dir = target > from_deg ? 1 : -1;
			const elapsed = Date.now() - t_segment;
			const reached = has_yaw
				? (target - offset_deg) * dir <= 0
				: elapsed >= Math.abs(target - from_deg) * FALLBACK_MS_PER_DEG;
			const timed_out = elapsed >= SEGMENT_TIMEOUT_MS;

			if (reached || timed_out) {
				if (timed_out && !reached) console.error('dance_moves: twist segment timed out before reaching ' + target + ' degrees');
				from_deg = target;
				t_segment = Date.now();
				idx++;
			}

			const cancelled = white_rabbit.dance_moves_state && white_rabbit.dance_moves_state.cancel_requested;
			if (idx >= targets_deg.length || cancelled) {
				clearInterval(interval);
				white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'dance_move_spin_in_place');
				white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'dance_move_spin_in_place');
				white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'dance_move_spin_in_place');
				white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'dance_move_spin_in_place');
				resolve();
				return;
			}

			white_rabbit.yaw_white_rabbit(white_rabbit, targets_deg[idx] > from_deg ? 1 : -1, rpm);
		}, TICK_MS);
	});
};

module.exports = dance_move_spin_in_place;
