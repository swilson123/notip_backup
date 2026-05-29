// ASR — Node.js wrapper for the noah_asr.py subprocess.
//
// Spawns the Python ASR process and emits 'final' and 'partial' events
// with the recognised text.  Reconnects automatically on crash.
//
// Events emitted:
//   'ready'                        — mic open and model loaded
//   'final'   { text }             — full recognised utterance
//   'partial' { text }             — live in-progress text
//   'error'   { msg }              — subprocess fatal error
//   'exit'    { code }             — subprocess exited

const { spawn }       = require('child_process');
const EventEmitter    = require('events');
const path            = require('path');

const RECONNECT_DELAY_MS = 3000;
const SCRIPT_PATH = path.join(__dirname, 'noah_asr.py');

function make_asr(config) {
    const cfg = Object.assign({
        python_path:  'python3',
        model_path:   './models/vosk-model-small-en-us-0.15',
        audio_device: 1,
        samplerate:   16000
    }, config || {});

    const emitter = new EventEmitter();
    let proc          = null;
    let running       = false;
    let reconnect_t   = null;
    let buf           = '';

    function handle_line(line) {
        if (!line.trim()) return;
        let obj;
        try { obj = JSON.parse(line); } catch (_) { return; }
        if (!obj || !obj.type) return;
        emitter.emit(obj.type, obj);
    }

    function start() {
        if (proc) return;
        running = true;
        const device_arg = Array.isArray(cfg.audio_device)
            ? cfg.audio_device.join(',')
            : String(cfg.audio_device);
        proc = spawn(cfg.python_path, [
            SCRIPT_PATH,
            '--model',      cfg.model_path,
            '--device',     device_arg,
            '--samplerate', String(cfg.samplerate)
        ]);

        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', chunk => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
                handle_line(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
            }
        });

        proc.stderr.on('data', d => {
            // vosk logs info to stderr; only surface real errors
            const s = d.toString().trim();
            if (s) console.error('noah_asr stderr:', s);
        });

        proc.on('close', code => {
            proc    = null;
            buf     = '';
            emitter.emit('exit', { code });
            if (running) {
                // Backoff reconnect — keeps going after transient mic errors
                reconnect_t = setTimeout(start, RECONNECT_DELAY_MS);
            }
        });

        proc.on('error', err => {
            emitter.emit('error', { msg: err && err.message });
        });
    }

    function stop() {
        running = false;
        if (reconnect_t) { clearTimeout(reconnect_t); reconnect_t = null; }
        if (proc) {
            try { proc.kill('SIGTERM'); } catch (_) {}
            proc = null;
        }
    }

    return { emitter, start, stop };
}

module.exports = { make_asr };
