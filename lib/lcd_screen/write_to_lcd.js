// LCD 1 (0x27): full-screen animated mouth — a single bold smile or frown
//               (all-systems-good face), or a growing/shrinking oval that mimics
//               talking while Noah speaks over the EMEET.
// LCD 2 (0x26): device connection status + battery voltage + GPS satellite count.
// LCD 3 (0x25): RealSense vision — edge detection (L/R), object, avoid status,
//               plus GPS fix type + HDOP on the bottom row.

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
    // RealSense only counts toward the all-systems face when its vision is enabled.
    // If realsense_vision is disabled in setup, exclude it — a missing camera
    // shouldn't make Noah frown when he's not relying on it.
    const rs_enabled = !!(white_rabbit.realsense && white_rabbit.realsense.vision
        && white_rabbit.realsense.vision.enabled);
    const rs_ok = !rs_enabled || white_rabbit.realsense.connected;
    // IMU only counts toward the all-systems face when it's enabled in setup.
    // With enable_imu false, heading/roll/pitch come from the Pixhawk, so a
    // disconnected IMU shouldn't make Noah frown.
    const imu_enabled = !!(white_rabbit.imu && white_rabbit.imu.enable_imu);
    const imu_ok = !imu_enabled || white_rabbit.imu_data.connected;
    return white_rabbit.rplidar.connected
        && white_rabbit.pixhawk_port.connected
        && wave_ok
        && white_rabbit.arduino.connected
        && rs_ok
        && imu_ok
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

// GPS fix type → short label. MAVLink GPS_FIX_TYPE:
// 0 no gps, 1 no fix, 2 2D, 3 3D, 4 DGPS, 5 RTK float, 6 RTK fixed, 7 static, 8 PPP.
// With a Here+ RTK base feeding corrections, a good solution shows RTKflt then RTKfix.
function gps_fix_label(white_rabbit) {
    const g = white_rabbit.robot_data.GPS_RAW_INT;
    const t = g && g.fix_type;
    if (typeof t !== 'number') return null;
    switch (t) {
        case 0: return 'NOGPS';
        case 1: return 'NOFIX';
        case 2: return '2D';
        case 3: return '3D';
        case 4: return 'DGPS';
        case 5: return 'RTKflt';
        case 6: return 'RTKfix';
        case 7: return 'STATIC';
        case 8: return 'PPP';
        default: return String(t);
    }
}

// HDOP (horizontal dilution of precision) from GPS_RAW_INT.eph. ArduPilot reports
// eph as HDOP*100; 65535 is the mavlink sentinel for "unknown". This is the best
// precision proxy this mavlink dialect decodes — true h_acc (mm) is not in the
// decoded message. Lower HDOP = better geometry; RTK fixes typically run well below 1.
function gps_hdop(white_rabbit) {
    const g = white_rabbit.robot_data.GPS_RAW_INT;
    const e = g && g.eph;
    if (typeof e !== 'number' || e === 65535 || e === 0) return null;
    return e / 100;
}

function heading_deg(white_rabbit) {
    // Single source of truth — get_heading (IMU when enable_imu, else Pixhawk).
    const have_imu = white_rabbit.imu_data && typeof white_rabbit.imu_data.heading === 'number';
    const have_vfr = white_rabbit.robot_data && white_rabbit.robot_data.VFR_HUD
        && typeof white_rabbit.robot_data.VFR_HUD.heading === 'number';
    if (!have_imu && !have_vfr) return null;
    return typeof white_rabbit.get_heading === 'function' ? white_rabbit.get_heading(white_rabbit) : null;
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

    // RS / IMU show 'NA' when disabled in setup — they aren't in use, so their
    // connection state is irrelevant (and shouldn't read as a fault).
    const rs_enabled = !!(white_rabbit.realsense && white_rabbit.realsense.vision
        && white_rabbit.realsense.vision.enabled);
    const imu_enabled = !!(white_rabbit.imu && white_rabbit.imu.enable_imu);
    const rs_str = rs_enabled ? ok_str(white_rabbit.realsense.connected) : 'NA';
    const imu_str = imu_enabled ? ok_str(white_rabbit.imu_data.connected) : 'NA';

    const lines = [
        `LIDAR :${ok_str(white_rabbit.rplidar.connected)}  PIX:${ok_str(white_rabbit.pixhawk_port.connected)}`,
        `WAVE  :${ok_str(wave_ok)}  ARD:${ok_str(white_rabbit.arduino.connected)}`,
        `RS:${rs_str}  IMU:${imu_str} IRL:${irl_conn}`,
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

    const stale_ms = typeof vision.stale_detection_ms === 'number' ? vision.stale_detection_ms : 1200;
    const fresh = !!(det.timestamp && (Date.now() - det.timestamp) < stale_ms);

    // Edge seen flags (1/0). Prefer per-side known telemetry; fall back to boundary flags.
    const el_seen = !!(fresh && ((typeof det.edge_left_known === 'boolean') ? det.edge_left_known : det.left_boundary_visible));
    const er_seen = !!(fresh && ((typeof det.edge_right_known === 'boolean') ? det.edge_right_known : det.right_boundary_visible));

    // 00 = edge not seen; NN = confidence value. All results shown — no minimum.
    function fmt_conf_1_99(conf, seen) {
        if (!seen || typeof conf !== 'number' || !isFinite(conf)) return '00';
        const raw = conf > 1.5 ? conf : conf * 100.0;
        const pct = Math.max(1, Math.min(99, Math.round(raw)));
        return String(pct).padStart(2, '0');
    }
    const el_conf = fmt_conf_1_99(det.edge_left_conf, el_seen);
    const er_conf = fmt_conf_1_99(det.edge_right_conf, er_seen);

    // Prefer explicit per-edge X/Y telemetry; keep older fields as fallback.
    // '----' = edge not seen; '+N.N' = value (shown for every seen edge, any confidence).
    function fmt_m_1(v, seen) {
        if (!seen || typeof v !== 'number') return '----';
        const sign = v >= 0 ? '+' : '-';
        return sign + Math.abs(v).toFixed(1);
    }

    const left_x = fmt_m_1((typeof det.edge_left_x_m === 'number') ? det.edge_left_x_m : det.edge_left_m, el_seen);
    const left_y = fmt_m_1((typeof det.edge_left_y_m === 'number') ? det.edge_left_y_m : det.edge_forward_m, el_seen);
    const right_x = fmt_m_1((typeof det.edge_right_x_m === 'number') ? det.edge_right_x_m : det.edge_right_m, er_seen);
    const right_y = fmt_m_1((typeof det.edge_right_y_m === 'number') ? det.edge_right_y_m : det.edge_forward_m, er_seen);

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

    // RealSense vision front-arc object status.
    const vision_status = (() => {
        const vz = white_rabbit.realsense && white_rabbit.realsense.vision_zones;
        if (!vz) return 'G';
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

    // IRLock sees light: 1 = beacon detected and fresh, 0 = no beacon
    const irl_light = (white_rabbit.irlock && white_rabbit.irlock.detected
        && white_rabbit.irlock_message_handler && white_rabbit.irlock_message_handler.is_fresh(white_rabbit))
        ? '1' : '0';

    // GPS fix + HDOP for the previously-blank row 3. Tells the operator at a glance
    // whether the Here+ RTK base has the rover at a 3D/RTK-float/RTK-fixed solution
    // and how good the geometry is (HDOP).
    const gps_fix = gps_fix_label(white_rabbit);
    const gps_fix_str = gps_fix != null ? gps_fix : '--';
    const hdop = gps_hdop(white_rabbit);
    const hdop_str = hdop != null ? hdop.toFixed(1) : '--';

    // 20-char rows:
    // Row 0: "EL C85 X+0.5 Y+0.7"  (edge seen — confidence + position)
    // Row 1: "ER C00 X---- Y----"  (edge not seen — C00, X/Y dashes)
    // Row 2: "AV:CLR L:G V:G IRL:1" (avoidance, lidar, vision OBJ, irlock)
    // Row 3: "GPS:RTKfix HDOP:0.6" (fix type + horizontal dilution of precision)
    const lines = [
        `EL C${el_conf} X${left_x} Y${left_y}`,
        `ER C${er_conf} X${right_x} Y${right_y}`,
        `AV:${avoid_str} L:${front_status} V:${vision_status} IRL:${irl_light}`,
        `GPS:${gps_fix_str} HDOP:${hdop_str}`
    ];

    for (let r = 0; r < ROWS; r++) {
        await lcd.setCursor(0, r);
        await lcd.writeString(pad(lines[r], COLS));
    }
}

var write_to_lcd = async function (white_rabbit) {
    white_rabbit.lcd_screens.tick = (white_rabbit.lcd_screens.tick || 0) + 1;
    const tick = white_rabbit.lcd_screens.tick;

    // The i2c loop ticks at ~100ms (see connect_to_lcd.js). Each screen refreshes on
    // its own cadence so only LCD 3 runs at the full 10Hz while the mouth keeps its
    // ~500ms animation feel and the status screen stays light. All draws share the one
    // serialized loop, so the i2c bus is never written concurrently.
    const MOUTH_EVERY  = 5;   // ~500 ms per animation frame
    const STATUS_EVERY = 10;  // ~1 Hz

    // LCD 3 — RealSense vision, refreshed EVERY tick (~10Hz). Drawn first so the
    // operator-facing fast readout has priority on ticks where screens coincide.
    if (white_rabbit.lcd_screens.screen3.connected) {
        try {
            await draw_realsense(white_rabbit.lcd_screens.screen3, white_rabbit);
        } catch (err) {
            white_rabbit.lcd_screens.screen3.connected = false;
            console.log(`LCD screen3 write failed: ${err.message}`);
        }
    }

    // LCD 1 — animated mouth, ~500ms per frame. Pass a slowed tick so the animation
    // advances at the old cadence even though the loop now ticks 5x faster.
    if ((tick % MOUTH_EVERY) === 0 && white_rabbit.lcd_screens.screen1.connected) {
        try {
            const shape = all_systems_good(white_rabbit) ? 'smile' : 'frown';
            const speaking = !!(white_rabbit.voice && white_rabbit.voice.tts
                && typeof white_rabbit.voice.tts.is_speaking === 'function'
                && white_rabbit.voice.tts.is_speaking());
            await draw_mouth(white_rabbit.lcd_screens.screen1, shape, Math.floor(tick / MOUTH_EVERY), speaking);
        } catch (err) {
            white_rabbit.lcd_screens.screen1.connected = false;
            console.log(`LCD screen1 write failed: ${err.message}`);
        }
    }

    // LCD 2 — device/battery/GPS status, ~1Hz.
    if ((tick % STATUS_EVERY) === 0 && white_rabbit.lcd_screens.screen2.connected) {
        try {
            await draw_status(white_rabbit.lcd_screens.screen2, white_rabbit);
        } catch (err) {
            white_rabbit.lcd_screens.screen2.connected = false;
            console.log(`LCD screen2 write failed: ${err.message}`);
        }
    }
};

module.exports = write_to_lcd;
