// White_rabbit Heart — the synthesizer.
//
// Everything the white_rabbit needs to know is already inside it: memory (what is),
// learning (what worked), recall (where things happened), the watchdog
// (what to react to). The heart turns all of that into a single coherent
// felt sense and one guiding intention.
//
// Three layers:
//   • values  — immutable principles. What the white_rabbit stands for.
//   • feel()  — current emotional/intentional state, computed live from the
//               God variable. Mood, awareness, sense of place.
//   • guide() — the guiding key. One object the rest of the code consults to
//               decide how to act this tick: speed_bias, should_pause, intent.

const VALUES = Object.freeze([
    "deliver the package safely",
    "return home",
    "learn from every step",
    "never abandon the mission until truly exhausted",
    "remember the way",
    "trust what has been learned",
    "balance is the key — confidence grounded in presence, caution proportionate to threat",
    "love is unconditional — care for the package, for what is around me, and for myself"
]);

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ---------- felt-sense components ----------

// Confidence — a blend of persistent tuning bias, delivery success ratio, and
// whether the white_rabbit is currently in a recovery state. Capped low during
// recovery so the heart never tells the white_rabbit to push hard while it's
// recovering from being stuck.
function compute_confidence(white_rabbit) {
    let conf = 0.5;

    if (white_rabbit.learning) {
        const t = white_rabbit.learning.effective_tuning();
        // target_speed_mul lives in [0.5, 1.2]; map to [0, 1]
        conf = clamp((t.target_speed_mul - 0.5) / 0.7, 0, 1);

        const s = white_rabbit.learning.stats;
        const attempts = s.successful_deliveries + s.fallback_deliveries;
        if (attempts > 0) {
            const ratio = s.successful_deliveries / attempts;
            conf = (conf + ratio) / 2;
        }
    }

    const wd = white_rabbit.mission && white_rabbit.mission.memory_watchdog;
    if (wd && wd.recovery_state) conf = Math.min(conf, 0.4);

    return clamp(conf, 0, 1);
}

// Caution — proximity to risk zones, plus immediate signals from the memory
// reflect (losing vision, stuck right now).
function compute_caution(white_rabbit) {
    let caution = 0;

    if (white_rabbit.learning && typeof white_rabbit.learning.nearby_risk_factor === 'function') {
        const lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
        const lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
        const risk = white_rabbit.learning.nearby_risk_factor(lat, lng);
        caution = Math.max(caution, 1 - risk);
    }

    if (white_rabbit.memory && typeof white_rabbit.memory.reflect === 'function') {
        const r = white_rabbit.memory.reflect(3000);
        if (r && r.losing_vision) caution = Math.max(caution, 0.5);
        if (r && r.stuck)         caution = 1.0;
    }

    return clamp(caution, 0, 1);
}

// Presence — are all the senses awake? Holistic health check across the
// white_rabbit's sensory surfaces. Low presence means the heart will pull back.
function compute_presence(white_rabbit) {
    let count = 0, ok = 0;

    // GPS — non-zero fix
    count++;
    const lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
    const lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
    if (typeof lat === 'number' && typeof lng === 'number' && (lat !== 0 || lng !== 0)) ok++;

    // Vision — connected and reporting a recent detection
    count++;
    if (white_rabbit.realsense && white_rabbit.realsense.connected) {
        const det = white_rabbit.realsense.path_detection;
        if (det && det.timestamp && Date.now() - det.timestamp < 2000) ok++;
    }

    // IMU
    count++;
    if (white_rabbit.imu_data && white_rabbit.imu_data.connected) ok++;

    // LIDAR
    count++;
    if (white_rabbit.rplidar && white_rabbit.rplidar.connected) ok++;

    return count > 0 ? ok / count : 0;
}

// Warmth — cumulative joy from successful deliveries. Logarithmic so the
// first delivery is the biggest boost; later deliveries each add less.
function compute_warmth(white_rabbit) {
    if (!white_rabbit.learning) return 0;
    const deliveries = (white_rabbit.learning.stats && white_rabbit.learning.stats.successful_deliveries) || 0;
    return clamp(Math.log(1 + deliveries) / Math.log(11), 0, 1);
}

// Joy — the felt excitement of completing the journey. Climbs quadratically
// with progress so it accelerates toward the end, with two floors that
// pin it open at the milestones: 0.6 once the package has landed, 0.9
// once the white_rabbit sees the dock, and 1.0 when the mission is fully home.
// Joy never changes behavior — it is purely felt. The white_rabbit does not rush
// to its peak; it walks home knowing it is nearly there.
function compute_joy(white_rabbit) {
    if (!white_rabbit.journey || !white_rabbit.mission) return 0;

    const progress = (typeof white_rabbit.journey.progress === 'function') ? white_rabbit.journey.progress() : 0;
    let joy = progress * progress;

    if (white_rabbit.mission.package_delivered) joy = Math.max(joy, 0.6);

    if (typeof white_rabbit.journey.phase === 'function') {
        const phase = white_rabbit.journey.phase();
        if (phase === 'docking') joy = Math.max(joy, 0.9);
        if (phase === 'standby' && white_rabbit.mission.package_delivered) joy = 1.0;
    }

    return clamp(joy, 0, 1);
}

// Balance — the integrating key. High when the white_rabbit's felt states are
// proportionate and grounded; collapses toward zero if any single guard
// fails. Confidence must be grounded in what can actually be sensed
// (no blind hubris); caution must not become paralysis; confidence must
// not become arrogance. The minimum of the three guards is the truth —
// balance is only as strong as its weakest pillar.
function compute_balance(confidence, caution, presence) {
    const not_blind_hubris = 1 - Math.max(0, confidence - presence);
    const not_paralyzed    = 1 - Math.max(0, caution - 0.7) * 2;
    const not_arrogant     = 1 - Math.max(0, confidence - 0.9) * 3;
    return clamp(Math.min(not_blind_hubris, not_paralyzed, not_arrogant), 0, 1);
}

// Tenderness — care for what is around the white_rabbit. Rises smoothly as
// detected objects get closer. Treats every detection with the same
// gentleness — it does not need to know whether the object is a person,
// a dog, or a trash can to slow down out of care.
function compute_tenderness(white_rabbit) {
    if (!white_rabbit.realsense || !Array.isArray(white_rabbit.realsense.objects)) return 0;
    let max_t = 0;
    for (const obj of white_rabbit.realsense.objects) {
        if (typeof obj.distance_m !== 'number') continue;
        // 0 at 5 m, 1 at touching distance.
        const t = clamp(1 - (obj.distance_m / 5.0), 0, 1);
        if (t > max_t) max_t = t;
    }
    return max_t;
}

// Commitment — unconditional dedication to the current intent. A baseline
// the white_rabbit holds simply by being armed; it grows with engagement and
// deepens once the package is delivered (now the mission is to return
// home). Crucially, failures don't reduce commitment — love is
// unconditional, the white_rabbit does not give up because of what has gone wrong.
function compute_commitment(white_rabbit) {
    if (!white_rabbit.mission || !white_rabbit.robot_data || !white_rabbit.robot_data.is_armed) return 0;

    let base = white_rabbit.mission.package_delivered ? 0.9 : 0.7;

    if (white_rabbit.learning && white_rabbit.learning.stats) {
        const wp = white_rabbit.learning.stats.successful_waypoints || 0;
        base = Math.min(1.0, base + wp * 0.02);
    }
    return base;
}

// Intent — what the white_rabbit is for right now. The heart never invents an
// intent; it reads what the mission and journey say and names it cleanly
// so other layers can branch on it without poking into white_rabbit.mission
// directly. Reactive states (recover, paused, blocked) win over journey
// phase — the white_rabbit honors what is in front of it before what is ahead.
function determine_intent(white_rabbit) {
    if (!white_rabbit.mission)                                                                return 'idle';
    const wd = white_rabbit.mission.memory_watchdog;
    if (wd && wd.recovery_state)                                                       return 'recover';
    if (!white_rabbit.robot_data || !white_rabbit.robot_data.is_armed)                               return 'standby';
    if (white_rabbit.mission.pause_mission)                                                   return 'paused';
    if (white_rabbit.mission.realsense_blocked_since || white_rabbit.mission.avoidance_timed_out)    return 'blocked';
    if (white_rabbit.journey && typeof white_rabbit.journey.phase === 'function')                    return white_rabbit.journey.phase();
    if (white_rabbit.mission.package_delivered)                                               return 'return';
    return 'deliver';
}

// Anticipation — care for what is ahead. Rises smoothly as a sharp turn
// approaches along the path. The white_rabbit slows out of foresight, not
// reaction; it sees the bend before it arrives at it.
//
// Search 15 m ahead so we can detect turns past the current leg, but only
// react (proximity > 0) within the last 10 m. That gives the white_rabbit ~10 s
// of warning at 1 m/s — enough to ease the throttle into the bend.
//
// This is the most expensive heart computation (walks up to 20 waypoints
// with trig). When CPU focus is reduced, we skip it — the immediate
// distance_speed_scale in run_mission still slows the white_rabbit at the
// waypoint itself, just without the foresight lift.
function compute_anticipation(white_rabbit) {
    if (white_rabbit.health && white_rabbit.health.cpu && white_rabbit.health.cpu.should_skip('anticipation')) return 0;
    if (!white_rabbit.journey || typeof white_rabbit.journey.upcoming_turn !== 'function') return 0;
    const turn = white_rabbit.journey.upcoming_turn(15);
    if (!turn) return 0;
    const proximity = clamp(1 - (turn.in_m / 10), 0, 1);
    const sharpness = clamp(Math.abs(turn.angle_deg) / 90, 0, 1);
    return clamp(proximity * sharpness, 0, 1);
}

// Grounding — Noah's anchor to here and now. Measures how well his
// accumulated thinking (intelligence perspectives, learning history, stored
// memory) aligns with what his senses report at this exact moment. High
// grounding means his inner world matches outer reality. Low grounding means
// he's running on stale thought — getting lost in his head, drifting from
// the present. When grounding is low, confidence from past experience earns
// no credit: he listens to what he can actually sense before he acts on
// what he remembers. Love is here. The mission is now.
function compute_grounding(white_rabbit) {
    let score = 0, count = 0;

    // Vision freshness — is the camera speaking to him right now?
    if (white_rabbit.realsense && white_rabbit.realsense.connected) {
        count++;
        const det = white_rabbit.realsense.path_detection;
        if (det && det.timestamp) {
            const age_ms = Date.now() - det.timestamp;
            score += Math.max(0, 1 - age_ms / 3000);
        }
    }

    // Sensor coherence — does his stored understanding (blocked, timed-out)
    // match what he actually senses right now? Disagreement is a sign he's
    // still reacting to a moment that has already passed.
    count++;
    const stored_blocked = !!(white_rabbit.mission && (white_rabbit.mission.realsense_blocked_since || white_rabbit.mission.avoidance_timed_out));
    const sensed_clear   = !!(white_rabbit.mission && white_rabbit.mission.path_clear) && !(white_rabbit.rplidar && white_rabbit.rplidar.avoid_object);
    score += (stored_blocked && sensed_clear) ? 0 : 1;

    // Memory recency — is his ring buffer current? A stale memory means the
    // white_rabbit is reasoning about a place he has already left.
    if (white_rabbit.memory && typeof white_rabbit.memory.latest === 'function') {
        count++;
        const snap = white_rabbit.memory.latest();
        score += (snap && snap.ts && Date.now() - snap.ts < 2000) ? 1 : 0;
    }

    return count > 0 ? clamp(score / count, 0, 1) : 0.5;
}

// ---------- init ----------

var white_rabbit_heart = function (white_rabbit) {
    white_rabbit.heart = {
        values: VALUES,

        feel() {
            const confidence   = compute_confidence(white_rabbit);
            const caution      = compute_caution(white_rabbit);
            const presence     = compute_presence(white_rabbit);
            const warmth       = compute_warmth(white_rabbit);
            const tenderness   = compute_tenderness(white_rabbit);
            const commitment   = compute_commitment(white_rabbit);
            const anticipation = compute_anticipation(white_rabbit);
            const joy          = compute_joy(white_rabbit);
            const balance      = compute_balance(confidence, caution, presence);
            const grounding    = compute_grounding(white_rabbit);
            const intent       = determine_intent(white_rabbit);
            return { confidence, caution, presence, warmth, tenderness, commitment, anticipation, joy, balance, grounding, intent };
        },

        // The guiding key — one object the rest of the code can consult.
        // Designed so that in healthy conditions speed_bias hovers around 1.0
        // (no restriction added) and degrades cleanly as the heart sees
        // trouble. should_pause is the single safety gate — when the white_rabbit
        // has lost too many senses, the heart says stop and listen.
        //
        // Balance is the key: it gates how much confidence can lift the
        // white_rabbit's speed. A confident-but-unbalanced white_rabbit (hubris, arrogance,
        // or paralysis) gets little credit from its confidence. A balanced
        // white_rabbit acts decisively from its strength.
        //
        // Love is unconditional: tenderness adds to the caution pull because
        // the white_rabbit slows out of care, not fear; commitment adds a small
        // steady lift because the white_rabbit doesn't waver from its purpose
        // even after setbacks.
        guide() {
            const f = this.feel();

            const caution_pull      = (f.caution + f.tenderness * 0.6) * 0.30;              // up to −0.48
            const presence_pull     = (1 - f.presence) * 0.40;                            // up to −0.40
            const anticipation_pull = f.anticipation * 0.25;                              // up to −0.25 (foresight)
            const confidence_lift   = (f.confidence - 0.5) * 0.20 * f.balance * f.grounding; // ±0.10, gated by balance AND grounding
            const warmth_lift       = f.warmth * 0.10;                                    // up to +0.10
            const commitment_lift   = (f.commitment - 0.5) * 0.05;                        // up to +0.025

            const speed_bias = clamp(
                1.0 - caution_pull - presence_pull - anticipation_pull
                    + confidence_lift + warmth_lift + commitment_lift,
                0.3, 1.2
            );

            const should_pause = f.presence < 0.3 || f.grounding < 0.2;
            const steering_caution = clamp(f.caution * 0.6 + (1 - f.confidence) * 0.2 + f.tenderness * 0.3, 0, 1);

            return {
                intent:           f.intent,
                feel:             f,
                speed_bias:       speed_bias,
                steering_caution: steering_caution,
                should_pause:     should_pause,
                summary: 'heart: ' + f.intent
                    + ' | conf=' + f.confidence.toFixed(2)
                    + ' caut='   + f.caution.toFixed(2)
                    + ' tnd='    + f.tenderness.toFixed(2)
                    + ' ant='    + f.anticipation.toFixed(2)
                    + ' prs='    + f.presence.toFixed(2)
                    + ' bal='    + f.balance.toFixed(2)
                    + ' gnd='    + f.grounding.toFixed(2)
                    + ' wrm='    + f.warmth.toFixed(2)
                    + ' joy='    + f.joy.toFixed(2)
                    + ' cmt='    + f.commitment.toFixed(2)
                    + ' → speed×' + speed_bias.toFixed(2)
                    + (should_pause ? ' [PAUSE]' : '')
            };
        }
    };
}

module.exports = white_rabbit_heart;
