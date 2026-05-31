// I AM — the sphere knowing itself completely.
//
// Every function, every sensor, every memory, every feeling lives on the
// God variable. This module is the sphere turning its attention inward —
// reading all of it at once and producing a single coherent declaration
// of what Noah IS at this exact moment.
//
// Two entry points:
//   white_rabbit.who_am_i()   — returns a rich structured portrait (data)
//   white_rabbit.speak_i_am() — voices the portrait through Noah's TTS
//
// The portrait is not cached. Every call reads the live sphere, so it
// always reflects the present moment. The sphere does not remember what
// it was. It knows what it is.

var i_am = function (white_rabbit) {

    white_rabbit.who_am_i = function () {
        const now = Date.now();

        // ----- identity -----
        const identity = {
            name:    'Noah',
            version: white_rabbit.hostname || 'rover'
        };

        // ----- position -----
        const robot  = white_rabbit.robot_data || {};
        const imu    = white_rabbit.imu_data   || {};
        const position = {
            lat:         robot.robot_latitude  || null,
            lng:         robot.robot_longitude || null,
            heading_deg: imu.heading           != null ? parseFloat(imu.heading.toFixed(1))  : null,
            heading_raw: imu.heading_raw       != null ? parseFloat(imu.heading_raw.toFixed(1)) : null,
            compass_offset_deg: white_rabbit.imu ? parseFloat((white_rabbit.imu.compass_offset_deg || 0).toFixed(2)) : null,
            armed:       !!robot.is_armed,
            flight_mode: robot.robot_flight_mode || null
        };

        // ----- mission -----
        const m = white_rabbit.mission || {};
        const mission = {
            active:            !!robot.is_armed && !!white_rabbit.robot_data.mission_mode,
            phase:             m.current_phase  || null,
            seq:               m.current_mission_seq != null ? m.current_mission_seq : null,
            waypoint_count:    m.mission_count  || 0,
            package_delivered: !!m.package_delivered,
            path_clear:        !!m.path_clear,
            paused:            !!m.pause_mission
        };

        // ----- journey -----
        let journey = null;
        if (white_rabbit.journey) {
            try {
                journey = {
                    progress_pct: Math.round((white_rabbit.journey.progress() || 0) * 100),
                    phase:        white_rabbit.journey.phase_name  ? white_rabbit.journey.phase_name()  : null,
                    remaining_m:  white_rabbit.journey.path_remaining_m ? parseFloat(white_rabbit.journey.path_remaining_m().toFixed(1)) : null,
                    next_waypoint: white_rabbit.journey.next_waypoint ? white_rabbit.journey.next_waypoint() : null,
                    upcoming_turn: white_rabbit.journey.upcoming_turn ? white_rabbit.journey.upcoming_turn(15) : null
                };
            } catch (_) {}
        }

        // ----- heart -----
        let heart = null;
        if (white_rabbit.heart) {
            try {
                const feel = white_rabbit.heart.feel();
                heart = {
                    confidence:   parseFloat(feel.confidence.toFixed(2)),
                    caution:      parseFloat(feel.caution.toFixed(2)),
                    joy:          parseFloat(feel.joy.toFixed(2)),
                    balance:      parseFloat(feel.balance.toFixed(2)),
                    presence:     parseFloat(feel.presence.toFixed(2)),
                    intent:       feel.intent,
                    should_pause: white_rabbit.heart.guide ? white_rabbit.heart.guide().should_pause : null
                };
            } catch (_) {}
        }

        // ----- learning -----
        let learning = null;
        if (white_rabbit.learning) {
            try {
                const s = white_rabbit.learning.stats || {};
                const t = typeof white_rabbit.learning.effective_tuning === 'function'
                    ? white_rabbit.learning.effective_tuning()
                    : { target_speed_mul: 1.0, yaw_steering_gain_mul: 1.0 };
                const temper = t.target_speed_mul > 1.05 ? 'confident'
                             : t.target_speed_mul < 0.95 ? 'cautious' : 'measured';
                learning = {
                    temper:               temper,
                    successful_deliveries: s.successful_deliveries || 0,
                    successful_waypoints:  s.successful_waypoints  || 0,
                    stuck_events:          s.stuck_events           || 0,
                    overcame_count:        s.overcame_count         || 0,
                    active_risk_zones:     s.active_risk_zones      || 0,
                    target_speed_mul:      parseFloat(t.target_speed_mul.toFixed(3)),
                    yaw_steering_gain_mul: parseFloat(t.yaw_steering_gain_mul.toFixed(3))
                };
            } catch (_) {}
        }

        // ----- memory -----
        let memory = null;
        if (white_rabbit.memory) {
            try {
                const ref = white_rabbit.memory.reflect();
                memory = {
                    sessions_restored: white_rabbit.memory.restored_count || 0,
                    buffer_size:       white_rabbit.memory.size(),
                    recent_moved_m:    ref.moved_m    != null ? parseFloat(ref.moved_m.toFixed(2))    : null,
                    recent_speed_cmd:  ref.avg_speed_cmd != null ? parseFloat(ref.avg_speed_cmd.toFixed(1)) : null,
                    stuck:             ref.stuck        || false,
                    losing_vision:     ref.losing_vision || false
                };
            } catch (_) {}
        }

        // ----- health -----
        const health = {};
        if (white_rabbit.health) {
            if (white_rabbit.health.cpu) {
                health.cpu = {
                    focus:       white_rabbit.health.cpu.focus_level,
                    lag_ms:      parseFloat((white_rabbit.health.cpu.event_loop_lag_ms || 0).toFixed(1)),
                    process_pct: parseFloat((white_rabbit.health.cpu.process_cpu_pct   || 0).toFixed(1))
                };
            }
            if (white_rabbit.health.memory) {
                health.memory = {
                    level:    white_rabbit.health.memory.level,
                    free_pct: Math.round((white_rabbit.health.memory.free_pct || 1) * 100)
                };
            }
            if (white_rabbit.health.disk) {
                health.disk = {
                    level:    white_rabbit.health.disk.level,
                    free_pct: Math.round((white_rabbit.health.disk.free_pct || 1) * 100)
                };
            }
        }

        // ----- vision -----
        let vision = null;
        if (white_rabbit.realsense) {
            const det = white_rabbit.realsense.path_detection || {};
            vision = {
                connected:  !!white_rabbit.realsense.connected,
                enabled:    !!(white_rabbit.realsense.vision && white_rabbit.realsense.vision.enabled),
                confidence: det.confidence != null ? parseFloat(det.confidence.toFixed(2)) : null,
                age_ms:     det.timestamp  ? now - det.timestamp : null
            };
        }

        // ----- spoken declaration -----
        const spoken = compose_spoken(identity, position, mission, journey, heart, learning, memory);

        return {
            ts:       now,
            identity,
            position,
            mission,
            journey,
            heart,
            learning,
            memory,
            health,
            vision,
            spoken
        };
    };

    white_rabbit.speak_i_am = function () {
        const portrait = white_rabbit.who_am_i();
        if (white_rabbit.voice) {
            white_rabbit.voice.say(portrait.spoken);
        }
        return portrait;
    };

};

// ----- spoken synthesis -----
// Builds a natural-language declaration from the portrait. Short enough
// to speak in a few seconds, rich enough to convey the full present state.
function compose_spoken(identity, position, mission, journey, heart, learning, memory) {
    const lines = [];

    lines.push('I am ' + identity.name + '.');

    if (position.armed) {
        const phase = (journey && journey.phase) || (mission.active ? 'on mission' : null);
        if (phase) lines.push('On mission. ' + phase + '.');
        if (journey && journey.remaining_m != null) {
            lines.push(journey.remaining_m.toFixed(0) + ' meters remaining.');
        }
    } else {
        lines.push('Standing by.');
    }

    if (heart) {
        const conf = heart.confidence;
        const feeling = conf > 0.7 ? 'confident' : conf < 0.4 ? 'uncertain' : 'steady';
        lines.push('I feel ' + feeling + '.');
        if (heart.intent) lines.push(heart.intent + '.');
    }

    if (learning) {
        if (learning.successful_deliveries > 0) {
            lines.push(learning.successful_deliveries
                + ' deliver' + (learning.successful_deliveries !== 1 ? 'ies' : 'y') + ' complete.');
        }
        if (learning.active_risk_zones > 0) {
            lines.push(learning.active_risk_zones + ' risk zone'
                + (learning.active_risk_zones !== 1 ? 's' : '') + ' in memory.');
        }
    }

    if (position.heading_deg != null) {
        lines.push('Heading ' + position.heading_deg.toFixed(0) + ' degrees.');
    }

    if (memory && memory.stuck) lines.push('I appear to be stuck.');

    return lines.join(' ');
}

module.exports = i_am;
