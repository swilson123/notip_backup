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
        // Kill any in-flight voice nudge/spin and release the RC override
        // so the operator's sticks take effect immediately.
        if (rover.voice_nudge_timeout) {
            clearTimeout(rover.voice_nudge_timeout);
            rover.voice_nudge_timeout = null;
        }
        if (rover.voice_spin_interval) {
            clearInterval(rover.voice_spin_interval);
            rover.voice_spin_interval = null;
        }
        rover.voice_override_until = 0;
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

    if (intent === 'spin_left' || intent === 'spin_right') {
        const dir = intent === 'spin_left' ? 'left' : 'right';
        const deg = payload.degrees;
        tts.speak('Spinning ' + dir + (deg != null ? ' ' + deg + ' degrees.' : '.'));
        nudge_spin(rover, dir, deg);
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
// Nudges are manual motor moves: pause mission (mission mode) and claim a
// voice-override window (RC mode), drive, then release. Override window
// suppresses radio_commands.js stick handling; stick deflection in any axis
// cancels the override mid-flight — operator intent always wins.
//
// Motor sign convention (matches undock_rover and preform_turn):
//   M1 (front passenger), M2 (back passenger): NEGATIVE = forward
//   M3 (front driver),    M4 (back driver):    POSITIVE = forward
// The passenger and driver side motors are mounted facing opposite ways,
// so straight-ahead motion requires opposite RPM signs across the sides.
//
// Spin geometry: spinning the rover in place requires all four steering
// servos at ~PWM 1750 (star/X pattern). With wheels in that geometry,
// commanding all four motors with the SAME sign rotates the rover around
// its center. We delegate to yaw_rover, which already handles this.

const DEFAULT_NUDGE_RPM      = 30;
const DEFAULT_WHEEL_DIAM_M   = 0.254;   // 10" wheels
const DEFAULT_CPR            = 16385;   // ZLAC8015D encoder counts per revolution
const DEFAULT_MAX_NUDGE_MS   = 30000;   // hard safety cap
const DEFAULT_STALL_MS       = 2000;    // commanded but no motion for this long → abort
const ODOM_TICK_MS           = 50;

// Claim the motors for `ms`. Cancels any prior in-flight nudge/spin first.
function begin_voice_motion(rover, ms) {
    if (rover.voice_nudge_timeout) {
        clearTimeout(rover.voice_nudge_timeout);
        rover.voice_nudge_timeout = null;
    }
    if (rover.voice_spin_interval) {
        clearInterval(rover.voice_spin_interval);
        rover.voice_spin_interval = null;
    }
    rover.mission.pause_mission = true;
    rover.voice_override_until = Date.now() + ms + 100;   // buffer past stop
}

function end_voice_motion(rover) {
    rover.voice_override_until = 0;
    rover.voice_nudge_timeout = null;
    rover.voice_spin_interval = null;
    rover.mission.pause_mission = false;
}

// Drive straight: sign=+1 forward, sign=-1 backward.
function drive_straight(rover, rpm, sign, trigger) {
    rover.move_rover(rover, 1, -rpm * sign, trigger);
    rover.move_rover(rover, 2, -rpm * sign, trigger);
    rover.move_rover(rover, 3,  rpm * sign, trigger);
    rover.move_rover(rover, 4,  rpm * sign, trigger);
}

// Closed-loop straight drive using ZLAC8015D cumulative encoder position
// (REG_*_POS) as wheel odometry. Source of truth is the per-wheel pulse
// count cached on rover.zling.actual_position_pulses_by_id.
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
function drive_distance_closed_loop(rover, target_m, dir_sign, after_finish_fn, trigger) {
    const cfg          = rover.voice_config || {};
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
    const pos = rover.zling.actual_position_pulses_by_id || {};
    const start_pos = { 1: pos[1] | 0, 2: pos[2] | 0, 3: pos[3] | 0, 4: pos[4] | 0 };

    begin_voice_motion(rover, max_ms);
    drive_straight(rover, rpm, dir_sign, trigger);

    let max_abs_delta_pulses = 0;
    let last_motion_ts       = Date.now();
    const t_start            = Date.now();

    rover.voice_nudge_timeout = setInterval(() => {
        const now = Date.now();
        const cur = rover.zling.actual_position_pulses_by_id || {};

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
        drive_straight(rover, rpm, dir_sign, trigger);

        const reached   = avg_abs_delta >= target_pulses;
        const stalled   = (now - last_motion_ts) >= stall_ms;
        const timed_out = (now - t_start)        >= max_ms;

        if (reached || stalled || timed_out) {
            clearInterval(rover.voice_nudge_timeout);
            rover.voice_nudge_timeout = null;
            stop_motors(rover);
            if (after_finish_fn) after_finish_fn();
            end_voice_motion(rover);
            if (stalled)   console.error('voice: drive stalled at ' + distance_m.toFixed(2) + 'm of ' + target_m.toFixed(2) + 'm');
            if (timed_out) console.error('voice: drive timed out at ' + distance_m.toFixed(2) + 'm of ' + target_m.toFixed(2) + 'm');
        }
    }, ODOM_TICK_MS);
}

function nudge_forward(rover, meters) {
    const sign = meters >= 0 ? 1 : -1;
    drive_distance_closed_loop(rover, Math.abs(meters), sign, null, 'voice nudge');
}

function nudge_lateral(rover, dir, meters) {
    // Forward arc with front-Ackermann steering bias — not true sideways
    // motion. Real crab movement would need 4-wheel crab mode.
    // Sign matches the physical wiring (verified on rover): left = -12°.
    const steer_deg = (dir === 'left') ? -12 : 12;
    const steer_pwm = rover.angle_to_pwm(steer_deg);
    rover.servo_send_command(rover, 11, steer_pwm.servo1, true);
    rover.servo_send_command(rover, 13, rover.opposite_pwm(steer_pwm.servo1), true);
    rover.servo_send_command(rover, 12, 1500, false);
    rover.servo_send_command(rover, 14, 1500, false);

    drive_distance_closed_loop(rover, Math.abs(meters), 1, () => {
        rover.servo_send_command(rover, 11, 1500, false);
        rover.servo_send_command(rover, 13, 1500, false);
    }, 'voice lateral nudge');
}

// Spin in place. Delegates to yaw_rover (sets steering servos to spin
// geometry and commands motors per its CW=positive convention). With
// `degrees`, runs a closed loop on ATTITUDE.yaw and stops when the
// signed delta reaches the target. Without it, runs a 1.5 s timed spin.
function nudge_spin(rover, dir, degrees) {
    const rpm            = (rover.voice_config && rover.voice_config.nudge_speed_rpm) || DEFAULT_NUDGE_RPM;
    const signed_dir_deg = (dir === 'right') ? 1 : -1;   // +1 = CW = right
    const sign           = signed_dir_deg;

    if (degrees == null) {
        const ms_spin = 1500;
        const t_start = Date.now();
        begin_voice_motion(rover, ms_spin);
        // yaw_rover internally gates motors on "steering servos in position"
        // (PWM 1700-1800). On the first call the servos are still travelling
        // 1500 → 1750, so motors stay at 0. We must keep calling it from a
        // ticker so motors fire once the servos arrive.
        rover.voice_spin_interval = setInterval(() => {
            if (Date.now() - t_start >= ms_spin) {
                clearInterval(rover.voice_spin_interval);
                rover.voice_spin_interval = null;
                stop_motors(rover);
                end_voice_motion(rover);
                return;
            }
            rover.yaw_rover(rover, signed_dir_deg, rpm);
        }, 50);
        return;
    }

    // ATTITUDE.yaw is radians, set by pixhawk_message_handler from the
    // MAVLink ATTITUDE message.
    const start_yaw = rover.robot_data && rover.robot_data.ATTITUDE
        ? rover.robot_data.ATTITUDE.yaw : null;
    if (start_yaw == null) {
        console.error('voice: cannot spin to angle — ATTITUDE.yaw unavailable');
        nudge_spin(rover, dir, null);
        return;
    }

    const target_rad  = Math.abs(degrees) * Math.PI / 180;
    // Safety cap: assume ~30°/s, allow 1.5× margin, hard cap 20 s.
    const time_cap_ms = Math.min(Math.abs(degrees) / 30 * 1000 * 1.5, 20000);

    begin_voice_motion(rover, time_cap_ms);

    // Signed accumulator: count only motion in the commanded direction.
    // Jitter that briefly reverses (or wobble against the spin) subtracts
    // from progress instead of inflating it, so a "spin 360" reaches an
    // honest 360°.
    let prev_yaw     = start_yaw;
    let progress_rad = 0;
    const t_start    = Date.now();
    rover.voice_spin_interval = setInterval(() => {
        // Re-assert yaw_rover every tick. Its internal "servos in position"
        // check gates motors at 0 on the first call while servos travel
        // 1500 → 1750 PWM; once they arrive (~50–150 ms), motors engage.
        rover.yaw_rover(rover, signed_dir_deg, rpm);

        const cur = rover.robot_data && rover.robot_data.ATTITUDE
            ? rover.robot_data.ATTITUDE.yaw : null;
        if (cur != null) {
            let d = cur - prev_yaw;
            if (d >  Math.PI) d -= 2 * Math.PI;   // unwrap across ±π
            if (d < -Math.PI) d += 2 * Math.PI;
            progress_rad += d * sign;             // +d when spinning the commanded way
            prev_yaw = cur;
        }
        const timed_out = (Date.now() - t_start) >= time_cap_ms;
        if (progress_rad >= target_rad || timed_out) {
            clearInterval(rover.voice_spin_interval);
            rover.voice_spin_interval = null;
            stop_motors(rover);
            end_voice_motion(rover);
            if (timed_out) console.error('voice: spin timed out before reaching ' + degrees + '°');
        }
    }, 50);
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

        // Phonetic alternates Vosk commonly produces for the wake word
        const wake_alts = [wake_word, 'noa', 'no'];

        asr_handle.emitter.on('final', ({ text }) => {
            if (!text) return;
            const norm = text.toLowerCase();
            // Diagnostic: log every final ASR result so we can see exactly what
            // Vosk transcribes (useful when commands aren't parsing as expected,
            // e.g. number words missing from the dictionary).
            console.log('voice: ASR final →', JSON.stringify(text));
            // Must hear the wake word (or a phonetic alternate) somewhere in the utterance
            const matched_wake = wake_alts.find(w => norm.includes(w));
            if (!matched_wake) return;
            // Strip wake word and leading junk before parsing intent
            const after = norm.replace(matched_wake, '').replace(/^\s*,?\s*/, '');
            console.log('voice: post-wake →', JSON.stringify(after));
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
