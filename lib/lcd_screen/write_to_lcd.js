// LCD 1 (0x27): full-screen animated smile or frown mouth (all-systems-good face).
// LCD 2 (0x26): device connection status + battery voltage + GPS satellite count.
// LCD 3 (0x25): RealSense vision — sidewalk, object, avoid status.

const COLS = 20;
const ROWS = 4;

function pad(str, len) {
    return String(str).slice(0, len).padEnd(len);
}

// CGRAM atlas of 8 custom chars: each char is a 2-pixel-thick horizontal stroke
// sitting at vertical position 0..7 within its 5x8 cell. By choosing a different
// char for each column we draw any curve across the 20x4 panel.
const MOUTH_ATLAS = (() => {
    const chars = [];
    for (let line = 0; line < 8; line++) {
        const rows = new Array(8).fill(0);
        rows[line] = 0b11111;
        const second = line < 7 ? line + 1 : line - 1;
        rows[second] |= 0b11111;
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

function compute_mouth_grid(shape, tick) {
    const frames = shape === 'smile' ? SMILE_FRAMES : FROWN_FRAMES;
    const { amp, tilt } = frames[tick % frames.length];

    const grid = [
        new Array(COLS).fill(null),
        new Array(COLS).fill(null),
        new Array(COLS).fill(null),
        new Array(COLS).fill(null)
    ];
    // Lower lip: the dominant arc filling rows 1-3. Upper lip: a shallow arc
    // confined to row 0 that mirrors the lower lip's shape, giving the mouth
    // two visible strokes with a gap (open-mouth grin).
    const Y_LOWER_EDGE = 8;
    const Y_LOWER_DEEP = 29;
    const Y_UPPER_EDGE = 2;
    const Y_UPPER_DEEP = 7;
    const reach_lower  = Y_LOWER_DEEP - Y_LOWER_EDGE;
    const reach_upper  = Y_UPPER_DEEP - Y_UPPER_EDGE;
    const tilt_scale_upper = reach_upper / reach_lower;

    for (let c = 0; c < COLS; c++) {
        const u = (c + 0.5 - COLS / 2) / (COLS / 2);  // -1..1 across the panel
        const depth = amp * (1 - u * u);              // 0 at edges, amp at center
        const tilt_y_lower = tilt * u;
        const wobble = 0.7 * Math.sin(c * 0.7 + tick * 1.1);

        let y_lower = shape === 'smile'
            ? Y_LOWER_EDGE + depth * reach_lower
            : Y_LOWER_DEEP - depth * reach_lower;
        y_lower -= shape === 'smile' ? tilt_y_lower : -tilt_y_lower;
        y_lower += wobble;

        let y_upper = shape === 'smile'
            ? Y_UPPER_EDGE + depth * reach_upper
            : Y_UPPER_DEEP - depth * reach_upper;
        const tilt_y_upper = tilt * u * tilt_scale_upper;
        y_upper -= shape === 'smile' ? tilt_y_upper : -tilt_y_upper;
        // Upper lip wobbles at half amplitude so it reads as a calmer top stroke.
        y_upper += wobble * 0.5;

        // Clamp lower lip out of row 0 and upper lip into row 0 so the two lips
        // never land in the same cell (CGRAM has one stroke per char).
        const yi_l = Math.max(Y_LOWER_EDGE, Math.round(y_lower));
        const row_l  = Math.min(ROWS - 1, Math.max(0, Math.floor(yi_l / 8)));
        const line_l = Math.min(7,        Math.max(0, yi_l - row_l * 8));
        grid[row_l][c] = line_l;

        const yi_u = Math.min(Y_UPPER_DEEP, Math.max(0, Math.round(y_upper)));
        const row_u  = Math.min(ROWS - 1, Math.max(0, Math.floor(yi_u / 8)));
        const line_u = Math.min(7,        Math.max(0, yi_u - row_u * 8));
        if (grid[row_u][c] == null) grid[row_u][c] = line_u;
    }
    return grid;
}

async function draw_mouth(screen, shape, tick) {
    if (!screen.atlas_loaded) {
        await screen.instance.loadCgram(MOUTH_ATLAS);
        screen.atlas_loaded = true;
    }
    const grid = compute_mouth_grid(shape, tick);
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

function all_systems_good(rover) {
    const wave_ok = rover.zling.comName1_connected && rover.zling.comName2_connected;
    return rover.rplidar.connected
        && rover.pixhawk_port.connected
        && wave_ok
        && rover.arduino.connected
        && rover.realsense.connected
        && rover.imu_data.connected;
}

function ok_str(connected) { return connected ? 'OK' : '--'; }

function battery_voltage_v(rover) {
    const mv = rover.robot_data.SYS_STATUS && rover.robot_data.SYS_STATUS.voltage_battery;
    if (typeof mv !== 'number' || mv === 65535 || mv === 0) return null;
    return mv / 1000;
}

function sats_visible(rover) {
    const n = rover.robot_data.GPS_RAW_INT && rover.robot_data.GPS_RAW_INT.satellites_visible;
    // 255 is the mavlink sentinel for "unknown".
    if (typeof n !== 'number' || n === 255) return null;
    return n;
}

function heading_deg(rover) {
    if (rover.imu_data && rover.imu_data.connected && typeof rover.imu_data.heading === 'number') {
        return rover.imu_data.heading;
    }
    const h = rover.robot_data.VFR_HUD && rover.robot_data.VFR_HUD.heading;
    return typeof h === 'number' ? h : null;
}

async function draw_status(screen, rover) {
    const lcd = screen.instance;
    const wave_ok = rover.zling.comName1_connected && rover.zling.comName2_connected;

    const v = battery_voltage_v(rover);
    const v_str = v != null ? v.toFixed(1).padStart(4, ' ') + 'V' : '--.-V';
    const s = sats_visible(rover);
    const s_str = s != null ? String(s).padStart(2, ' ') : '--';
    const h = heading_deg(rover);
    const h_str = h != null ? String(Math.round(h) % 360).padStart(3, ' ') : '---';

    const lines = [
        `LIDAR :${ok_str(rover.rplidar.connected)}  PIX:${ok_str(rover.pixhawk_port.connected)}`,
        `WAVE  :${ok_str(wave_ok)}  ARD:${ok_str(rover.arduino.connected)}`,
        `RSENSE:${ok_str(rover.realsense.connected)}  IMU:${ok_str(rover.imu_data.connected)}`,
        `BAT:${v_str} S:${s_str} H:${h_str}`
    ];

    for (let r = 0; r < ROWS; r++) {
        await lcd.setCursor(0, r);
        await lcd.writeString(pad(lines[r], COLS));
    }
}

async function draw_realsense(screen, rover) {
    const lcd = screen.instance;
    const vision = (rover.realsense && rover.realsense.vision) || {};
    const det = (rover.realsense && rover.realsense.path_detection) || {};

    const conf_threshold = typeof vision.confidence_threshold === 'number' ? vision.confidence_threshold : 0.6;
    const stale_ms = typeof vision.stale_detection_ms === 'number' ? vision.stale_detection_ms : 1200;
    const fresh = det.timestamp && (Date.now() - det.timestamp) < stale_ms;
    const sidewalk_detected = !!(fresh && typeof det.confidence === 'number' && det.confidence >= conf_threshold);
    const conf_str = typeof det.confidence === 'number'
        ? det.confidence.toFixed(2)
        : '----';

    // Front-arc object status: worst-of-two rollup across lidar zones 11 and 12
    // (the front-blocked zones). Stale or missing readings count as green.
    // Both OBJ LIDAR and OBJ VISION display the same value for now; the vision
    // line will be re-sourced from realsense data later.
    const front_status = (() => {
        if (!Array.isArray(rover.zones)) return 'G';
        const now = Date.now();
        let any_red = false, any_yellow = false;
        for (const z of rover.zones) {
            if (z.zone !== 11 && z.zone !== 12) continue;
            if (!z.timestamp || (now - z.timestamp) > 1500) continue;
            if (z.light === 'red') any_red = true;
            else if (z.light === 'yellow') any_yellow = true;
        }
        return any_red ? 'R' : any_yellow ? 'Y' : 'G';
    })();

    let avoid_str;
    if (rover.mission && rover.mission.avoidance_timed_out) avoid_str = 'TMO';
    else if (rover.mission && rover.mission.path_clear === false) avoid_str = 'BLK';
    else avoid_str = 'CLR';

    const pw_str = typeof det.path_width_meters === 'number' && det.path_width_meters > 0
        ? det.path_width_meters.toFixed(1) + 'm'
        : '--';

    const sw_flag = sidewalk_detected ? 'Y' : 'N';
    const lines = [
        `SW:${sw_flag} c=${conf_str} AV:${avoid_str}`,
        `OBJ LIDAR:  ${front_status}`,
        `OBJ VISION: ${front_status}`,
        `PATH WIDTH: ${pw_str}`
    ];

    for (let r = 0; r < ROWS; r++) {
        await lcd.setCursor(0, r);
        await lcd.writeString(pad(lines[r], COLS));
    }
}

var write_to_lcd = async function (rover) {
    rover.lcd_screens.tick = (rover.lcd_screens.tick || 0) + 1;
    const tick = rover.lcd_screens.tick;

    // LCD 1 — animate every tick (~500ms).
    if (rover.lcd_screens.screen1.connected) {
        try {
            const shape = all_systems_good(rover) ? 'smile' : 'frown';
            await draw_mouth(rover.lcd_screens.screen1, shape, tick);
        } catch (err) {
            rover.lcd_screens.screen1.connected = false;
            console.log(`LCD screen1 write failed: ${err.message}`);
        }
    }

    // LCDs 2 and 3 — refresh every other tick (~1Hz) to keep the i2c loop light.
    const refresh_status = (tick % 2) === 0;

    if (refresh_status && rover.lcd_screens.screen2.connected) {
        try {
            await draw_status(rover.lcd_screens.screen2, rover);
        } catch (err) {
            rover.lcd_screens.screen2.connected = false;
            console.log(`LCD screen2 write failed: ${err.message}`);
        }
    }

    if (refresh_status && rover.lcd_screens.screen3.connected) {
        try {
            await draw_realsense(rover.lcd_screens.screen3, rover);
        } catch (err) {
            rover.lcd_screens.screen3.connected = false;
            console.log(`LCD screen3 write failed: ${err.message}`);
        }
    }
};

module.exports = write_to_lcd;
