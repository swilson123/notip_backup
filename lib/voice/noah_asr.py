#!/usr/bin/env python3
# Noah ASR — continuous offline speech recognition subprocess.
#
# Captures audio from the EMEET M0 Plus (or any ALSA device) and streams
# recognised text as JSON lines to stdout.  The Node.js parent reads these
# and checks for the wake word "noah" before dispatching a command.
#
# Stdout protocol (one JSON object per line):
#   {"type":"partial", "text":"noa stop"}           — partial result (live)
#   {"type":"final",   "text":"noah stop"}           — final result
#   {"type":"ready"}                                  — model loaded, mic open
#   {"type":"error",   "msg":"..."}                   — fatal error
#
# Requirements:
#   pip install vosk sounddevice
#   Download model → https://alphacephei.com/vosk/models
#   Recommended: vosk-model-small-en-us-0.15  (40 MB, fast on Pi 5)
#
# Usage (from Node.js via spawn):
#   python3 noah_asr.py --model ./models/vosk-model-small-en-us-0.15 --device 1

import sys
import json
import argparse
import queue
import threading

def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()

def fatal(msg):
    emit({'type': 'error', 'msg': msg})
    sys.exit(1)

# Restricted vocabulary fed to Vosk — dramatically improves accuracy for
# known words by preventing the model from guessing unrelated phonemes.
# Keep in sync with commands.js patterns.  Include [unk] so silence/noise
# is absorbed gracefully rather than hallucinated as vocabulary words.
GRAMMAR_VOCAB = [
    # Wake word variants (vosk often hears "noah" as "noa" or "no")
    "noah", "noa", "no",
    # Mission control
    "stop", "halt", "freeze", "emergency",
    "abort", "cancel", "mission",
    "resume", "go", "continue", "carry", "on", "out",
    "return", "home", "come", "rtl",
    # Motion
    "move", "forward", "advance", "back", "up", "reverse",
    "left", "right", "spin", "rotate",
    # Delivery
    "deliver", "drop", "package", "deploy", "it",
    # Diagnostics
    "status", "what", "where", "doing", "location", "gps", "coordinates",
    "fault", "battery", "power", "charge", "stuck", "wrong",
    "scan", "calibrate", "recalibrate", "survey", "look", "around",
    "help", "me", "need", "i",
    "mission", "waypoint",
    # Speed / volume
    "speed", "faster", "slower", "down", "increase", "decrease",
    "louder", "quieter", "quiet", "volume",
    # Feedback
    "good", "bad", "boy", "correct", "incorrect", "well", "done",
    "nice", "work", "job",
    # Filler / connectors that appear in multi-word commands
    "the", "a", "are", "you", "your", "how", "is",
    # Easter egg
    "speak",
    # Out-of-vocabulary catch-all — absorbs noise/unknown words
    "[unk]",
]

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--model',       default='./models/vosk-model-small-en-us-0.15')
    p.add_argument('--device',      type=int, default=1,    help='ALSA device index (int)')
    p.add_argument('--samplerate',  type=int, default=16000)
    p.add_argument('--blocksize',   type=int, default=8000)
    return p.parse_args()

def main():
    args = parse_args()

    try:
        from vosk import Model, KaldiRecognizer
    except ImportError:
        fatal('vosk not installed — run: pip install vosk')

    try:
        import sounddevice as sd
    except ImportError:
        fatal('sounddevice not installed — run: pip install sounddevice')

    import os
    if not os.path.isdir(args.model):
        fatal('vosk model not found at ' + args.model + ' — download from https://alphacephei.com/vosk/models')

    try:
        model = Model(args.model)
    except Exception as e:
        fatal('failed to load vosk model: ' + str(e))

    grammar = json.dumps(GRAMMAR_VOCAB)
    try:
        rec = KaldiRecognizer(model, args.samplerate, grammar)
    except Exception:
        # Fall back to unrestricted if grammar arg not supported by this vosk version
        rec = KaldiRecognizer(model, args.samplerate)
    rec.SetWords(False)

    audio_q = queue.Queue()

    def audio_callback(indata, frames, time, status):
        audio_q.put(bytes(indata))

    try:
        stream = sd.RawInputStream(
            samplerate=args.samplerate,
            blocksize=args.blocksize,
            device=args.device,
            dtype='int16',
            channels=1,
            callback=audio_callback
        )
    except Exception as e:
        fatal('failed to open audio device ' + str(args.device) + ': ' + str(e))

    emit({'type': 'ready'})

    with stream:
        while True:
            try:
                data = audio_q.get(timeout=5)
            except queue.Empty:
                continue
            except KeyboardInterrupt:
                break

            if rec.AcceptWaveform(data):
                result = json.loads(rec.Result())
                text   = result.get('text', '').strip()
                if text:
                    emit({'type': 'final', 'text': text})
            else:
                partial = json.loads(rec.PartialResult())
                text    = partial.get('partial', '').strip()
                if text:
                    emit({'type': 'partial', 'text': text})

if __name__ == '__main__':
    main()
