// Dance move — belt back and forth (a shimmy on the delivery actuator).
//
// arduino/notip_arm/notip_arm.ino, message == "belt": value > 1800 →
// extend_belt(), value < 1100 → retract_belt(), otherwise the actuator is
// stopped (actuator.stop() + belt_enable_pin LOW). Real hardware failsafes
// back this up even if we get interrupted mid-shuffle: physical limit
// switches (belt_extend_limit_switch_pin/belt_retract_limit_switch_pin)
// stop the actuator the instant it reaches either end, and
// belt_extend_timeout/belt_retract_timeout (30s) stop it regardless. Each
// burst here is a fraction of a second, so the belt only ever travels a
// short way off center before reversing.
//
// dance_mode.js calls create_arduino_message(white_rabbit, 'stow_arm', 0)
// once at the end of the whole routine, which fully retracts the belt —
// this move doesn't need to re-home it itself.

const { sleep } = require('./dance_utils');

const EXTEND_VALUE = 1900;
const RETRACT_VALUE = 1100;
const STOP_VALUE = 1500;
const BURST_MS = 400;
const PAUSE_MS = 150;
const SHUFFLE_COUNT = 5;

var dance_move_belt_shuffle = async function (white_rabbit) {
	console.log('dance_moves: belt shuffle');
	for (let i = 0; i < SHUFFLE_COUNT; i++) {
		if (white_rabbit.dance_moves_state && white_rabbit.dance_moves_state.cancel_requested) break;
		white_rabbit.create_arduino_message(white_rabbit, 'belt', EXTEND_VALUE);
		await sleep(BURST_MS);
		white_rabbit.create_arduino_message(white_rabbit, 'belt', STOP_VALUE);
		await sleep(PAUSE_MS);
		white_rabbit.create_arduino_message(white_rabbit, 'belt', RETRACT_VALUE);
		await sleep(BURST_MS);
		white_rabbit.create_arduino_message(white_rabbit, 'belt', STOP_VALUE);
		await sleep(PAUSE_MS);
	}
};

module.exports = dance_move_belt_shuffle;
