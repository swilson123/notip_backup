// LCD 1 (0x27): full-screen animated mouth — a single bold smile or frown
//               (all-systems-good face), or a growing/shrinking oval that mimics
//               talking while Noah speaks over the EMEET.
// LCD 2 (0x26): device connection status + battery voltage + GPS satellite count.
// LCD 3 (0x25): RealSense vision — sidewalk, object, avoid status.

const COLS = 20;
const ROWS = 4;

function pad(str, len) {
    return String(str).slice(0, len).padEnd(len);
}

// Stroke thickness of the mouth, in pixels. The mouth renders as a single bold
// curve (no separate upper/lower lip), so the stroke is drawn thicker than the
// old 2px line.
const STROKE_PX = 3;

// CGRAM atlas of 8 custom chars: each char is a STROKE_PX-thick horizontal stroke
// centered on vertical position 0..7 within its 5x8 cell. By choosing a different
// char for each column we draw any curve across the 20x4 panel.
const MOUTH_ATLAS = (() => {
    const chars = [];
    const half = Math.floor((STROKE_PX - 1) / 2);
    for (let line = 0; line < 8; line++) {
        const rows = new Array(8).fill(0);
        for (let d = 0; d < STROKE_PX; d++) {
            const y = line + d - half;          // center the stroke on `line`
            if (y >= 0 && y < 8) rows[y] = 0b11111;
        }
        chars.push(rows);
    }
    return chars;
})();

// Quadratic mouth curve across 20 cells, plus tilt (smirk) and a slow wobble
// for personality. 'smile' arches downward (corners up), 'frown' arches upward
// (corners down). Returns a 4-row × 20-col grid where each entry is a CGRAM
// char index (0..7) or null for a blank cell.
//
// Animation cycle (one entry per tick, ~500ms per tick):
//   0: calm balanced
//   1: smirk right (right corner lifts, left drops)
//   2: full grin / deep frown
//   3: smirk left (mirror of 1)
// Plus a per-column sine wobble whose phase advances every tick so the mouth
// quivers like it's breathing.
const SMILE_FRAMES = [
    { amp: 0.78, tilt:  0.0 },
    { amp: 0.85, tilt: +2.0 },
    { amp: 1.00, tilt:  0.0 },
    { amp: 0.85, tilt: -2.0 }
];
const FROWN_FRAMES = [
    { amp: 0.80, tilt:  0.0 },
    { amp: 0.85, tilt: +1.4 },
    { amp: 1.00, tilt:  0.0 },
    { amp: 0.85, tilt: -1.4 }
];

function blank_grid() {
    return [
        new Array(COLS).fill(null),
        new Array(COLS).fill(null),
        new Array(COLS).fill(null),
        new Array(COLS).fill(null)
    ];
}

// Map a vertical pixel position (0..31 down the 4 rows) to the CGRAM char that
// draws the stroke there, and record it in the grid. First write wins, so a top
// edge is never clobbered by a bottom edge that lands in the same cell.
function place_stroke(grid, c, y) {
    const yi   = Math.round(y);
    const row  = Math.min(ROWS - 1, Math.max(0, Math.floor(yi / 8)));
    const line = Math.min(7,        Math.max(0, yi - row * 8));
    if (grid[row][c] == null) grid[row][c] = line;
}

function compute_mouth_grid(shape, tick) {
    const frames = shape === 'smile' ? SMILE_FRAMES : FROWN_FRAMES;
    const { amp, tilt } = frames[tick % frames.length];

    const grid = blank_grid();

    // The whole mouth is one bold arc, drawn STROKE_PX thick: 'smile' is a U
    // (corners up), 'frown' is a ∩ (corners down). There is no separate second
    // lip — the single heavy stroke is the smile/frown.
    const Y_EDGE = 8;     // y at the panel edges (the mouth corners)
    const Y_DEEP = 29;    // y at the panel center (deepest point of the arc)
    const reach  = Y_DEEP - Y_EDGE;

    for (let c = 0; c < COLS; c++) {
        const u = (c + 0.5 - COLS / 2) / (COLS / 2);  // -1..1 across the panel
        const depth = amp * (1 - u * u);              // 0 at edges, amp at center
        const wobble = 0.7 * Math.sin(c * 0.7 + tick * 1.1);

        let y = shape === 'smile'
            ? Y_EDGE + depth * reach
            : Y_DEEP - depth * reach;
        y -= shape === 'smile' ? tilt * u : -tilt * u;
        y += wobble;

        place_stroke(grid, c, y);
    }
    return grid;
}

// Talking mouth: a horizontal oval whose vertical opening grows and shrinks each
// tick so it looks like the mouth moving while Noah speaks over the EMEET. The
// oval is an ellipse (top arc + bottom arc) with rounded ends; when nearly closed
// it collapses to a single flat line.
const TALK_A_CELLS  = 9;      // horizontal half-width of the oval, in columns (~90% of panel)
const TALK_Y_CENTER = 15.5;   // vertical center of the panel, in pixels (0..31)
const TALK_FRAMES   = [2, 5, 8, 9, 6, 3];   // vertical half-opening (px) per tick

function compute_talk_grid(tick) {
    const grid = blank_grid();
    const b = TALK_FRAMES[tick % TALK_FRAMES.length];
    for (let c = 0; c < COLS; c++) {
        const x = (c + 0.5 - COLS / 2) / TALK_A_CELLS;   // -1..1 inside the oval
        if (Math.abs(x) > 1) continue;                   // rounded ends → blank outside
        const half = b * Math.sqrt(1 - x * x);
        if (half < 1.2) {
            place_stroke(grid, c, TALK_Y_CENTER);         // nearly closed → one line
        } else {
            place_stroke(grid, c, TALK_Y_CENTER - half);  // top arc
            place_stroke(grid, c, TALK_Y_CENTER + half);  // bottom arc
        }
    }
    return grid;
}

async function draw_mouth(screen, shape, tick, speaking) {
    if (!screen.atlas_loaded) {
        await screen.instance.loadCgram(MOUTH_ATLAS);
        screen.atlas_loaded = true;
    }
    const grid = speaking ? compute_talk_grid(tick) : compute_mouth_grid(shape, tick);
    for (let r = 0; r < ROWS; r++) {
        await screen.instance.setCursor(0, r);
        const row = grid[r];
        const codes = new Array(COLS);
        for (let c = 0; c < COLS; c++) {
            codes[c] = row[c] == null ? 0x20 : row[c];
        }
        await screen.instance.writeChars(codes);
    }
}

function all_systems_good(white_rabbit) {
    const wave_ok = white_rabbit.zling.comName1_connected && white_rabbit.zling.comName2_connected;
    return white_rabbit.rplidar.connected
        && white_rabbit.pixhawk_port.connected
        && wave_ok
        && white_rabbit.arduino.connected
        && white_rabbit.realsense.connected
        && white_rabbit.imu_data.connected
        && white_rabbit.irlock.connected;
}

function ok_str(connected) { return connected ? 'OK' : '--'; }

function battery_voltage_v(white_rabbit) {
    const mv = white_rabbit.robot_data.SYS_STATUS && white_rabbit.robot_data.SYS_STATUS.voltage_battery;
    if (typeof mv !== 'number' || mv === 65535 || mv === 0) return null;
    return mv / 1000;
}

function sats_visible(white_rabbit) {
    const n = white_rabbit.robot_data.GPS_RAW_INT && white_rabbit.robot_data.GPS_RAW_INT.satellites_visible;
    // 255 is the mavlink sentinel for "unknown".
    if (typeof n !== 'number' || n === 255) return null;
    return n;
}

function heading_deg(white_rabbit) {
    if (white_rabbit.imu_data && white_rabbit.imu_data.connected && typeof white_rabbit.imu_data.heading === 'number') {
        return white_rabbit.imu_data.heading;
    }
    const h = white_rabbit.robot_data.VFR_HUD && white_rabbit.robot_data.VFR_HUD.heading;
    return typeof h === 'number' ? h : null;
}

async function draw_status(screen, white_rabbit) {
    const lcd = screen.instance;
    const wave_ok = white_rabbit.zling.comName1_connected && white_rabbit.zling.comName2_connected;

    const v = battery_voltage_v(white_rabbit);
    const v_str = v != null ? v.toFixed(1).padStart(4, ' ') + 'V' : '--.-V';
    const s = sats_visible(white_rabbit);
    const s_str = s != null ? String(s).padStart(2, ' ') : '--';
    const h = heading_deg(white_rabbit);
    const h_str = h != null ? String(Math.round(h) % 360).padStart(3, ' ') : '---';

    // IRLock connected: 1 = yes, 0 = no
    const irl_conn = (white_rabbit.irlock && white_rabbit.irlock.connected) ? '1' : '0';

    const lines = [
        `LIDAR :${ok_str(white_rabbit.rplidar.connected)}  PIX:${ok_str(white_rabbit.pixhawk_port.connected)}`,
        `WAVE  :${ok_str(wave_ok)}  ARD:${ok_str(white_rabbit.arduino.connected)}`,
        `RS:${ok_str(white_rabbit.realsense.connected)}  IMU:${ok_str(white_rabbit.imu_data.connected)} IRL:${irl_conn}`,
        `BAT:${v_str} S:${s_str} H:${h_str}`
    ];

    for (let r = 0; r < ROWS; r++) {
        await lcd.setCursor(0, r);
        await lcd.writeString(pad(lines[r], COLS));
    }
}

async function draw_realsense(screen, white_rabbit) {
    const lcd = screen.instance;
    const vision = (white_rabbit.realsense && white_rabbit.realsense.vision) || {};
    const det = (white_rabbit.realsense && white_rabbit.realsense.path_detection) || {};

    const conf_threshold = typeof vision.confidence_threshold === 'number' ? vision.confidence_threshold : 0.6;
    const stale_ms = typeof vision.stale_detection_ms === 'number' ? vision.stale_detection_ms : 1200;
    const fresh = det.timestamp && (Date.now() - det.timestamp) < stale_ms;
    const sidewalk_detected = !!(fresh && typeof det.confidence === 'number' && det.confidence >= conf_threshold);
    const conf_str = typeof det.confidence === 'number'
        ? det.confidence.toFixed(2)
        : '----';

    // LiDAR front-arc status: worst-of-two rollup across zones 11 and 12.
    const front_status = (() => {
        if (!Array.isArray(white_rabbit.zones)) return 'G';
        const now = Date.now();
        let any_red = false, any_yellow = false;
        for (const z of white_rabbit.zones) {
            if (z.zone !== 11 && z.zone !== 12) continue;
            if (!z.timestamp || (now - z.timestamp) > 1500) continue;
            if (z.light === 'red') any_red = true;
            else if (z.light === 'yellow') any_yellow = true;
        }
        return any_red ? 'R' : any_yellow ? 'Y' : 'G';
    })();

    // RealSense vision front-arc status: worst-of-two rollup across vision zones 11 and 12.
    const vision_status = (() => {
        const vz = white_rabbit.realsense && white_rabbit.realsense.vision_zones;
        if (!vz) return 'G';
        const det = (white_rabbit.realsense && white_rabbit.realsense.path_detection) || {};
        const vision = (white_rabbit.realsense && white_rabbit.realsense.vision) || {};
        const stale_ms = typeof vision.stale_detection_ms === 'number' ? vision.stale_detection_ms : 1200;
        if (!det.timestamp || (Date.now() - det.timestamp) >= stale_ms) return 'G';
        let any_red = false, any_yellow = false;
        for (const z of [11, 12, 1]) {
            const zone = vz[z];
            if (!zone) continue;
            if (zone.light === 'red') any_red = true;
            else if (zone.light === 'yellow') any_yellow = true;
        }
        return any_red ? 'R' : any_yellow ? 'Y' : 'G';
    })();

    let avoid_str;
    if (white_rabbit.mission && white_rabbit.mission.avoidance_timed_out) avoid_str = 'TMO';
    else if (white_rabbit.mission && white_rabbit.mission.path_clear === false) avoid_str = 'BLK';
    else avoid_str = 'CLR';

    // Sidewalk X-axis angle — the one signal steering acts on.
    //   + = sidewalk center to the right (steer right), - = left, ~0 = centered.
    const ang = (fresh && typeof det.x_angle_deg === 'number') ? det.x_angle_deg : null;
    const ang_str = ang === null ? '----' : (ang >= 0 ? '+' : '') + ang.toFixed(1);
    const ang_dir = ang === null ? '' : (ang > 1 ? 'R' : ang < -1 ? 'L' : 'C');

    const sw_flag = sidewalk_detected ? 'Y' : 'N';

    // IRLock sees light: 1 = beacon detected and fresh, 0 = no beacon
    const irl_light = (white_rabbit.irlock && white_rabbit.irlock.detected
        && white_rabbit.irlock_message_handler && white_rabbit.irlock_message_handler.is_fresh(white_rabbit))
        ? '1' : '0';

    const lines = [
        `SW:${sw_flag} c=${conf_str} AV:${avoid_str}`,
        `OBJ LIDAR:  ${front_status} IRL:${irl_light}`,
        `OBJ VISION: ${vision_status}`,
        `SW ANGLE:${ang_str} ${ang_dir}`
    ];

    for (let r = 0; r < ROWS; r++) {
        await lcd.setCursor(0, r);
        await lcd.writeString(pad(lines[r], COLS));
    }
}

var write_to_lcd = async function (white_rabbit) {
    white_rabbit.lcd_screens.tick = (white_rabbit.lcd_screens.tick || 0) + 1;
    const tick = white_rabbit.lcd_screens.tick;

    // LCD 1 — animate every tick (~500ms).
    if (white_rabbit.lcd_screens.screen1.connected) {
        try {
            const shape = all_systems_good(white_rabbit) ? 'smile' : 'frown';
            const speaking = !!(white_rabbit.voice && white_rabbit.voice.tts
                && typeof white_rabbit.voice.tts.is_speaking === 'function'
                && white_rabbit.voice.tts.is_speaking());
            await draw_mouth(white_rabbit.lcd_screens.screen1, shape, tick, speaking);
        } catch (err) {
            white_rabbit.lcd_screens.screen1.connected = false;
            console.log(`LCD screen1 write failed: ${err.message}`);
        }
    }

    // LCDs 2 and 3 — refresh every other tick (~1Hz) to keep the i2c loop light.
    const refresh_status = (tick % 2) === 0;

    if (refresh_status && white_rabbit.lcd_screens.screen2.connected) {
        try {
            await draw_status(white_rabbit.lcd_screens.screen2, white_rabbit);
        } catch (err) {
            white_rabbit.lcd_screens.screen2.connected = false;
            console.log(`LCD screen2 write failed: ${err.message}`);
        }
    }

    if (refresh_status && white_rabbit.lcd_screens.screen3.connected) {
        try {
            await draw_realsense(white_rabbit.lcd_screens.screen3, white_rabbit);
        } catch (err) {
            white_rabbit.lcd_screens.screen3.connected = false;
            console.log(`LCD screen3 write failed: ${err.message}`);
        }
    }
};

module.exports = write_to_lcd;
