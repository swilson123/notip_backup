// TTS — espeak-ng subprocess with a priority queue.
//
// speak(text)          — enqueue a normal line
// speak(text, true)    — urgent: kills current speech and jumps the queue
//
// Requires: sudo apt install espeak-ng
// Voice tuning lives in setup.json under voice.tts_rate / tts_volume / tts_voice / tts_pitch

const { spawn } = require('child_process');

const DEFAULTS = {
    rate:   160,      // words per minute (80–450)
    volume: 180,      // amplitude 0–200
    voice:  'en+m3',  // espeak voice; m3 = male variant 3 — tune to taste
    pitch:  52,       // 0–99
    device: null      // ALSA device string, e.g. 'plughw:CARD=Plus,DEV=0' — null = system default
};

function make_tts(config) {
    const cfg = Object.assign({}, DEFAULTS, config || {});
    const queue = [];
    let speaking  = false;
    let current_proc = null;

    function speak_next() {
        if (speaking || queue.length === 0) return;
        speaking = true;
        const text = queue.shift();
        const args = [
            '-v', cfg.voice,
            '-s', String(cfg.rate),
            '-a', String(cfg.volume),
            '-p', String(cfg.pitch)
        ];
        if (cfg.device) args.push('-d', cfg.device);
        args.push(text);
        current_proc = spawn('espeak-ng', args);
        current_proc.on('close', () => {
            speaking      = false;
            current_proc  = null;
            speak_next();
        });
        current_proc.on('error', err => {
            // espeak-ng not installed or failed — degrade silently
            console.error('voice tts: espeak-ng error:', err && err.message);
            speaking     = false;
            current_proc = null;
            speak_next();
        });
    }

    return {
        speak(text, urgent) {
            if (!text) return;
            if (urgent) {
                if (current_proc) {
                    try { current_proc.kill('SIGKILL'); } catch (_) {}
                }
                speaking = false;
                queue.unshift(text);
            } else {
                queue.push(text);
            }
            speak_next();
        },

        stop() {
            queue.length = 0;
            if (current_proc) {
                try { current_proc.kill('SIGKILL'); } catch (_) {}
            }
            speaking     = false;
            current_proc = null;
        },

        set_volume(v) { cfg.volume = Math.max(0,   Math.min(200, Math.round(v))); },
        set_rate(r)   { cfg.rate   = Math.max(80,  Math.min(450, Math.round(r))); },
        get_config()  { return Object.assign({}, cfg); },

        // True while an espeak-ng process is actively producing audio. The LCD
        // face polls this to animate a talking mouth while Noah speaks.
        is_speaking() { return speaking; }
    };
}

module.exports = { make_tts };
