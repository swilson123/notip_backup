// Voice command intent parser.
//
// parse_command(text) → { intent, payload, urgent } | null
//
// Text is the utterance AFTER the wake word is stripped.
// All pattern matching is case-insensitive on normalised text.

const DISTANCE_RE = /(\d+\.?\d*)\s*(foot|feet|ft|inch|inches|in|meter|meters|m)\b/i;
const ANGLE_RE    = /(\d+\.?\d*)\s*(deg|degs|degree|degrees)\b/i;

// Vosk ASR transcribes numbers as words ("three feet"), not digits. Convert
// spelled-out numbers to digits in-place so the regexes match.
const ONES = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
               ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15,
               sixteen:16, seventeen:17, eighteen:18, nineteen:19 };
const TENS = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };

function normalize_numbers(text) {
    // Walk left→right collapsing runs of number words into a single digit
    // expression. Handles up to "three hundred sixty" (covers 360° spins).
    const tokens = text.split(/\s+/);
    const out = [];
    let i = 0;
    while (i < tokens.length) {
        let total = 0, consumed = 0, segment = 0;
        while (i + consumed < tokens.length) {
            const w = tokens[i + consumed].replace(/[^a-z]/g, '');
            if (w in ONES)       { segment += ONES[w]; consumed++; }
            else if (w in TENS)  { segment += TENS[w]; consumed++; }
            else if (w === 'hundred') { segment = (segment || 1) * 100; consumed++; }
            else if (w === 'and' && consumed > 0) { consumed++; }   // "one hundred and twenty"
            else break;
        }
        if (consumed > 0) {
            total = segment;
            out.push(String(total));
            i += consumed;
        } else {
            out.push(tokens[i]);
            i++;
        }
    }
    return out.join(' ');
}

function parse_distance(text) {
    const m = normalize_numbers(text).match(DISTANCE_RE);
    if (!m) return { value: 1, unit: 'foot', meters: 0.3048 };
    const val  = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    let meters;
    if      (unit.startsWith('m')) meters = val;
    else if (unit.startsWith('f')) meters = val * 0.3048;
    else                           meters = val * 0.0254;   // inches
    return { value: val, unit, meters: Math.round(meters * 1000) / 1000 };
}

function parse_angle(text) {
    const m = normalize_numbers(text).match(ANGLE_RE);
    if (!m) return { degrees: null };
    return { degrees: parseFloat(m[1]) };
}

// "set compass [to] 360 [degrees]" — the declared heading. Accept a bare number
// (no "degrees" word) since the operator often just says the number.
const HEADING_RE = /(\d+\.?\d*)/;
function parse_heading(text) {
    const norm = normalize_numbers(text);
    const m = norm.match(ANGLE_RE) || norm.match(HEADING_RE);
    if (!m) return { degrees: null };
    return { degrees: parseFloat(m[1]) };
}

// Each entry: { patterns, intent, urgent?, parse? }
// patterns: array of strings (substring match) or RegExp
const COMMANDS = [
    // Feedback
    { patterns: ['good boy', 'correct', 'well done', 'nice work', 'good job'],               intent: 'good_boy' },
    { patterns: ['bad boy', 'wrong', 'incorrect', 'that was wrong', 'no no'],                intent: 'bad_boy' },

    // Motion — spin commands listed BEFORE move so "spin left" matches
    // spin_left, not move_left (the bare "left" alternation in move_left
    // would otherwise win on substring).
    { patterns: [/spin\s+left|rotate\s+left/],                                               intent: 'spin_left',  parse: parse_angle },
    { patterns: [/spin\s+right|rotate\s+right/],                                             intent: 'spin_right', parse: parse_angle },
    { patterns: [/move\s+left|go\s+left|left/],                                              intent: 'move_left',    parse: parse_distance },
    { patterns: [/move\s+right|go\s+right|right/],                                           intent: 'move_right',   parse: parse_distance },
    { patterns: [/go\s+forward|move\s+forward|forward|advance/],                             intent: 'move_forward', parse: parse_distance },
    { patterns: [/back\s*up|reverse|go\s+back|move\s+back|back/],                           intent: 'move_back',    parse: parse_distance },

    // Mission control — stop/abort listed before resume so 'stop' wins over 'go'
    { patterns: ['stop', 'halt', 'freeze', 'emergency stop', 'emergency'],                   intent: 'stop',          urgent: true },
    { patterns: ['abort', 'abort mission', 'cancel'],                                        intent: 'abort',         urgent: true },
    { patterns: ['resume', 'continue', 'move out', 'carry on'],                             intent: 'resume' },
    { patterns: ['return home', 'go home', 'come home', 'rtl', 'return'],                   intent: 'return_home' },
    { patterns: ['deliver', 'drop package', 'deploy package', 'drop it', 'deploy'],         intent: 'deliver' },

    // Diagnostics
    { patterns: [/status|what.*doing|how.*doing/],                                           intent: 'status' },
    { patterns: [/where.*you|your\s+location|gps|coordinates|location/],                    intent: 'location' },
    { patterns: [/what.*wrong|fault|are you stuck|stuck/],                                  intent: 'fault_report' },
    { patterns: [/battery|power\s+level|charge/],                                           intent: 'battery' },
    { patterns: ['scan', 'check surroundings', 'look around', 'survey'],                    intent: 'scan' },
    // Compass — declare the current true heading. Listed before 'calibrate'.
    { patterns: [/set\s+(the\s+)?compass|compass\s+(to|is)/],                                intent: 'set_compass', parse: parse_heading },
    { patterns: ['calibrate', 'recalibrate', 're calibrate'],                               intent: 'calibrate' },
    { patterns: [/mission\s+status|what.*mission|waypoint/],                                intent: 'mission_status' },
    { patterns: ['help', 'help me', 'need help', 'i need help'],                           intent: 'help_request' },

    // Speed
    { patterns: ['speed up', 'faster', 'go faster', 'increase speed'],                      intent: 'speed_up' },
    { patterns: ['slow down', 'slower', 'go slower', 'decrease speed'],                     intent: 'slow_down' },

    // Volume
    { patterns: ['louder', 'volume up', 'speak up'],                                         intent: 'volume_up' },
    { patterns: ['quieter', 'quiet', 'volume down', 'too loud'],                             intent: 'volume_down' },

    // Easter egg — must be last since 'speak' is also a substring of 'speak up'
    { patterns: [/^speak$/],                                                                  intent: 'speak' },
];

function parse_command(text) {
    if (!text) return null;
    const norm = text.toLowerCase().trim();
    for (const cmd of COMMANDS) {
        for (const p of cmd.patterns) {
            const matched = (typeof p === 'string') ? norm.includes(p) : p.test(norm);
            if (matched) {
                const payload = cmd.parse ? cmd.parse(norm) : {};
                return { intent: cmd.intent, payload: payload || {}, urgent: !!cmd.urgent };
            }
        }
    }
    return null;
}

module.exports = { parse_command, COMMANDS };
