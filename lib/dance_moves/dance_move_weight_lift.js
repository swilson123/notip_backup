// Dance move — weight lift: the claw arm curls up and lowers like a rep.
//
// Same Arduino "arm" command as dance_move_arm_bob.js, but the full range
// (arm_retract_value 25 → arm_extend_value 200, the delivery-open position)
// and ramped in steps instead of jumping, so it reads as lifting something
// heavy: a steady lift, a squeeze at the top, a controlled lower, a breath
// at the bottom.
//
// Reps continue for as long as the music plays
// (white_rabbit.dance_moves_state.player.is_playing()), so a set dance
// lasts the whole song. With no music playing it does NO_MUSIC_REPS and
// stops. dance_mode.js stows the arm at the end of the routine.

const { sleep } = require('./dance_utils');

const ARM_DOWN = 25;
const ARM_UP = 200;
const STEP = 25;             // degrees per servo command — 7 even steps from 25 to 200
const LIFT_STEP_MS = 110;    // ~0.8s from bottom to top (9600 baud serial — keep steps >= ~100ms)
const LOWER_STEP_MS = 140;   // ~1s back down — lowering is slower, controlled
const HOLD_TOP_MS = 400;
const REST_BOTTOM_MS = 300;
const NO_MUSIC_REPS = 8;

var dance_move_weight_lift = async function (white_rabbit) {
	console.log('dance_moves: weight lift');
	const with_music = white_rabbit.dance_moves_state.player && white_rabbit.dance_moves_state.player.is_playing();

	for (let rep = 0; with_music ? white_rabbit.dance_moves_state.player.is_playing() : rep < NO_MUSIC_REPS; rep++) {
		for (let a = ARM_DOWN + STEP; a <= ARM_UP; a += STEP) {
			if (white_rabbit.dance_moves_state.cancel_requested) return;
			white_rabbit.create_arduino_message(white_rabbit, 'arm', a);
			await sleep(LIFT_STEP_MS);
		}
		await sleep(HOLD_TOP_MS);
		for (let a = ARM_UP - STEP; a >= ARM_DOWN; a -= STEP) {
			if (white_rabbit.dance_moves_state.cancel_requested) return;
			white_rabbit.create_arduino_message(white_rabbit, 'arm', a);
			await sleep(LOWER_STEP_MS);
		}
		await sleep(REST_BOTTOM_MS);
	}
};

module.exports = dance_move_weight_lift;
