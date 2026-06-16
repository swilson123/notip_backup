// Voice Manager — Noah's voice system.
//
// Wires TTS + ASR + command handling + mind into a single mounted object
// at white_rabbit.voice.  Everything that causes Noah to speak or listen lives here.
//
// Public API (white_rabbit.voice.*):
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
    // "Object detected" doesn't stop motors on its own — it starts the
    // ~10 s blocked-path countdown to fallback delivery. Don't promise a stop
    // we won't deliver until the countdown actually elapses.
    object_detected:    'Object detected.',
    object_cleared:     'Path clear.',
    sidewalk_found:     'Sidewalk found.',
    sidewalk_loss:      'Sidewalk lost. Slowing down.',
    sidewalk_on:        'On the sidewalk. Following the edge.',
    sidewalk_off:       'Leaving the sidewalk.',
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

function handle_command(white_rabbit, tts, cmd) {
    const { intent, payload } = cmd;

    if (intent === 'stop' || intent === 'abort') {
        // Kill any in-flight voice nudge/spin and release the RC override
        // so the operator's sticks take effect immediately.
        if (white_rabbit.voice_nudge_timeout) {
            clearTimeout(white_rabbit.voice_nudge_timeout);
            white_rabbit.voice_nudge_timeout = null;
        }
        if (white_rabbit.voice_spin_interval) {
            clearInterval(white_rabbit.voice_spin_interval);
            white_rabbit.voice_spin_interval = null;
        }
        white_rabbit.voice_override_until = 0;
        white_rabbit.mission.pause_mission = true;
        stop_motors(white_rabbit);
        tts.speak('Stopping.', true);
        return;
    }

    if (intent === 'resume') {
        white_rabbit.mission.pause_mission = false;
        tts.speak('Resuming.');
        return;
    }

    if (intent === 'good_boy') {
        if (white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
            white_rabbit.learning.add('human_positive_feedback', {
                lat: white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude,
                lng: white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude
            });
        }
        tts.speak('Thank you.');
        return;
    }

    if (intent === 'bad_boy') {
        if (white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
            white_rabbit.learning.add('human_correction', {
                lat: white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude,
                lng: white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude
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
        nudge_lateral(white_rabbit, dir, payload.meters || 0.3048);
        return;
    }

    if (intent === 'move_forward') {
        const dist = payload.value || 1;
        const unit = payload.unit  || 'foot';
        tts.speak('Moving forward ' + dist + ' ' + unit + '.');
        nudge_forward(white_rabbit, payload.meters || 0.3048);
        return;
    }

    if (intent === 'move_back') {
        const dist = payload.value || 1;
        const unit = payload.unit  || 'foot';
        tts.speak('Backing up ' + dist + ' ' + unit + '.');
        nudge_forward(white_rabbit, -(payload.meters || 0.3048));
        return;
    }

    if (intent === 'spin_left' || intent === 'spin_right') {
        const dir = intent === 'spin_left' ? 'left' : 'right';
        const deg = payload.degrees;
        tts.speak('Spinning ' + dir + (deg != null ? ' ' + deg + ' degrees.' : '.'));
        nudge_spin(white_rabbit, dir, deg);
        return;
    }

    if (intent === 'return_home') {
        tts.speak('Returning home.');
        if (white_rabbit.mission) white_rabbit.mission.package_delivered = true;
        return;
    }

    if (intent === 'status') {
        tts.speak(build_status(white_rabbit));
        return;
    }

    if (intent === 'location') {
        const lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
        const lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
        if (lat && lng) {
            tts.speak('I am at ' + lat.toFixed(5) + ' latitude, ' + lng.toFixed(5) + ' longitude.');
        } else {
            tts.speak('GPS position not available.');
        }
        return;
    }

    if (intent === 'fault_report') {
        tts.speak(build_fault_report(white_rabbit));
        return;
    }

    if (intent === 'mission_status') {
        const seq   = white_rabbit.mission && white_rabbit.mission.current_mission_seq;
        const total = white_rabbit.mission && white_rabbit.mission.mission_count;
        if (seq != null && total != null) {
            tts.speak('Waypoint ' + seq + ' of ' + total + '.');
        } else {
            tts.speak('No active mission.');
        }
        return;
    }

    if (intent === 'speed_up') {
        if (white_rabbit.motor) white_rabbit.motor.throttle_percentage = Math.min(1.0, white_rabbit.motor.throttle_percentage + 0.1);
        tts.speak('Speed increased.');
        return;
    }

    if (intent === 'slow_down') {
        if (white_rabbit.motor) white_rabbit.motor.throttle_percentage = Math.max(0.1, white_rabbit.motor.throttle_percentage - 0.1);
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
        if (white_rabbit.deliver_package && typeof white_rabbit.deliver_package === 'function') {
            white_rabbit.deliver_package(white_rabbit);
        }
        return;
    }

    if (intent === 'scan') {
        tts.speak(build_scan_report(white_rabbit));
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
        if (white_rabbit.mission) white_rabbit.mission.pause_mission = true;
        stop_motors(white_rabbit);
        return;
    }
}

// ---------- nudge helpers ----------
// Nudges are manual motor moves: pause mission (mission mode) and claim a
// voice-override window (RC mode), drive, then release. Override window
// suppresses radio_commands.js stick handling; stick deflection in any axis
// cancels the override mid-flight — operator intent always wins.
//
// Motor sign convention (matches undock_white_rabbit and preform_turn):
//   M1 (front passenger), M2 (back passenger): NEGATIVE = forward
//   M3 (front driver),    M4 (back driver):    POSITIVE = forward
// The passenger and driver side motors are mounted facing opposite ways,
// so straight-ahead motion requires opposite RPM signs across the sides.
//
// Spin geometry: spinning the white_rabbit in place requires all four steering
// servos at ~PWM 1750 (star/X pattern). With wheels in that geometry,
// commanding all four motors with the SAME sign rotates the white_rabbit around
// its center. We delegate to yaw_white_rabbit, which already handles this.

const DEFAULT_NUDGE_RPM      = 30;
const DEFAULT_WHEEL_DIAM_M   = 0.254;   // 10" wheels
const DEFAULT_CPR            = 16385;   // ZLAC8015D encoder counts per revolution
const DEFAULT_MAX_NUDGE_MS   = 30000;   // hard safety cap
const DEFAULT_STALL_MS       = 2000;    // commanded but no motion for this long → abort
const ODOM_TICK_MS           = 50;

// Claim the motors for `ms`. Cancels any prior in-flight nudge/spin first.
function begin_voice_motion(white_rabbit, ms) {
    if (white_rabbit.voice_nudge_timeout) {
        clearTimeout(white_rabbit.voice_nudge_timeout);
        white_rabbit.voice_nudge_timeout = null;
    }
    if (white_rabbit.voice_spin_interval) {
        clearInterval(white_rabbit.voice_spin_interval);
        white_rabbit.voice_spin_interval = null;
    }
    white_rabbit.mission.pause_mission = true;
    white_rabbit.voice_override_until = Date.now() + ms + 100;   // buffer past stop
}

function end_voice_motion(white_rabbit) {
    white_rabbit.voice_override_until = 0;
    white_rabbit.voice_nudge_timeout = null;
    white_rabbit.voice_spin_interval = null;
    white_rabbit.mission.pause_mission = false;
}

// Drive straight: sign=+1 forward, sign=-1 backward.
function drive_straight(white_rabbit, rpm, sign, trigger) {
    white_rabbit.move_white_rabbit(white_rabbit, 1, -rpm * sign, trigger);
    white_rabbit.move_white_rabbit(white_rabbit, 2, -rpm * sign, trigger);
    white_rabbit.move_white_rabbit(white_rabbit, 3,  rpm * sign, trigger);
    white_rabbit.move_white_rabbit(white_rabbit, 4,  rpm * sign, trigger);
}

// Closed-loop straight drive using ZLAC8015D cumulative encoder position
// (REG_*_POS) as wheel odometry. Source of truth is the per-wheel pulse
// count cached on white_rabbit.zling.actual_position_pulses_by_id.
//
// Snapshot start positions, then each tick compute |delta_pulses_i| for
// each wheel, average across the four, and convert to meters:
//
//   distance_m = (avg_|Δpulses| / cpr) × π × wheel_diameter_m
//
// Pulses are exact integer counts, so there's no integration error from
// variable sample timing — the only thing the tick rate controls is how
// quickly we notice that the target has been reached.
//
// Stops when distance_m ≥ target_m, on hard cap (max_nudge_ms), or on
// stall (no pulse change for stall_timeout_ms while commanded).
//
// Slip caveat: this still measures wheel rotation, not chassis travel — a
// spinning wheel without traction still counts pulses. Indoors on hard
// floors that's negligible.
function drive_distance_closed_loop(white_rabbit, target_m, dir_sign, after_finish_fn, trigger) {
    const cfg          = white_rabbit.voice_config || {};
    const rpm          = cfg.nudge_speed_rpm     || DEFAULT_NUDGE_RPM;
    const wheel_diam_m = cfg.wheel_diameter_m    || DEFAULT_WHEEL_DIAM_M;
    const cpr          = cfg.cpr_pulses_per_rev  || DEFAULT_CPR;
    const max_ms       = cfg.max_nudge_ms        || DEFAULT_MAX_NUDGE_MS;
    const stall_ms     = cfg.stall_timeout_ms    || DEFAULT_STALL_MS;
    const wheel_circ_m = Math.PI * wheel_diam_m;
    const pulses_per_m = cpr / wheel_circ_m;
    const target_pulses = target_m * pulses_per_m;

    // Snapshot start positions. If feedback hasn't populated yet, the
    // snapshot will be zeros — the first fresh read after motion starts
    // will give us a non-zero delta, so this is self-healing.
    const pos = white_rabbit.zling.actual_position_pulses_by_id || {};
    const start_pos = { 1: pos[1] | 0, 2: pos[2] | 0, 3: pos[3] | 0, 4: pos[4] | 0 };

    begin_voice_motion(white_rabbit, max_ms);
    drive_straight(white_rabbit, rpm, dir_sign, trigger);

    let max_abs_delta_pulses = 0;
    let last_motion_ts       = Date.now();
    const t_start            = Date.now();

    white_rabbit.voice_nudge_timeout = setInterval(() => {
        const now = Date.now();
        const cur = white_rabbit.zling.actual_position_pulses_by_id || {};

        // Per-wheel signed delta (handles 32-bit two's-complement subtraction
        // naturally since both operands are signed ints in range).
        const deltas = [1, 2, 3, 4].map(id => Math.abs((cur[id] | 0) - start_pos[id]));
        const avg_abs_delta = (deltas[0] + deltas[1] + deltas[2] + deltas[3]) / 4;
        const distance_m    = avg_abs_delta / pulses_per_m;

        if (avg_abs_delta > max_abs_delta_pulses + 5) {   // moved at least ~5 pulses since last check
            max_abs_delta_pulses = avg_abs_delta;
            last_motion_ts = now;
        }

        // Re-assert motor command each tick — defensive against losing it
        // to any other writer that might have slipped in.
        drive_straight(white_rabbit, rpm, dir_sign, trigger);

        const reached   = avg_abs_delta >= target_pulses;
        const stalled   = (now - last_motion_ts) >= stall_ms;
        const timed_out = (now - t_start)        >= max_ms;

        if (reached || stalled || timed_out) {
            clearInterval(white_rabbit.voice_nudge_timeout);
            white_rabbit.voice_nudge_timeout = null;
            stop_motors(white_rabbit);
            if (after_finish_fn) after_finish_fn();
            end_voice_motion(white_rabbit);
            if (stalled)   console.error('voice: drive stalled at ' + distance_m.toFixed(2) + 'm of ' + target_m.toFixed(2) + 'm');
            if (timed_out) console.error('voice: drive timed out at ' + distance_m.toFixed(2) + 'm of ' + target_m.toFixed(2) + 'm');
        }
    }, ODOM_TICK_MS);
}

function nudge_forward(white_rabbit, meters) {
    const sign = meters >= 0 ? 1 : -1;
    drive_distance_closed_loop(white_rabbit, Math.abs(meters), sign, null, 'voice nudge');
}

function nudge_lateral(white_rabbit, dir, meters) {
    // Forward arc with front-Ackermann steering bias — not true sideways
    // motion. Real crab movement would need 4-wheel crab mode.
    // Sign matches the physical wiring (verified on white_rabbit): left = -12°.
    const steer_deg = (dir === 'left') ? -12 : 12;
    const steer_pwm = white_rabbit.angle_to_pwm(steer_deg);
    white_rabbit.servo_send_command(white_rabbit, 11, steer_pwm.servo1, true);
    white_rabbit.servo_send_command(white_rabbit, 13, white_rabbit.opposite_pwm(steer_pwm.servo1), true);
    white_rabbit.servo_send_command(white_rabbit, 12, 1500, false);
    white_rabbit.servo_send_command(white_rabbit, 14, 1500, false);

    drive_distance_closed_loop(white_rabbit, Math.abs(meters), 1, () => {
        white_rabbit.servo_send_command(white_rabbit, 11, 1500, false);
        white_rabbit.servo_send_command(white_rabbit, 13, 1500, false);
    }, 'voice lateral nudge');
}

// Spin in place. Delegates to yaw_white_rabbit (sets steering servos to spin
// geometry and commands motors per its CW=positive convention). With
// `degrees`, runs a closed loop on ATTITUDE.yaw and stops when the
// signed delta reaches the target. Without it, runs a 1.5 s timed spin.
function nudge_spin(white_rabbit, dir, degrees) {
    const rpm            = (white_rabbit.voice_config && white_rabbit.voice_config.nudge_speed_rpm) || DEFAULT_NUDGE_RPM;
    const signed_dir_deg = (dir === 'right') ? 1 : -1;   // +1 = CW = right
    const sign           = signed_dir_deg;

    if (degrees == null) {
        const ms_spin = 1500;
        const t_start = Date.now();
        begin_voice_motion(white_rabbit, ms_spin);
        // yaw_white_rabbit internally gates motors on "steering servos in position"
        // (PWM 1700-1800). On the first call the servos are still travelling
        // 1500 → 1750, so motors stay at 0. We must keep calling it from a
        // ticker so motors fire once the servos arrive.
        white_rabbit.voice_spin_interval = setInterval(() => {
            if (Date.now() - t_start >= ms_spin) {
                clearInterval(white_rabbit.voice_spin_interval);
                white_rabbit.voice_spin_interval = null;
                stop_motors(white_rabbit);
                end_voice_motion(white_rabbit);
                return;
            }
            white_rabbit.yaw_white_rabbit(white_rabbit, signed_dir_deg, rpm);
        }, 50);
        return;
    }

    // ATTITUDE.yaw is radians, set by pixhawk_message_handler from the
    // MAVLink ATTITUDE message.
    const start_yaw = white_rabbit.robot_data && white_rabbit.robot_data.ATTITUDE
        ? white_rabbit.robot_data.ATTITUDE.yaw : null;
    if (start_yaw == null) {
        console.error('voice: cannot spin to angle — ATTITUDE.yaw unavailable');
        nudge_spin(white_rabbit, dir, null);
        return;
    }

    const target_rad  = Math.abs(degrees) * Math.PI / 180;
    // Safety cap: assume ~30°/s, allow 1.5× margin, hard cap 20 s.
    const time_cap_ms = Math.min(Math.abs(degrees) / 30 * 1000 * 1.5, 20000);

    begin_voice_motion(white_rabbit, time_cap_ms);

    // Signed accumulator: count only motion in the commanded direction.
    // Jitter that briefly reverses (or wobble against the spin) subtracts
    // from progress instead of inflating it, so a "spin 360" reaches an
    // honest 360°.
    let prev_yaw     = start_yaw;
    let progress_rad = 0;
    const t_start    = Date.now();
    white_rabbit.voice_spin_interval = setInterval(() => {
        // Re-assert yaw_white_rabbit every tick. Its internal "servos in position"
        // check gates motors at 0 on the first call while servos travel
        // 1500 → 1750 PWM; once they arrive (~50–150 ms), motors engage.
        white_rabbit.yaw_white_rabbit(white_rabbit, signed_dir_deg, rpm);

        const cur = white_rabbit.robot_data && white_rabbit.robot_data.ATTITUDE
            ? white_rabbit.robot_data.ATTITUDE.yaw : null;
        if (cur != null) {
            let d = cur - prev_yaw;
            if (d >  Math.PI) d -= 2 * Math.PI;   // unwrap across ±π
            if (d < -Math.PI) d += 2 * Math.PI;
            progress_rad += d * sign;             // +d when spinning the commanded way
            prev_yaw = cur;
        }
        const timed_out = (Date.now() - t_start) >= time_cap_ms;
        if (progress_rad >= target_rad || timed_out) {
            clearInterval(white_rabbit.voice_spin_interval);
            white_rabbit.voice_spin_interval = null;
            stop_motors(white_rabbit);
            end_voice_motion(white_rabbit);
            if (timed_out) console.error('voice: spin timed out before reaching ' + degrees + '°');
        }
    }, 50);
}

function stop_motors(white_rabbit) {
    if (!white_rabbit.move_white_rabbit) return;
    white_rabbit.move_white_rabbit(white_rabbit, 1, 0, 'voice stop');
    white_rabbit.move_white_rabbit(white_rabbit, 2, 0, 'voice stop');
    white_rabbit.move_white_rabbit(white_rabbit, 3, 0, 'voice stop');
    white_rabbit.move_white_rabbit(white_rabbit, 4, 0, 'voice stop');
}

// ---------- spoken status builders ----------

function build_status(white_rabbit) {
    const intent = white_rabbit.heart ? white_rabbit.heart.guide().intent : null;
    const seq    = white_rabbit.mission && white_rabbit.mission.current_mission_seq;
    const total  = white_rabbit.mission && white_rabbit.mission.mission_count;
    const paused = white_rabbit.mission && white_rabbit.mission.pause_mission;

    if (!white_rabbit.robot_data || !white_rabbit.robot_data.is_armed) return 'Noah is standing by.';
    if (paused) return 'Noah is paused.';
    if (intent === 'blocked')  return 'I am blocked by an obstacle.';
    if (intent === 'recover')  return 'I am recovering from being stuck.';
    if (intent === 'deliver')  return 'Delivering the package at waypoint ' + seq + ' of ' + total + '.';
    if (intent === 'return')   return 'Package delivered. Returning home. Waypoint ' + seq + ' of ' + total + '.';
    if (intent === 'docking')  return 'Almost home. Docking.';
    return 'Navigating. Waypoint ' + seq + ' of ' + total + '.';
}

function build_fault_report(white_rabbit) {
    if (!white_rabbit.mission) return 'No mission active.';
    if (white_rabbit.mission.avoidance_timed_out) return 'Avoidance timeout — I have been spinning too long.';
    if (white_rabbit.mission.realsense_blocked_since) return 'Path blocked by an object in front of me.';
    if (white_rabbit.rplidar && white_rabbit.rplidar.avoid_object) return 'LiDAR sees something close ahead.';
    if (white_rabbit.memory && typeof white_rabbit.memory.reflect === 'function') {
        const r = white_rabbit.memory.reflect(3000);
        if (r && r.stuck)         return 'I appear to be stuck. Not moving despite motor commands.';
        if (r && r.losing_vision) return 'Losing sidewalk confidence.';
    }
    return 'No faults detected right now.';
}

function build_scan_report(white_rabbit) {
    const lines = [];
    const objs = white_rabbit.realsense && Array.isArray(white_rabbit.realsense.objects) ? white_rabbit.realsense.objects : [];
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
    const det = white_rabbit.realsense && white_rabbit.realsense.path_detection;
    if (det && det.confidence > 0.5) {
        lines.push('Sidewalk confidence ' + Math.round(det.confidence * 100) + ' percent.');
    } else {
        lines.push('Sidewalk not visible.');
    }
    return lines.join(' ');
}

// ---------- init ----------

var white_rabbit_voice = function (white_rabbit) {
    const cfg = white_rabbit.voice_config || {};
    const announcements_enabled = cfg.announcements_enabled !== false;
    const dream_speech_enabled  = cfg.dream_speech_enabled !== false;

    const tts = make_tts({
        rate:   cfg.tts_rate        || 160,
        volume: cfg.tts_volume      || 180,
        voice:  cfg.tts_voice       || 'en+m3',
        pitch:  cfg.tts_pitch       || 52,
        device: cfg.tts_alsa_device || null
    });

    function speak_announcement(text, urgent) {
        if (!announcements_enabled) return;
        tts.speak(text, urgent);
    }

    function speak_dream(text, urgent) {
        if (!dream_speech_enabled) return;
        tts.speak(text, urgent);
    }

    // Command handlers expect a TTS object; wrap only speak() so command actions
    // still run while spoken acknowledgements follow announcement gating.
    const command_tts = {
        ...tts,
        speak: speak_announcement
    };

    // Noah mind uses only speak(); gate it as announcement speech.
    const mind_tts = {
        speak: speak_announcement
    };

    // Mind — startup reflection and idle thinking
    const mind = noah_mind.init(white_rabbit, mind_tts);

    // ASR — only start if enabled
    let asr_handle = null;
    if (cfg.asr_enabled !== false) {
        asr_handle = make_asr({
            python_path:  cfg.python_path  || 'python3',
            model_path:   cfg.asr_model_path || './models/vosk-model-small-en-us-0.15',
            audio_device: cfg.audio_device  != null ? cfg.audio_device : 1,
            samplerate:   cfg.asr_samplerate || 16000
        });

        const wake_word = (cfg.wake_word || 'hey noah').toLowerCase();

        asr_handle.emitter.on('ready', () => {
            console.log('voice: ASR ready — listening for wake phrase "' + wake_word + '"');
        });

        // Build phonetic alternates for the wake phrase. "noah" → also accept "noa".
        // Never include bare "no" — it causes false positives on any utterance
        // containing the word "no".
        const wake_alts = [wake_word];
        if (wake_word.includes('noah')) {
            wake_alts.push(wake_word.replace('noah', 'noa'));
        }

        asr_handle.emitter.on('final', ({ text }) => {
            if (!text) return;
            const norm = text.toLowerCase();
            // Diagnostic: log every final ASR result so we can see exactly what
            // Vosk transcribes (useful when commands aren't parsing as expected,
            // e.g. number words missing from the dictionary).
            console.log('voice: ASR final →', JSON.stringify(text));
            // Must hear the full wake phrase (or a phonetic alternate) in the utterance
            const matched_wake = wake_alts.find(w => norm.includes(w));
            if (!matched_wake) return;
            // Strip wake phrase and leading junk before parsing intent
            const after = norm.replace(matched_wake, '').replace(/^\s*,?\s*/, '');
            console.log('voice: post-wake →', JSON.stringify(after));
            const cmd   = parse_command(after);
            if (!cmd) return;
            console.log('voice: command recognised →', cmd.intent, cmd.payload);
            try { handle_command(white_rabbit, command_tts, cmd); } catch (err) {
                console.error('voice: command handler error:', err && err.message);
            }
        });

        asr_handle.emitter.on('error', ({ msg }) => {
            console.error('voice: ASR error:', msg);
        });

        asr_handle.start();
    }

    // Low-battery monitor: repeat a spoken warning every low_battery_repeat_ms
    // while pack voltage is under low_battery_voltage. Resets when a fresh battery
    // brings voltage back above the threshold, so it warns again on the next drop.
    const LOW_BATTERY_V         = typeof cfg.low_battery_voltage === 'number'   ? cfg.low_battery_voltage   : 20.0;
    const LOW_BATTERY_REPEAT_MS = typeof cfg.low_battery_repeat_ms === 'number' ? cfg.low_battery_repeat_ms : 30000;
    let last_low_battery_say = 0;
    const battery_monitor = setInterval(() => {
        const mv = white_rabbit.robot_data && white_rabbit.robot_data.SYS_STATUS
            && white_rabbit.robot_data.SYS_STATUS.voltage_battery;
        // 0 and 65535 are the mavlink "no reading" sentinels — ignore until we have a real value.
        if (typeof mv !== 'number' || mv === 0 || mv === 65535) return;
        const volts = mv / 1000;
        const now = Date.now();
        if (volts < LOW_BATTERY_V) {
            if (now - last_low_battery_say >= LOW_BATTERY_REPEAT_MS) {
                last_low_battery_say = now;
                speak_announcement('Low battery.');
            }
        } else {
            // Voltage recovered (new battery installed) — clear the latch.
            last_low_battery_say = 0;
        }
    }, 5000);

    // Mount on white_rabbit.voice
    white_rabbit.voice = {
        say(text, urgent)      { speak_announcement(text, urgent); },
        say_dream(text, urgent){ speak_dream(text, urgent); },
        say_event(name)        {
            const line = EVENT_LINES[name];
            if (line) speak_announcement(line);
        },
        say_transition(new_intent, last_intent) {
            const key  = last_intent + '->' + new_intent;
            const line = EVENT_LINES[key];
            if (line) speak_announcement(line);
        },
        tts,
        stop() {
            tts.stop();
            if (asr_handle)   asr_handle.stop();
            if (mind && mind.stop) mind.stop();
            clearInterval(battery_monitor);
        }
    };
}

module.exports = white_rabbit_voice;
