// Dance move — arm up/down bob.
//
// Sends the claw arm servo direct "arm" commands over the Arduino link
// (see arduino/notip_arm/notip_arm.ino, message == "arm": arm.write(value)).
// That branch never touches arm_state/arm_time_stamp — those are only set
// by deliver_package()/stow_arm() — so bobbing here can't trip the
// arm_extend_timeout/arm_retract_timeout failsafes in the firmware.
//
// Range: arm_retract_value (25, the boot/stowed position — see setup() in
// the .ino) up to arm_extend_value (200, full open — the Servo library
// clamps it to 180°). 90 only moved the arm ~3 inches, too small to read
// as a dance. HOLD_MS gives the servo time to swing the full range before
// reversing. dance_mode.js calls
// white_rabbit.create_arduino_message(white_rabbit, 'stow_arm', 0) once at
// the end of the whole routine, so this move doesn't need to re-close the
// arm itself.

const { sleep } = require('./dance_utils');

const ARM_DOWN = 25;
const ARM_UP = 200;
const BOB_COUNT = 4;
const HOLD_MS = 600;

var dance_move_arm_bob = async function (white_rabbit) {
	console.log('dance_moves: arm bob');
	for (let i = 0; i < BOB_COUNT; i++) {
		if (white_rabbit.dance_moves_state && white_rabbit.dance_moves_state.cancel_requested) break;
		white_rabbit.create_arduino_message(white_rabbit, 'arm', ARM_UP);
		await sleep(HOLD_MS);
		white_rabbit.create_arduino_message(white_rabbit, 'arm', ARM_DOWN);
		await sleep(HOLD_MS);
	}
};

module.exports = dance_move_arm_bob;
