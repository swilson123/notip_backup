// Claude Advisor — enriches rover perspectives via Anthropic API.
//
// Only fires when internet is reachable. Reads recent log lines and Noah's
// current state, asks Claude to generate a prioritized list of alternative
// approaches, and optionally suggests parameter edits.
//
// Called from rover_intelligence.js via setImmediate — never blocks the
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

function get_recent_log(rover, log_name, max_lines) {
    try {
        const dateFormat = require('dateformat');
        const date  = dateFormat(new Date(), 'yyyy-mm-dd');
        const count = (rover.logs && rover.logs.count) ? rover.logs.count : 1;
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
    'realsense_vision.confidence_threshold',
    'realsense_vision.object_emergency_stop_m',
    'realsense_vision.path_center_deadband_m',
    'realsense_vision.carrot_distance_m',
    'realsense_vision.speed_scale_min',
];

function build_current_params(rover) {
    const params = {};
    for (const key of EDITABLE_PARAMS) {
        const [section, field] = key.split('.');
        if (rover[section] && typeof rover[section][field] !== 'undefined') {
            params[key] = rover[section][field];
        }
    }
    return params;
}

function build_prompt(rover, situation, ctx, local_perspectives) {
    const current_params = build_current_params(rover);
    const learning = (rover.learning && typeof rover.learning.effective_tuning === 'function')
        ? rover.learning.effective_tuning() : {};
    const learning_stats = (rover.learning && rover.learning.stats) ? rover.learning.stats : {};

    const run_mission_log  = get_recent_log(rover, 'run_mission',         80);
    const sidewalk_log     = get_recent_log(rover, 'sidewalk_detection',  60);
    const watchdog_log     = get_recent_log(rover, 'memory_watchdog',     40);

    const local_list = local_perspectives.length
        ? local_perspectives.map((p, i) =>
            (i + 1) + '. [priority=' + p.priority + '] ' + p.description + '\n' +
            '   params: ' + JSON.stringify(p.parameters) + '\n' +
            '   reason: ' + p.priority_reason
          ).join('\n')
        : '(none)';

    return `You are the intelligence advisor for Noah, an autonomous delivery rover (Raspberry Pi 5, Pixhawk, Intel RealSense, RPLiDAR).

## Current situation
Noah is facing: **${situation}**

## Live context snapshot
${JSON.stringify(ctx, null, 2)}

## Current tunable parameters (the only ones you may suggest edits for)
${JSON.stringify(current_params, null, 2)}

## Learning state
tuning: ${JSON.stringify(learning)}
stats:  ${JSON.stringify(learning_stats)}

## Recent mission log (last 80 lines)
\`\`\`
${run_mission_log || '(empty)'}
\`\`\`

## Recent sidewalk/vision log (last 60 lines)
\`\`\`
${sidewalk_log || '(empty)'}
\`\`\`

## Memory watchdog log (last 40 lines)
\`\`\`
${watchdog_log || '(empty)'}
\`\`\`

## Locally generated perspectives (your starting point — improve and extend these)
${local_list}

## Your task
Intelligence is seeing a situation from multiple perspectives. Generate up to 10 distinct perspectives — each a different way Noah could successfully handle this situation. Consider the log history carefully: patterns in the logs should shape your priorities.

Rules:
- Only suggest parameter edits from the editable parameter list above.
- All suggested parameter values must be numeric.
- parameter_suggestions are edits to apply immediately because the logs show a clear repeating pattern.
- perspectives are approaches to try in order of most-likely-to-succeed.
- Priority scores are 0.0–1.0 (higher = more likely to succeed).

Respond with ONLY a valid JSON object — no prose, no markdown fences:
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

async function consult(rover, situation, ctx, local_perspectives) {
    if (!await is_online()) return null;

    const api_key = process.env.ANTHROPIC_API_KEY ||
        (rover.intelligence_config && rover.intelligence_config.api_key) || null;
    if (!api_key) return null;

    let Anthropic;
    try {
        Anthropic = require('@anthropic-ai/sdk');
    } catch (_) {
        return null;
    }

    const client = new Anthropic.default({ apiKey: api_key });
    const prompt = build_prompt(rover, situation, ctx, local_perspectives);

    const response = await client.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 2048,
        messages:   [{ role: 'user', content: prompt }],
    });

    const text = (response.content && response.content[0] && response.content[0].text)
        ? response.content[0].text.trim() : '';

    // Strip markdown code fences if Claude wrapped the JSON.
    const json_str = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(json_str);
}

module.exports = { consult, is_online };
