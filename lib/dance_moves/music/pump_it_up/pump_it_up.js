// Set dance — "Hey Noah, pump it up."
//
// A set dance is a folder: the song and its choreography live together in
// music/<song>/. dance_mode.js plays `track` and runs `moves` in order (no
// shuffle). play_mp3.js only picks top-level music/*.mp3 at random, so this
// song never plays in regular dance mode.
//
// Pump It Up: the claw arm lifts like a weight for the whole song.

const path = require('path');
const dance_move_weight_lift = require('../../dance_move_weight_lift');

module.exports = {
	announce: 'Pump it up!',
	track: path.join(__dirname, 'pump_it_up.mp3'),
	moves: [dance_move_weight_lift]
};
