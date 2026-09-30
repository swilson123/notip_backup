// Dance mode — "Hey Noah, dance mode."
//
// Picks a random order of the moves in lib/dance_moves/ (arm bob, belt
// shuffle, spin in place, drive in a circle, crab walk), runs them one at
// a time, and optionally plays an mp3 dropped into lib/dance_moves/music/
// underneath. Every move that drives or steers is bounded well inside a
// 10x10 ft area — see the geometry notes in dance_move_circle.js (circle),
// dance_move_crab_walk.js (closed-loop on encoder pulses, ~1.5 ft per leg),
// and dance_move_spin_in_place.js (spin never leaves its footprint at all).
//
// Claims the motors the same way lib/voice/voice_manager.js's nudge_*
// helpers do: mission.pause_mission stops run_mission.js's 250ms tick from
// fighting for the motors, and voice_override_until stops RC sticks from
// fighting for them too (see lib/radio_controller/radio_commands.js).
//
// white_rabbit.dance_moves_state is the coordination point for cancelling
// mid-routine: lib/voice/voice_manager.js's "stop"/"abort" handler sets
// cancel_requested = true and stops the music player. Each move's internal
// loop checks cancel_requested and bails out early; this function then
// notices dance_moves_state.active go through its own cleanup on the next
// await and stops looping through remaining moves.

const dance_move_arm_bob = require('./dance_move_arm_bob');
const dance_move_belt_shuffle = require('./dance_move_belt_shuffle');
const dance_move_spin_in_place = require('./dance_move_spin_in_place');
const dance_move_circle = require('./dance_move_circle');
const dance_move_crab_walk = require('./dance_move_crab_walk');
const { make_mp3_player, pick_random_track } = require('./play_mp3');
const { sleep } = require('./dance_utils');

const MAX_DANCE_MS = 120000;   // hard safety cap on voice_override_until/pause_mission

var shuffle = function (arr) {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
	}
	return a;
};

var stop_drive_motors = function (white_rabbit) {
	white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'dance_mode');
	white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'dance_mode');
	white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'dance_mode');
	white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'dance_mode');
};

var dance_mode = async function (white_rabbit, tts) {
	if (white_rabbit.dance_moves_state.active) {
		if (tts) tts.speak('Already dancing.');
		return;
	}

	if (white_rabbit.mission && white_rabbit.mission.auto_delivery) {
		if (tts) tts.speak('Cannot dance mid delivery.');
		return;
	}

	const cfg = white_rabbit.dance_moves_config || {};
	const state = white_rabbit.dance_moves_state;
	state.active = true;
	state.cancel_requested = false;

	white_rabbit.mission.pause_mission = true;
	white_rabbit.voice_override_until = Date.now() + MAX_DANCE_MS;

	const player = make_mp3_player(cfg);
	state.player = player;
	const track = pick_random_track();
	if (track) {
		console.log('dance_moves: playing ' + track);
		player.play(track);
	} else {
		console.log('dance_moves: no mp3 in lib/dance_moves/music/ — dancing without music');
	}

	if (tts) tts.speak('Dance mode.', true);

	const moves = shuffle([dance_move_arm_bob, dance_move_belt_shuffle, dance_move_spin_in_place, dance_move_circle, dance_move_crab_walk]);
	const move_pause_ms = typeof cfg.move_pause_ms === 'number' ? cfg.move_pause_ms : 800;

	try {
		for (const move of moves) {
			if (state.cancel_requested) break;
			await move(white_rabbit);
			if (state.cancel_requested) break;
			await sleep(move_pause_ms);
		}
	} catch (err) {
		console.error('dance_moves: error mid-routine:', err && err.message);
	}

	// Cleanup — always run, whether the routine finished, was cancelled, or errored.
	const was_cancelled = state.cancel_requested;
	stop_drive_motors(white_rabbit);
	player.stop();
	// Re-home the claw assembly (arm closed, belt + telescope retracted)
	// regardless of which arm/belt moves ran — see notes in
	// dance_move_arm_bob.js / dance_move_belt_shuffle.js.
	white_rabbit.create_arduino_message(white_rabbit, 'stow_arm', 0);

	white_rabbit.voice_override_until = 0;
	white_rabbit.mission.pause_mission = false;
	state.active = false;
	state.cancel_requested = false;
	state.player = null;

	if (tts) tts.speak(was_cancelled ? 'Dance stopped.' : 'That was fun.');
};

module.exports = dance_mode;
