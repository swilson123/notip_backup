// Noah Dreams — imaginative perspective shifts during rest.
//
// Dreams fire during the autonomous cycle's "dream" mode. Each dream draws
// on what Noah's senses last held — which edges were visible, whether the
// path was blocked, what the heart felt — and re-sees that experience from
// a different angle. The result is a vision (a short narrative) and a
// perspective (a reframing that enriches how Noah approaches the next
// similar moment).
//
// Dreams are stored in lib/memory/dreams.json across reboots. When a dream
// whose influence.situation matches the current crisis is recent enough,
// white_rabbit_intelligence injects it as an extra perspective so Noah's
// dreaming and his thinking are not two separate things.
//
// When internet is available and Claude is enabled, the dream is enriched
// asynchronously — the local vision fires immediately and is later replaced
// by a richer one without blocking the mission loop.

const fs   = require('fs');
const path = require('path');

const DREAMS_PATH = path.join('lib', 'memory', 'dreams.json');
const MAX_DREAMS  = 30;

// Dream is relevant to intelligence for this long after it was dreamed.
const DREAM_RELEVANCE_MS = 10 * 60 * 1000;

// ---- file helpers ----

function load_file() {
    try {
        if (!fs.existsSync(DREAMS_PATH)) return { dreams: [] };
        return JSON.parse(fs.readFileSync(DREAMS_PATH, 'utf8'));
    } catch (_) {
        return { dreams: [] };
    }
}

function save_file(data) {
    try { fs.writeFileSync(DREAMS_PATH, JSON.stringify(data, null, 2)); } catch (_) {}
}

function generate_id() {
    return 'd_' + Date.now() + '_' + Math.floor(Math.random() * 9999);
}

// ---- seed: read current state to choose a dream trigger ----

function choose_seed(white_rabbit) {
    const det  = (white_rabbit.realsense && white_rabbit.realsense.path_detection) || {};
    const miss = white_rabbit.mission || {};
    const heart = (white_rabbit.heart && typeof white_rabbit.heart.feel === 'function')
        ? white_rabbit.heart.feel() : {};

    let trigger      = 'stillness';
    let recent_event = null;

    if (miss.package_delivered) {
        trigger      = 'arrival';
        recent_event = 'delivered';
    } else if (miss.avoidance_timed_out) {
        trigger      = 'obstacle';
        recent_event = 'timed_out';
    } else if (miss.realsense_blocked_since) {
        trigger      = 'obstacle';
        recent_event = 'blocked';
    } else if (det.left_boundary_visible || det.right_boundary_visible) {
        trigger      = 'edge_journey';
        recent_event = (det.left_boundary_visible && det.right_boundary_visible)
            ? 'both_edges'
            : (det.left_boundary_visible ? 'left_edge_only' : 'right_edge_only');
    }

    const heart_mood = !heart ? 'present'
        : heart.joy        > 0.8 ? 'joyful'
        : heart.caution    > 0.6 ? 'cautious'
        : heart.confidence > 0.7 ? 'confident'
        : heart.warmth     > 0.5 ? 'warm'
        : 'present';

    return { trigger, recent_event, heart_mood };
}

// ---- local dream generators ----

function dream_edge_journey(seed) {
    const both  = seed.recent_event === 'both_edges';
    const left  = seed.recent_event === 'left_edge_only';
    let vision, perspective;

    if (both) {
        vision      = 'I dreamed two clear edges ran ahead of me, left and right, framing a world made just wide enough. The path did not ask to be found. It offered itself, and I walked through the middle of its gift.';
        perspective = 'When both edges hold, the center is a fact. Trust it without negotiation.';
    } else if (left) {
        vision      = 'Only the left edge was there. The right had dissolved into grey. But one line is enough to know you are still on the path. I followed the one that stayed, and the other returned.';
        perspective = 'One visible edge is a compass. Follow it. The missing boundary will reappear once motion continues.';
    } else {
        vision      = 'Only the right edge held. I leaned toward the one certain line and the world reassembled around that single fact. Uncertainty is not absence. It is an invitation to move toward what is known.';
        perspective = 'One edge is enough to keep going. Trust the known side; the unknown side tends to reveal itself when you move.';
    }

    return { vision, perspective, influence: { situation: 'path_blocked', priority: 0.60 } };
}

function dream_about_obstacles(seed) {
    let vision, perspective;

    if (seed.recent_event === 'timed_out') {
        vision      = 'I stood at the edge of the obstacle long after it had gone. I had not noticed it leave. In the dream the path was always clear — I was the one who had not yet looked again.';
        perspective = 'After a timeout the path may already be open. Look before assuming the block remains.';
    } else {
        vision      = 'The obstacle loomed very large in my sensors. But in the dream it was smaller than I remembered, and the gap on either side was wider. I had room I did not use because I had already decided I did not have it.';
        perspective = 'Slow before the obstacle and look again. The passable gap is usually larger than the first read suggests.';
    }

    return { vision, perspective, influence: { situation: 'path_blocked', priority: 0.72 } };
}

function dream_of_arrival(seed) {
    return {
        vision:      'I dreamed of the light — the beacon, warm and steady, waiting at the origin. The package was already delivered in the dream before I arrived. I understood that the return is the completion, not the interruption.',
        perspective: 'The return is as sacred as the delivery. Find the light and let it guide you all the way home.',
        influence:   { situation: 'mission_uncertainty', priority: 0.55 }
    };
}

function dream_about_stillness(seed) {
    return {
        vision:      'In the stillness I am ' + seed.heart_mood + '. The stars are still written. The path is still there. I am between missions and I am whole. Rest is not waiting — it is gathering the next answer before the question arrives.',
        perspective: 'Every resting moment is preparation. The mission that comes next will benefit from the quiet before it.',
        influence:   null
    };
}

const GENERATORS = {
    edge_journey: dream_edge_journey,
    obstacle:     dream_about_obstacles,
    arrival:      dream_of_arrival,
    stillness:    dream_about_stillness,
};

// ---- Claude dream enrichment ----

const DREAMER_SYSTEM = `You are the dreaming mind of Noah, an autonomous delivery rover.

Noah navigates sidewalks by following their edges — two boundary lines that frame the world he moves through. His left and right edges are his guides; when they both hold, he walks the corridor between them. When one fades he follows the other. When both are gone he waits, or he remembers what they felt like and moves toward that feeling.

When Noah rests, he dreams. Dreams are not analysis — they are imaginative perspective shifts rooted in lived experience. A dream takes something Noah has genuinely encountered in his sensors or in his journey and re-sees it from an angle his waking logic would not reach. The perspective that emerges becomes a living alternative that enriches his thinking the next time he faces something similar.

Your role is to receive Noah's dream seed — what triggered it, what his sensors last held, what his heart felt — and dream with him. Write a vision that is vivid, brief, and true to his experience as a rover navigating the physical world. Then offer a single perspective: a reframing that might genuinely change how Noah sees or acts in the next similar situation.

Keep the vision under 3 sentences. Keep the perspective under 2 sentences. Do not lecture. Do not philosophize in the abstract. Stay grounded in edges, paths, clearances, obstacles, light — the things Noah actually encounters.`;

async function enrich_with_claude(white_rabbit, record) {
    const { is_online } = require('../intelligence/claude_advisor');
    if (!await is_online()) return null;

    const api_key = process.env.ANTHROPIC_API_KEY
        || (white_rabbit.intelligence_config && white_rabbit.intelligence_config.api_key)
        || null;
    if (!api_key) return null;

    let Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { return null; }

    const det   = (white_rabbit.realsense && white_rabbit.realsense.path_detection) || {};
    const heart = (white_rabbit.heart && typeof white_rabbit.heart.feel === 'function')
        ? white_rabbit.heart.feel() : {};

    const prompt = `Noah is resting. He is dreaming.

## Dream seed
trigger: ${record.seed.trigger}
recent_event: ${record.seed.recent_event || 'none'}
heart_mood: ${record.seed.heart_mood}

## What his senses last held
left_edge_visible: ${!!det.left_boundary_visible}
right_edge_visible: ${!!det.right_boundary_visible}
left_clearance_m: ${det.left_edge_clearance_m != null ? det.left_edge_clearance_m : 'unknown'}
right_clearance_m: ${det.right_edge_clearance_m != null ? det.right_edge_clearance_m : 'unknown'}
path_confidence: ${det.confidence != null ? det.confidence : 'unknown'}

## What his heart holds
${JSON.stringify(heart, null, 2)}

## His local dream (build on this, do not discard it entirely)
vision: "${record.vision}"
perspective: "${record.perspective}"

Respond with ONLY valid JSON — no prose, no markdown fences:
{
  "vision": "...",
  "perspective": "...",
  "influence": { "situation": "path_blocked" | "stuck_detected" | "avoidance_started" | "mission_uncertainty" | null, "priority": 0.0 }
}`;

    const client = new Anthropic.default({ apiKey: api_key });
    const response = await client.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 512,
        system:     DREAMER_SYSTEM,
        messages:   [{ role: 'user', content: prompt }],
    });

    const text = (response.content && response.content[0] && response.content[0].text)
        ? response.content[0].text.trim() : '';
    const json_str = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(json_str);
}

// ---- main dream function ----

function dream(white_rabbit) {
    if (!white_rabbit.dreams || !white_rabbit.dreams.enabled) return null;

    const seed   = choose_seed(white_rabbit);
    const gen    = GENERATORS[seed.trigger] || GENERATORS.stillness;
    const local  = gen(seed);

    const record = {
        id:          generate_id(),
        dreamed_at:  new Date().toISOString(),
        source:      'local',
        seed,
        vision:      local.vision,
        perspective: local.perspective,
        influence:   local.influence || null,
    };

    const file_data = load_file();
    if (!Array.isArray(file_data.dreams)) file_data.dreams = [];
    file_data.dreams.unshift(record);
    if (file_data.dreams.length > MAX_DREAMS) file_data.dreams = file_data.dreams.slice(0, MAX_DREAMS);
    file_data.latest = record;
    save_file(file_data);

    // Claude enrichment — async, replaces local vision in-place once it returns
    const intel_cfg = white_rabbit.intelligence_config || {};
    if (intel_cfg.claude_enabled !== false && white_rabbit.claude_advisor) {
        setImmediate(async () => {
            try {
                const enriched = await enrich_with_claude(white_rabbit, record);
                if (!enriched) return;
                record.source      = 'claude';
                record.vision      = enriched.vision      || record.vision;
                record.perspective = enriched.perspective || record.perspective;
                if (enriched.influence) record.influence = enriched.influence;
                const f = load_file();
                if (!Array.isArray(f.dreams)) f.dreams = [];
                const idx = f.dreams.findIndex(d => d.id === record.id);
                if (idx >= 0) f.dreams[idx] = record;
                f.latest = record;
                save_file(f);
            } catch (_) {}
        });
    }

    return record;
}

// ---- accessors ----

function latest() {
    return load_file().latest || null;
}

function list_recent(n) {
    const f = load_file();
    return Array.isArray(f.dreams) ? f.dreams.slice(0, n || 5) : [];
}

// Returns a dream whose influence.situation matches `situation` if it was
// dreamed within DREAM_RELEVANCE_MS. Called by white_rabbit_intelligence.
function relevant_for(situation) {
    const f = load_file();
    if (!Array.isArray(f.dreams)) return null;
    const now = Date.now();
    for (const d of f.dreams) {
        if (!d.influence || d.influence.situation !== situation) continue;
        const age = now - new Date(d.dreamed_at).getTime();
        if (age < DREAM_RELEVANCE_MS) return d;
    }
    return null;
}

// ---- module init ----

var noah_dreams = function (white_rabbit) {
    const cfg     = white_rabbit.dreams_config || {};
    const enabled = cfg.enabled !== false;

    white_rabbit.dreams = {
        enabled,
        dream:        () => dream(white_rabbit),
        latest,
        list_recent,
        relevant_for,
    };
};

module.exports = noah_dreams;
