// Voice Manager — Noah's voice system.
//
// Wires TTS + ASR + command handling + mind into a single mounted object
// at rover.voice.  Everything that causes Noah to speak or listen lives here.
//
// Public API (rover.voice.*):
//   say(text)                  — speak a line (normal priority)
//   say(text, true)            — speak urgently (interrupts current speech)
//   say_event(name)            — speak a named event line (see EVENT_LINES)
//   say_transition(new_intent) — speak the named phase-transition line
//   stop()                     — stop speaking and listening

const { make_tts }      = require('./tts');
const { make_asr }      = require('./asr');
const { parse_command } = require('./commands');
const noah_mind         = require('./noah_mind');

// ---------- named event lines (what Noah says when things happen) ----------

const EVENT_LINES = {
    // Mission phases — mirrors TRANSITION_LINES in run_mission.js
    'standby->undocking':              'The journey begins.',
    'undocking->outbound':             'Undocked. On the path.',
    'outbound->homestretch_outbound':  'Nearing the delivery point.',
    'homestretch_outbound->delivering':'Delivering.',
    'delivering->returning':           'Package delivered. The work is done.',
    'returning->homestretch_return':   'Turning for home.',
    'homestretch_return->docking':     'Dock in sight.',
    'docking->standby':                'Noah is home.',

    // Sensor events
    object_detected:    'Object detected. Stopping.',
    object_cleared:     'Path clear.',
    sidewalk_found:     'Sidewalk found.',
    sidewalk_loss:      'Sidewalk lost. Slowing down.',
    gps_lost:           'GPS signal lost.',
    gps_acquired:       'GPS reacquired.',
    low_battery:        'Low battery. Consider returning home.',
    camera_lost:        'Camera signal lost.',
    lidar_blocked:      'Obstacle ahead.',

    // Docking
    docking:            'Noah is docking.',
    undocking:          'Noah is undocking.',

    // Delivery
    package_delivered:  'Package delivered.',
    package_secured:    'Package secured.',

    // Manual override
    manual_override:    'Manual override active.',
    autonomous_mode:    'Resuming autonomous mode.',

    // Stuck / recovery
    stuck_detected:     'I am stuck. Attempting recovery.',
    recovery_complete:  'Recovered. Continuing mission.',

    // Fallback
    fallback_delivery:  'Path blocked too long. Delivering here.',
};

// ---------- command handlers ----------

function handle_command(rover, tts, cmd) {
    const { intent, payload } = cmd;

    if (intent === 'stop' || intent === 'abort') {
        rover.mission.pause_mission = true;
        stop_motors(rover);
        tts.speak('Stopping.', true);
        return;
    }

    if (intent === 'resume') {
        rover.mission.pause_mission = false;
        tts.speak('Resuming.');
        return;
    }

    if (intent === 'good_boy') {
        if (rover.learning && typeof rover.learning.add === 'function') {
            rover.learning.add('human_positive_feedback', {
                lat: rover.robot_data && rover.robot_data.robot_latitude,
                lng: rover.robot_data && rover.robot_data.robot_longitude
            });
        }
        tts.speak('Thank you.');
        return;
    }

    if (intent === 'bad_boy') {
        if (rover.learning && typeof rover.learning.add === 'function') {
            rover.learning.add('human_correction', {
                lat: rover.robot_data && rover.robot_data.robot_latitude,
                lng: rover.robot_data && rover.robot_data.robot_longitude
            });
        }
        tts.speak('Ouch. Noted — correcting.');
        return;
    }

    if (intent === 'move_left' || intent === 'move_right') {
        const dir   = intent === 'move_left' ? 'left' : 'right';
        const dist  = payload.value || 1;
        const unit  = payload.unit  || 'foot';
        tts.speak('Moving ' + dir + ' ' + dist + ' ' + unit + '.');
        nudge_lateral(rover, dir, payload.meters || 0.3048);
        return;
    }

    if (intent === 'move_forward') {
        const dist = payload.value || 1;
        const unit = payload.unit  || 'foot';
        tts.speak('Moving forward ' + dist + ' ' + unit + '.');
        nudge_forward(rover, payload.meters || 0.3048);
        return;
    }

    if (intent === 'move_back') {
        const dist = payload.value || 1;
        const unit = payload.unit  || 'foot';
        tts.speak('Backing up ' + dist + ' ' + unit + '.');
        nudge_forward(rover, -(payload.meters || 0.3048));
        return;
    }

    if (intent === 'spin_left') {
        tts.speak('Spinning left.');
        nudge_spin(rover, 'left');
        return;
    }

    if (intent === 'spin_right') {
        tts.speak('Spinning right.');
        nudge_spin(rover, 'right');
        return;
    }

    if (intent === 'return_home') {
        tts.speak('Returning home.');
        if (rover.mission) rover.mission.package_delivered = true;
        return;
    }

    if (intent === 'status') {
        tts.speak(build_status(rover));
        return;
    }

    if (intent === 'location') {
        const lat = rover.robot_data && rover.robot_data.robot_latitude;
        const lng = rover.robot_data && rover.robot_data.robot_longitude;
        if (lat && lng) {
            tts.speak('I am at ' + lat.toFixed(5) + ' latitude, ' + lng.toFixed(5) + ' longitude.');
        } else {
            tts.speak('GPS position not available.');
        }
        return;
    }

    if (intent === 'fault_report') {
        tts.speak(build_fault_report(rover));
        return;
    }

    if (intent === 'mission_status') {
        const seq   = rover.mission && rover.mission.current_mission_seq;
        const total = rover.mission && rover.mission.mission_count;
        if (seq != null && total != null) {
            tts.speak('Waypoint ' + seq + ' of ' + total + '.');
        } else {
            tts.speak('No active mission.');
        }
        return;
    }

    if (intent === 'speed_up') {
        if (rover.motor) rover.motor.throttle_percentage = Math.min(1.0, rover.motor.throttle_percentage + 0.1);
        tts.speak('Speed increased.');
        return;
    }

    if (intent === 'slow_down') {
        if (rover.motor) rover.motor.throttle_percentage = Math.max(0.1, rover.motor.throttle_percentage - 0.1);
        tts.speak('Speed decreased.');
        return;
    }

    if (intent === 'volume_up') {
        tts.set_volume(tts.get_config().volume + 20);
        tts.speak('Louder.');
        return;
    }

    if (intent === 'volume_down') {
        tts.set_volume(tts.get_config().volume - 20);
        tts.speak('Quieter.');
        return;
    }

    if (intent === 'deliver') {
        tts.speak('Stand clear. Delivering.');
        if (rover.deliver_package && typeof rover.deliver_package === 'function') {
            rover.deliver_package(rover);
        }
        return;
    }

    if (intent === 'scan') {
        tts.speak(build_scan_report(rover));
        return;
    }

    if (intent === 'calibrate') {
        tts.speak('Calibration not available remotely.');
        return;
    }

    if (intent === 'battery') {
        tts.speak('Battery monitoring not connected.');
        return;
    }

    if (intent === 'speak') {
        tts.speak('Ark.');
        return;
    }

    if (intent === 'help_request') {
        tts.speak('I heard you. Please check my surroundings.');
        if (rover.mission) rover.mission.pause_mission = true;
        stop_motors(rover);
        return;
    }
}

// ---------- nudge helpers ----------
// Nudges are manual motor moves: pause mission, drive, then resume.
// NUDGE_SPEED and METERS_PER_SECOND can be tuned in setup.json (voice.nudge_speed_rpm
// and voice.nudge_mps). Defaults are conservative.

const DEFAULT_NUDGE_RPM = 30;
const DEFAULT_NUDGE_MPS = 0.15;   // approximate at 30 RPM

function nudge_forward(rover, meters) {
    const rpm  = (rover.voice_config && rover.voice_config.nudge_speed_rpm) || DEFAULT_NUDGE_RPM;
    const mps  = (rover.voice_config && rover.voice_config.nudge_mps)       || DEFAULT_NUDGE_MPS;
    const ms   = Math.abs(meters / mps) * 1000;
    const sign = meters >= 0 ? 1 : -1;

    rover.mission.pause_mission = true;
    rover.move_rover(rover, 1, rpm * sign, 'voice nudge');
    rover.move_rover(rover, 2, rpm * sign, 'voice nudge');
    rover.move_rover(rover, 3, rpm * sign, 'voice nudge');
    rover.move_rover(rover, 4, rpm * sign, 'voice nudge');
    setTimeout(() => {
        stop_motors(rover);
        rover.mission.pause_mission = false;
    }, Math.min(ms, 5000));   // cap at 5 s for safety
}

function nudge_lateral(rover, dir, meters) {
    // Yaw toward the direction, nudge forward the equivalent distance, yaw back.
    // Simplified: just do a short forward nudge with steering applied.
    // For real sideways movement this would need 4-wheel crab mode.
    const rpm  = (rover.voice_config && rover.voice_config.nudge_speed_rpm) || DEFAULT_NUDGE_RPM;
    const mps  = (rover.voice_config && rover.voice_config.nudge_mps)       || DEFAULT_NUDGE_MPS;
    const ms   = Math.abs(meters / mps) * 1000;

    rover.mission.pause_mission = true;
    // Apply steering angle then drive
    const steer_deg = (dir === 'left') ? -12 : 12;
    if (rover.servo_send_command) {
        // approximate PWM for steering angle — adjust per rover geometry
        const pwm = 1500 + steer_deg * 20;
        rover.servo_send_command(rover, 11, pwm);
        rover.servo_send_command(rover, 12, pwm);
    }
    rover.move_rover(rover, 1, rpm, 'voice lateral nudge');
    rover.move_rover(rover, 2, rpm, 'voice lateral nudge');
    rover.move_rover(rover, 3, rpm, 'voice lateral nudge');
    rover.move_rover(rover, 4, rpm, 'voice lateral nudge');
    setTimeout(() => {
        stop_motors(rover);
        if (rover.servo_send_command) {
            rover.servo_send_command(rover, 11, 1500);
            rover.servo_send_command(rover, 12, 1500);
        }
        rover.mission.pause_mission = false;
    }, Math.min(ms, 5000));
}

function nudge_spin(rover, dir) {
    const rpm    = (rover.voice_config && rover.voice_config.nudge_speed_rpm) || DEFAULT_NUDGE_RPM;
    const ms_spin = 1500;   // spin for 1.5 s
    const sign   = (dir === 'right') ? 1 : -1;

    rover.mission.pause_mission = true;
    // 4-wheel spin: one side forward, other side back
    rover.move_rover(rover, 1,  rpm * sign, 'voice spin');
    rover.move_rover(rover, 2,  rpm * sign, 'voice spin');
    rover.move_rover(rover, 3, -rpm * sign, 'voice spin');
    rover.move_rover(rover, 4, -rpm * sign, 'voice spin');
    setTimeout(() => {
        stop_motors(rover);
        rover.mission.pause_mission = false;
    }, ms_spin);
}

function stop_motors(rover) {
    if (!rover.move_rover) return;
    rover.move_rover(rover, 1, 0, 'voice stop');
    rover.move_rover(rover, 2, 0, 'voice stop');
    rover.move_rover(rover, 3, 0, 'voice stop');
    rover.move_rover(rover, 4, 0, 'voice stop');
}

// ---------- spoken status builders ----------

function build_status(rover) {
    const intent = rover.heart ? rover.heart.guide().intent : null;
    const seq    = rover.mission && rover.mission.current_mission_seq;
    const total  = rover.mission && rover.mission.mission_count;
    const paused = rover.mission && rover.mission.pause_mission;

    if (!rover.robot_data || !rover.robot_data.is_armed) return 'Noah is standing by.';
    if (paused) return 'Noah is paused.';
    if (intent === 'blocked')  return 'I am blocked by an obstacle.';
    if (intent === 'recover')  return 'I am recovering from being stuck.';
    if (intent === 'deliver')  return 'Delivering the package at waypoint ' + seq + ' of ' + total + '.';
    if (intent === 'return')   return 'Package delivered. Returning home. Waypoint ' + seq + ' of ' + total + '.';
    if (intent === 'docking')  return 'Almost home. Docking.';
    return 'Navigating. Waypoint ' + seq + ' of ' + total + '.';
}

function build_fault_report(rover) {
    if (!rover.mission) return 'No mission active.';
    if (rover.mission.avoidance_timed_out) return 'Avoidance timeout — I have been spinning too long.';
    if (rover.mission.realsense_blocked_since) return 'Path blocked by an object in front of me.';
    if (rover.rplidar && rover.rplidar.avoid_object) return 'LiDAR sees something close ahead.';
    if (rover.memory && typeof rover.memory.reflect === 'function') {
        const r = rover.memory.reflect(3000);
        if (r && r.stuck)         return 'I appear to be stuck. Not moving despite motor commands.';
        if (r && r.losing_vision) return 'Losing sidewalk confidence.';
    }
    return 'No faults detected right now.';
}

function build_scan_report(rover) {
    const lines = [];
    const objs = rover.realsense && Array.isArray(rover.realsense.objects) ? rover.realsense.objects : [];
    if (objs.length > 0) {
        const closest = objs.reduce((a, b) =>
            (typeof a.distance_m === 'number' && a.distance_m < (b.distance_m || 99)) ? a : b
        );
        lines.push(objs.length + ' object' + (objs.length > 1 ? 's' : '') + ' detected.');
        if (typeof closest.distance_m === 'number') {
            lines.push('Closest is ' + closest.distance_m.toFixed(1) + ' meters away.');
        }
    } else {
        lines.push('No objects detected.');
    }
    const det = rover.realsense && rover.realsense.path_detection;
    if (det && det.confidence > 0.5) {
        lines.push('Sidewalk confidence ' + Math.round(det.confidence * 100) + ' percent.');
    } else {
        lines.push('Sidewalk not visible.');
    }
    return lines.join(' ');
}

// ---------- init ----------

function init(rover) {
    const cfg = rover.voice_config || {};

    const tts = make_tts({
        rate:   cfg.tts_rate        || 160,
        volume: cfg.tts_volume      || 180,
        voice:  cfg.tts_voice       || 'en+m3',
        pitch:  cfg.tts_pitch       || 52,
        device: cfg.tts_alsa_device || null
    });

    // Mind — startup reflection and idle thinking
    const mind = noah_mind.init(rover, tts);

    // ASR — only start if enabled
    let asr_handle = null;
    if (cfg.asr_enabled !== false) {
        asr_handle = make_asr({
            python_path:  cfg.python_path  || 'python3',
            model_path:   cfg.asr_model_path || './models/vosk-model-small-en-us-0.15',
            audio_device: cfg.audio_device  != null ? cfg.audio_device : 1,
            samplerate:   cfg.asr_samplerate || 16000
        });

        const wake_word = (cfg.wake_word || 'noah').toLowerCase();

        asr_handle.emitter.on('ready', () => {
            console.log('voice: ASR ready — listening for wake word "' + wake_word + '"');
        });

        asr_handle.emitter.on('final', ({ text }) => {
            if (!text) return;
            const norm = text.toLowerCase();
            // Must hear the wake word somewhere in the utterance
            if (!norm.includes(wake_word)) return;
            // Strip wake word and leading junk before parsing intent
            const after = norm.replace(wake_word, '').replace(/^\s*,?\s*/, '');
            const cmd   = parse_command(after);
            if (!cmd) return;
            console.log('voice: command recognised →', cmd.intent, cmd.payload);
            try { handle_command(rover, tts, cmd); } catch (err) {
                console.error('voice: command handler error:', err && err.message);
            }
        });

        asr_handle.emitter.on('error', ({ msg }) => {
            console.error('voice: ASR error:', msg);
        });

        asr_handle.start();
    }

    // Mount on rover.voice
    rover.voice = {
        say(text, urgent)      { tts.speak(text, urgent); },
        say_event(name)        {
            const line = EVENT_LINES[name];
            if (line) tts.speak(line);
        },
        say_transition(new_intent, last_intent) {
            const key  = last_intent + '->' + new_intent;
            const line = EVENT_LINES[key];
            if (line) tts.speak(line);
        },
        tts,
        stop() {
            tts.stop();
            if (asr_handle)   asr_handle.stop();
            if (mind && mind.stop) mind.stop();
        }
    };
}

module.exports = { init };
