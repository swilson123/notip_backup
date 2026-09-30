// Dance-mode music — plays an uploaded mp3 while Noah dances.
//
// Mirrors lib/voice/tts.js's spawn pattern: shell out to a system player,
// degrade silently if the binary or the file isn't there (a rover mid-dance
// shouldn't crash over missing music). mpg123 is the primary target
// (install: sudo apt install mpg123); ffplay is tried as a fallback since
// it ships with ffmpeg, which several other subsystems in this repo already
// assume is present.
//
// Drop mp3 files into lib/dance_moves/music/ — dance_mode.js picks one at
// random each run. No config needed for that; white_rabbit.dance_moves_config
// (mounted in notip.js) only controls the player volume.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MUSIC_DIR = path.join(__dirname, 'music');

var list_tracks = function () {
	try {
		return fs.readdirSync(MUSIC_DIR).filter(function (f) {
			return f.toLowerCase().endsWith('.mp3');
		});
	} catch (e) {
		return [];
	}
};

var pick_random_track = function () {
	const tracks = list_tracks();
	if (tracks.length === 0) return null;
	return path.join(MUSIC_DIR, tracks[Math.floor(Math.random() * tracks.length)]);
};

var make_mp3_player = function (config) {
	const cfg = config || {};
	let current_proc = null;

	function spawn_player(binary, args) {
		return spawn(binary, args);
	}

	return {
		// Fire-and-forget: starts playback and returns immediately so
		// dance_mode.js can run moves while the music plays underneath.
		play(file_path) {
			if (!file_path) return;
			if (current_proc) {
				try { current_proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
				current_proc = null;
			}
			const volume_pct = typeof cfg.music_volume === 'number' ? cfg.music_volume : 100;

			// Try mpg123 first (-q quiet, -f is a 0-32768 amplitude scale on
			// some builds — safer/more portable to just use --gain 0-100 via
			// ALSA mixer semantics is out of scope here, so we scale mpg123's
			// native -f fixed-point volume from our 0-100 pct).
			const mpg123_f = Math.round((volume_pct / 100) * 32768);
			current_proc = spawn_player('mpg123', ['-q', '-f', String(mpg123_f), file_path]);

			current_proc.on('error', function () {
				// mpg123 not installed — fall back to ffplay.
				current_proc = spawn_player('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file_path]);
				current_proc.on('error', function (err) {
					console.error('dance_moves: no mp3 player available (tried mpg123, ffplay):', err && err.message);
					current_proc = null;
				});
			});
		},

		stop() {
			if (current_proc) {
				try { current_proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
				current_proc = null;
			}
		}
	};
};

module.exports = { make_mp3_player: make_mp3_player, pick_random_track: pick_random_track, MUSIC_DIR: MUSIC_DIR };
