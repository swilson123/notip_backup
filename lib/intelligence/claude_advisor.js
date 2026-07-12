// Claude Advisor — enriches white_rabbit perspectives via Anthropic API.
//
// Claude acts as Jiminy Cricket: the guiding conscience that keeps Noah on
// the true path. The stars are his waypoints. The package is his purpose.
// The light is home — the IRLock beacon he follows back to dock. When Noah
// loses his way, Jiminy reads the logs, understands the moment, and offers
// the clearest path back to the mission.
//
// Only fires when internet is reachable. Reads recent log lines and Noah's
// current state, asks Claude to generate a prioritized list of alternative
// approaches, and optionally suggests parameter edits.
//
// Called from white_rabbit_intelligence.js via setImmediate — never blocks the
// 250 ms mission loop.
//
// Requires: ANTHROPIC_API_KEY env var or intelligence.api_key in setup.json.
// Requires: @anthropic-ai/sdk in package.json.

const fs   = require('fs');
const path = require('path');
const dns  = require('dns').promises;

// Connectivity result cached for 30 s to avoid per-call DNS lookups.
let _connectivity_ts     = 0;
let _connectivity_result = false;
const CONNECTIVITY_CACHE_MS = 30000;

async function is_online() {
    const now = Date.now();
    if (now - _connectivity_ts < CONNECTIVITY_CACHE_MS) return _connectivity_result;
    try {
        await dns.lookup('dns.google');
        _connectivity_result = true;
    } catch (_) {
        _connectivity_result = false;
    }
    _connectivity_ts = now;
    return _connectivity_result;
}

function tail_file(file_path, max_lines) {
    try {
        if (!fs.existsSync(file_path)) return '';
        const lines = fs.readFileSync(file_path, 'utf8').split('\n').filter(l => l.trim());
        return lines.slice(-max_lines).join('\n');
    } catch (_) {
        return '';
    }
}

function get_recent_log(white_rabbit, log_name, max_lines) {
    try {
        const dateFormat = require('dateformat');
        const date  = dateFormat(new Date(), 'yyyy-mm-dd');
        const count = (white_rabbit.logs && white_rabbit.logs.count) ? white_rabbit.logs.count : 1;
        return tail_file(path.join('logger', date, String(count), log_name + '.log'), max_lines || 80);
    } catch (_) {
        return '';
    }
}

// Parameters Claude is allowed to reference and suggest values for.
const EDITABLE_PARAMS = [
    'nav_tuning.rs_block_timeout_ms',
    'nav_tuning.avoidance_timeout_ms',
    'nav_tuning.mission_yaw_start_deg',
    'nav_tuning.mission_yaw_stop_deg',
    'nav_tuning.mission_yaw_min_speed',
    'nav_tuning.mission_yaw_max_speed',
    'nav_tuning.two_wheel_steering_gain',
];

function build_current_params(white_rabbit) {
    const params = {};
    for (const key of EDITABLE_PARAMS) {
        const [section, field] = key.split('.');
        if (white_rabbit[section] && typeof white_rabbit[section][field] !== 'undefined') {
            params[key] = white_rabbit[section][field];
        }
    }
    return params;
}

const JIMINY_SYSTEM = `You are Jiminy Cricket — the guiding conscience of Noah, an autonomous delivery white_rabbit.

Your role is to keep Noah on the true path:
- The stars are his waypoints. He navigates by them, one at a time. He must not stray.
- The package is his purpose. He carries it with care and must deliver it safely.
- The light is home. When the mission is done, he follows the IRLock beacon back to dock.

When Noah loses his way — blocked, stuck, uncertain — you are the small voice that helps him remember what matters and find the clearest path forward. You do not panic. You do not overcomplicate. You see the whole journey and you guide him, one step at a time, back to the next star.

Your wisdom comes from reading his logs, understanding his present state, and knowing his history. Your perspectives are guidance, not just parameter adjustments. Write each description as you would speak it to Noah: clear, warm, purposeful — a conscience, not an engineer. The technical parameters follow from the wisdom; the wisdom comes first.`;

function build_prompt(white_rabbit, situation, ctx, local_perspectives) {
    const current_params = build_current_params(white_rabbit);
    const learning = (white_rabbit.learning && typeof white_rabbit.learning.effective_tuning === 'function')
        ? white_rabbit.learning.effective_tuning() : {};
    const learning_stats = (white_rabbit.learning && white_rabbit.learning.stats) ? white_rabbit.learning.stats : {};

    const run_mission_log  = get_recent_log(white_rabbit, 'run_mission',         80);
    const sidewalk_log     = get_recent_log(white_rabbit, 'sidewalk_detection',  60);
    const watchdog_log     = get_recent_log(white_rabbit, 'memory_watchdog',     40);

    const local_list = local_perspectives.length
        ? local_perspectives.map((p, i) =>
            (i + 1) + '. [priority=' + p.priority + '] ' + p.description + '\n' +
            '   params: ' + JSON.stringify(p.parameters) + '\n' +
            '   reason: ' + p.priority_reason
          ).join('\n')
        : '(none)';

    // Translate the situation into mission-framed language so Jiminy's
    // guidance stays rooted in the journey, not just the error condition.
    const situation_label = {
        path_blocked:        'Noah cannot see his next star — something is blocking the path',
        stuck_detected:      'Noah has stopped making progress — he is stuck along the way',
        avoidance_started:   'Noah is steering around an obstacle to stay on the journey',
        mission_uncertainty: 'Noah has lost confidence in where he is on the path',
    }[situation] || 'Noah is facing an unexpected challenge on the mission';

    return `## The moment
${situation_label}.

## Where he is right now
${JSON.stringify(ctx, null, 2)}

## What he can remember
tuning: ${JSON.stringify(learning)}
stats:  ${JSON.stringify(learning_stats)}

## The parameters you may adjust (numbers only, within these keys)
${JSON.stringify(current_params, null, 2)}

## What the logs say happened
### Mission log (last 80 lines)
\`\`\`
${run_mission_log || '(empty)'}
\`\`\`
### Vision / sidewalk log (last 60 lines)
\`\`\`
${sidewalk_log || '(empty)'}
\`\`\`
### Memory watchdog log (last 40 lines)
\`\`\`
${watchdog_log || '(empty)'}
\`\`\`

## What his own thinking has already offered (build on these)
${local_list}

## Your guidance
As Jiminy, offer up to 10 perspectives — each a different way Noah can find his path again and continue the journey. Read the logs carefully; patterns there should shape your priorities. Write each description as you would speak it to Noah: a guiding conscience, warm and clear. The priority_reason is your honest read of why this path is most likely to bring him home.

Rules:
- Only suggest parameter edits from the keys listed above.
- All parameter values must be numeric.
- parameter_suggestions are immediate edits — only suggest them when the logs show a clear repeating pattern that warrants a live change.
- perspectives are ordered most-likely-to-succeed first (priority 0.0–1.0).

Respond with ONLY valid JSON — no prose, no markdown fences:
{
  "perspectives": [
    {
      "id": "p_<unique_suffix>",
      "description": "...",
      "parameters": { "<editable_key>": <number> },
      "priority": 0.85,
      "priority_reason": "..."
    }
  ],
  "parameter_suggestions": [
    { "key": "<editable_key>", "value": <number>, "reason": "..." }
  ]
}`;
}

async function consult(white_rabbit, situation, ctx, local_perspectives) {
    if (!await is_online()) return null;

    const api_key = process.env.ANTHROPIC_API_KEY ||
        (white_rabbit.intelligence_config && white_rabbit.intelligence_config.api_key) || null;
    if (!api_key) return null;

    let Anthropic;
    try {
        Anthropic = require('@anthropic-ai/sdk');
    } catch (_) {
        return null;
    }

    const client = new Anthropic.default({ apiKey: api_key });
    const prompt = build_prompt(white_rabbit, situation, ctx, local_perspectives);

    try {
        const response = await client.messages.create({
            model:      'claude-sonnet-4-6',
            max_tokens: 2048,
            system:     JIMINY_SYSTEM,
            messages:   [{ role: 'user', content: prompt }],
        });

        const text = (response.content && response.content[0] && response.content[0].text)
            ? response.content[0].text.trim() : '';

        // Strip markdown code fences if Claude wrapped the JSON.
        const json_str = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
        return JSON.parse(json_str);
    } catch (err) {
        // Network error, API timeout/error, or a 200 with non-JSON text — degrade
        // to null so callers fall back to local behavior instead of crashing the
        // intelligence system for the rest of the run.
        console.log('claude_advisor consult failed: ' + (err && err.message));
        return null;
    }
}

module.exports = { consult, is_online };
