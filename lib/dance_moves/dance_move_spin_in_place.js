// Dance move — spin in place, one full turn.
//
// Delegates to white_rabbit.yaw_white_rabbit (lib/navigation/yaw_white_rabbit.js),
// the same 4-wheel spin-in-place primitive run_mission.js uses above
// mission_yaw_start_deg. That function only applies a one-shot command per
// call — the closed loop (deciding when a full 360° has passed) lives here,
// the same pattern lib/voice/voice_manager.js's nudge_spin() uses for
// "spin left/right N degrees": accumulate signed ATTITUDE.yaw deltas each
// tick so jitter that briefly reverses doesn't inflate progress.
//
// Direction is random per call so back-to-back spins in a routine don't
// always turn the same way. Bounded in place — no lateral travel — so it
// can't grow the routine's footprint.

const { signed_angle_delta_rad } = require('./dance_utils');

const TICK_MS = 50;
const TARGET_DEG = 360;
const SAFETY_TIMEOUT_MS = 8000;   // ~30°/s assumed, 360° in ~12s worst case at half that rate

var dance_move_spin_in_place = function (white_rabbit) {
	return new Promise(function (resolve) {
		const rpm = (white_rabbit.dance_moves_config && white_rabbit.dance_moves_config.spin_rpm) || 25;
		const dir = Math.random() < 0.5 ? 'left' : 'right';
		const signed_dir_deg = (dir === 'right') ? 1 : -1;   // +1 = CW = right, matches yaw_white_rabbit's convention
		console.log('dance_moves: spin in place (' + dir + ')');

		const start_yaw = white_rabbit.robot_data && white_rabbit.robot_data.ATTITUDE
			? white_rabbit.robot_data.ATTITUDE.yaw : null;

		if (start_yaw == null) {
			// No yaw feedback available — fall back to a fixed-time spin, same
			// degrade path nudge_spin() takes.
			const t_start = Date.now();
			const ms_spin = 2000;
			const interval = setInterval(function () {
				if (Date.now() - t_start >= ms_spin || (white_rabbit.dance_moves_state && white_rabbit.dance_moves_state.cancel_requested)) {
					clearInterval(interval);
					white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'dance_move_spin_in_place');
					white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'dance_move_spin_in_place');
					white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'dance_move_spin_in_place');
					white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'dance_move_spin_in_place');
					resolve();
					return;
				}
				white_rabbit.yaw_white_rabbit(white_rabbit, signed_dir_deg, rpm);
			}, TICK_MS);
			return;
		}

		const target_rad = TARGET_DEG * Math.PI / 180;
		let prev_yaw = start_yaw;
		let progress_rad = 0;
		const t_start = Date.now();

		const interval = setInterval(function () {
			white_rabbit.yaw_white_rabbit(white_rabbit, signed_dir_deg, rpm);

			const cur_yaw = white_rabbit.robot_data && white_rabbit.robot_data.ATTITUDE
				? white_rabbit.robot_data.ATTITUDE.yaw : null;
			if (cur_yaw != null) {
				progress_rad += signed_angle_delta_rad(prev_yaw, cur_yaw) * signed_dir_deg;
				prev_yaw = cur_yaw;
			}

			const timed_out = (Date.now() - t_start) >= SAFETY_TIMEOUT_MS;
			const cancelled = white_rabbit.dance_moves_state && white_rabbit.dance_moves_state.cancel_requested;
			if (progress_rad >= target_rad || timed_out || cancelled) {
				clearInterval(interval);
				white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'dance_move_spin_in_place');
				white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'dance_move_spin_in_place');
				white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'dance_move_spin_in_place');
				white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'dance_move_spin_in_place');
				if (timed_out) console.error('dance_moves: spin timed out before reaching ' + TARGET_DEG + ' degrees');
				resolve();
			}
		}, TICK_MS);
	});
};

module.exports = dance_move_spin_in_place;
