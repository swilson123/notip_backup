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

// Quadratic mouth curve across 20 cells. amplitude (0..1) controls how deep the
// curve dips; shape 'smile' arches downward (corners up), 'frown' arches upward
// (corners down). Returns a 4-row × 20-col grid where each entry is a CGRAM
// char index (0..7) or null for a blank cell.
function compute_mouth_grid(shape, amplitude) {
    const grid = [
        new Array(COLS).fill(null),
        new Array(COLS).fill(null),
        new Array(COLS).fill(null),
        new Array(COLS).fill(null)
    ];
    const Y_NEAR_EDGE = 2;        // pixel y at the outer cells (line ~2 of row 0)
    const Y_DEEP      = 29;       // pixel y at center cell (line ~5 of row 3)
    const reach       = Y_DEEP - Y_NEAR_EDGE;
    const amp = Math.max(0, Math.min(1, amplitude));

    for (let c = 0; c < COLS; c++) {
        const u = (c + 0.5 - COLS / 2) / (COLS / 2);  // -1..1 across the panel
        const depth = amp * (1 - u * u);              // 0 at edges, amp at center
        const y = shape === 'smile'
            ? Y_NEAR_EDGE + depth * reach
            : Y_DEEP      - depth * reach;
        const yi = Math.round(y);
        const row  = Math.min(ROWS - 1, Math.max(0, Math.floor(yi / 8)));
        const line = Math.min(7,        Math.max(0, yi - row * 8));
        grid[row][c] = line;
    }
    return grid;
}

async function draw_mouth(screen, shape, frame) {
    if (!screen.atlas_loaded) {
        await screen.instance.loadCgram(MOUTH_ATLAS);
        screen.atlas_loaded = true;
    }
    // Pulse between a gentle and a wide expression for personality.
    const amplitude = frame === 0 ? 0.78 : 1.0;
    const grid = compute_mouth_grid(shape, amplitude);
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

async function draw_status(screen, rover) {
    const lcd = screen.instance;
    const wave_ok = rover.zling.comName1_connected && rover.zling.comName2_connected;

    const v = battery_voltage_v(rover);
    const v_str = v != null ? v.toFixed(1).padStart(4, ' ') + 'V' : '--.-V';
    const s = sats_visible(rover);
    const s_str = s != null ? String(s).padStart(2, ' ') : '--';

    const lines = [
        `LIDAR :${ok_str(rover.rplidar.connected)}  PIX:${ok_str(rover.pixhawk_port.connected)}`,
        `WAVE  :${ok_str(wave_ok)}  ARD:${ok_str(rover.arduino.connected)}`,
        `RSENSE:${ok_str(rover.realsense.connected)}  IMU:${ok_str(rover.imu_data.connected)}`,
        `BATT:${v_str}  SATS:${s_str}`
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

    let object_str = 'NONE';
    if (Array.isArray(rover.realsense.objects) && rover.realsense.objects.length > 0) {
        let nearest = Infinity;
        for (const o of rover.realsense.objects) {
            if (typeof o.distance_m === 'number' && o.distance_m < nearest) nearest = o.distance_m;
        }
        if (nearest !== Infinity) object_str = nearest.toFixed(1) + 'm';
    }

    let avoid_str;
    if (rover.mission && rover.mission.avoidance_timed_out) avoid_str = 'TIMEOUT';
    else if (rover.mission && rover.mission.path_clear === false) avoid_str = 'BLOCK';
    else avoid_str = 'CLEAR';

    const pw_str = typeof det.path_width_meters === 'number' && det.path_width_meters > 0
        ? det.path_width_meters.toFixed(1) + 'm'
        : '--';
    const edge_str = typeof det.nearest_edge_clearance_m === 'number'
        ? det.nearest_edge_clearance_m.toFixed(2) + 'm'
        : '--';

    const lines = [
        `SIDEWALK:${sidewalk_detected ? 'YES' : 'NO '} c=${conf_str}`,
        `OBJECT:  ${object_str}`,
        `AVOID:   ${avoid_str}`,
        `PW:${pw_str}  EDGE:${edge_str}`
    ];

    for (let r = 0; r < ROWS; r++) {
        await lcd.setCursor(0, r);
        await lcd.writeString(pad(lines[r], COLS));
    }
}

var write_to_lcd = async function (rover) {
    rover.lcd_screens.tick = (rover.lcd_screens.tick || 0) + 1;
    const tick = rover.lcd_screens.tick;
    const frame = tick % 2;

    // LCD 1 — animate every tick (~500ms).
    if (rover.lcd_screens.screen1.connected) {
        try {
            const shape = all_systems_good(rover) ? 'smile' : 'frown';
            await draw_mouth(rover.lcd_screens.screen1, shape, frame);
        } catch (err) {
            rover.lcd_screens.screen1.connected = false;
            console.log(`LCD screen1 write failed: ${err.message}`);
        }
    }

    // LCDs 2 and 3 — refresh every other tick (~1Hz) to keep the i2c loop light.
    const refresh_status = frame === 0;

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
