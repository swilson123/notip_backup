// Dance-mode music — plays an uploaded mp3 while Noah dances.
//
// Mirrors lib/voice/tts.js's spawn pattern: shell out to a system player,
// degrade silently if the binary or the file isn't there (a rover mid-dance
// shouldn't crash over missing music). mpg123 is the primary target
// (install: sudo apt install mpg123); ffplay is tried as a fallback since
// it ships with ffmpeg, which several other subsystems in this repo already
// assume is present.
//
// Drop mp3 files into lib/dance_moves/music/ — it's a playlist: each dance
// plays the next song in the folder (alphabetical), wrapping at the end, so
// the same song never plays twice in a row. The folder is re-read every
// time, so songs added or removed take effect on the next dance. Songs in a
// subfolder (music/<song>/<song>.mp3) are set dances with their own
// choreography and are never in the playlist. No config needed for that;
// white_rabbit.dance_moves_config (mounted in notip.js) only controls the
// player volume.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MUSIC_DIR = path.join(__dirname, 'music');

var list_tracks = function () {
	try {
		return fs.readdirSync(MUSIC_DIR).filter(function (f) {
			return f.toLowerCase().endsWith('.mp3');
		}).sort();
	} catch (e) {
		return [];
	}
};

// white_rabbit.dance_moves_state.last_track remembers where the playlist is,
// and music/playlist.json keeps it across restarts: read on the first dance
// after boot, written after every pick. A missing or unreadable file, or a
// last_track that's since been removed from the folder (indexOf -1),
// restarts the playlist at the first song.
const PLAYLIST_FILE = path.join(MUSIC_DIR, 'playlist.json');

var next_track = function (white_rabbit) {
	const tracks = list_tracks();
	if (tracks.length === 0) return null;
	if (white_rabbit.dance_moves_state.last_track == null) {
		try {
			white_rabbit.dance_moves_state.last_track = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8')).last_track;
		} catch (e) { /* no saved position yet — start at the first song */ }
	}
	white_rabbit.dance_moves_state.last_track = tracks[(tracks.indexOf(white_rabbit.dance_moves_state.last_track) + 1) % tracks.length];
	try {
		fs.writeFileSync(PLAYLIST_FILE, JSON.stringify({ last_track: white_rabbit.dance_moves_state.last_track }) + '\n');
	} catch (e) {
		console.error('dance_moves: could not save playlist position:', e && e.message);
	}
	return path.join(MUSIC_DIR, white_rabbit.dance_moves_state.last_track);
};

var make_mp3_player = function (config) {
	const cfg = config || {};
	let current_proc = null;

	// Clears current_proc when the song ends on its own, so is_playing()
	// can tell a set dance (music/<song>/) when to stop moving.
	function spawn_player(binary, args) {
		const proc = spawn(binary, args);
		proc.on('exit', function () {
			if (current_proc === proc) current_proc = null;
		});
		return proc;
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

		is_playing() {
			return current_proc !== null;
		},

		stop() {
			if (current_proc) {
				try { current_proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
				current_proc = null;
			}
		}
	};
};

module.exports = { make_mp3_player: make_mp3_player, next_track: next_track, MUSIC_DIR: MUSIC_DIR };
