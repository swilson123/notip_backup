// Parses one frame from the MJRTK-UM982 and lands it on white_rabbit.witmotion.received_data.
//
// connect_to_witmotion.js hands us whichever frame arrived, already framed and, for the binary
// path, already checksum-verified:
//   Buffer  → a WitMotion 11-byte 0x55 IMU packet (same protocol as connect_to_witmotion_hwt905.js)
//   String  → one ASCII sentence, '$' NMEA or '#' Unicore, checksum field still attached
//
// CHECKSUM POLICY, deliberately asymmetric:
//   NMEA  is checked and bad sentences are DROPPED. The XOR-between-$-and-* rule is settled
//         and universal, so a mismatch is genuinely a corrupt sentence.
//   Unicore '#' messages carry a CRC32 which is NOT verified here. It has not been possible to
//         confirm the exact CRC variant against the real device yet, and a parser that silently
//         rejects every heading message because of a wrong polynomial is far worse than one that
//         trusts a well-formed line. The field count and numeric sanity are checked instead.
//         When the device is on the bench, capture a real #UNIHEADINGA and tighten this.
//
// Nothing here throws outward: one malformed sentence must never take down the mission loop.

const WIT_PACKET_LENGTH = 11;
const TYPE_ACCEL = 0x51;
const TYPE_GYRO  = 0x52;
const TYPE_ANGLE = 0x53;

const ANGLE_SCALE = 180.0 / 32768.0;
const ACCEL_SCALE = 16.0 * 9.80665 / 32768.0; // g → m/s²
const GYRO_SCALE  = 2000.0 / 32768.0;
const TEMP_SCALE  = 1.0 / 100.0;

const KNOTS_TO_MPS = 0.514444;
const KMH_TO_MPS   = 1 / 3.6;

// $--GGA field 6. The whole point of an RTK receiver is telling 4 and 5 apart from 1.
const FIX_QUALITY = {
    0: 'no_fix',
    1: 'gps',
    2: 'dgps',
    3: 'pps',
    4: 'rtk_fixed',   // centimetre — the one we want
    5: 'rtk_float',   // decimetre — usable, still converging
    6: 'dead_reckoning',
    7: 'manual',
    8: 'simulation'
};

function readInt16LE(buf, offset) {
    const val = buf[offset] | (buf[offset + 1] << 8);
    return val >= 0x8000 ? val - 0x10000 : val;
}

// NMEA checksum: XOR of every character between '$' and '*'.
function nmea_checksum_ok(sentence) {
    const star = sentence.lastIndexOf('*');
    if (star === -1 || star + 3 > sentence.length) return false;

    let sum = 0;
    for (let i = 1; i < star; i++) sum ^= sentence.charCodeAt(i);

    return sum === parseInt(sentence.substring(star + 1, star + 3), 16);
}

// NMEA packs latitude as ddmm.mmmm and longitude as dddmm.mmmm — degrees and decimal
// MINUTES glued together, not decimal degrees. Splitting at the right digit is the whole job.
function nmea_to_degrees(raw, hemisphere, degree_digits) {
    if (!raw || raw.length < degree_digits) return null;

    const degrees = parseFloat(raw.substring(0, degree_digits));
    const minutes = parseFloat(raw.substring(degree_digits));
    if (!isFinite(degrees) || !isFinite(minutes)) return null;

    const value = degrees + minutes / 60;
    return (hemisphere === 'S' || hemisphere === 'W') ? -value : value;
}

function to_number(field) {
    if (field === undefined || field === '') return null;
    const value = parseFloat(field);
    return isFinite(value) ? value : null;
}

var witmotion_message_handler = function (white_rabbit, message) {

    try {

        if (Buffer.isBuffer(message)) {
            parse_witmotion_packet(white_rabbit, message);
        } else if (message.charAt(0) === '$') {
            parse_nmea(white_rabbit, message);
        } else if (message.charAt(0) === '#') {
            parse_unicore(white_rabbit, message);
        } else {
            white_rabbit.witmotion.frames_bad++;
            return;
        }

        white_rabbit.witmotion.received_data.timestamp = Date.now();
        white_rabbit.witmotion.last_message_ts = white_rabbit.witmotion.received_data.timestamp;

        log_once_per_second(white_rabbit);

    }
    catch (e) {
        white_rabbit.witmotion.frames_bad++;
        white_rabbit.logs.witmotion_message_handler.log(white_rabbit, 'parse error: ' + e.message);
    }

};

// --- WitMotion binary IMU, if this board carries one -------------------------------------
// Identical packet layout to the HWT905. Roll arrives ONLY through this path — see the note in
// connect_to_witmotion.js about why two antennas cannot see roll.
function parse_witmotion_packet(white_rabbit, packet) {

    if (packet.length !== WIT_PACKET_LENGTH) {
        white_rabbit.witmotion.frames_bad++;
        return;
    }

    const imu = white_rabbit.witmotion.received_data.imu;
    const type = packet[1];

    if (type === TYPE_ACCEL) {
        imu.accel.x = readInt16LE(packet, 2) * ACCEL_SCALE;
        imu.accel.y = readInt16LE(packet, 4) * ACCEL_SCALE;
        imu.accel.z = readInt16LE(packet, 6) * ACCEL_SCALE;
        imu.temperature_c = readInt16LE(packet, 8) * TEMP_SCALE;

    } else if (type === TYPE_GYRO) {
        imu.gyro.x = readInt16LE(packet, 2) * GYRO_SCALE;
        imu.gyro.y = readInt16LE(packet, 4) * GYRO_SCALE;
        imu.gyro.z = readInt16LE(packet, 6) * GYRO_SCALE;

    } else if (type === TYPE_ANGLE) {
        imu.roll_deg  = readInt16LE(packet, 2) * ANGLE_SCALE;
        imu.pitch_deg = readInt16LE(packet, 4) * ANGLE_SCALE;
        imu.yaw_deg   = readInt16LE(packet, 6) * ANGLE_SCALE;
        imu.present   = true;

    } else {
        // A packet type this driver has no use for (magnetometer, port status, quaternion...).
        // Not an error — the device streams whatever it was configured to stream.
        return;
    }

    white_rabbit.witmotion.frames_ok++;
}

// --- NMEA-0183 ----------------------------------------------------------------------------
function parse_nmea(white_rabbit, sentence) {

    if (!nmea_checksum_ok(sentence)) {
        white_rabbit.witmotion.frames_bad++;
        return;
    }

    const star   = sentence.lastIndexOf('*');
    const fields = sentence.substring(0, star).split(',');

    // Talker ID varies with constellation ($GP/$GN/$GB/$GA...) — only the last 3 chars identify
    // the sentence, so match on those and stay constellation-agnostic.
    const type = fields[0].substring(fields[0].length - 3);
    const gps  = white_rabbit.witmotion.received_data.gps;

    if (type === 'GGA') {

        gps.utc           = fields[1] || null;
        gps.latitude      = nmea_to_degrees(fields[2], fields[3], 2);
        gps.longitude     = nmea_to_degrees(fields[4], fields[5], 3);
        gps.fix_quality   = to_number(fields[6]);
        gps.fix_type      = FIX_QUALITY[gps.fix_quality] !== undefined ? FIX_QUALITY[gps.fix_quality] : 'unknown';
        gps.satellites    = to_number(fields[7]);
        gps.hdop          = to_number(fields[8]);
        gps.altitude_m    = to_number(fields[9]);
        gps.rtk           = gps.fix_quality === 4 || gps.fix_quality === 5;

    } else if (type === 'RMC') {

        gps.valid      = fields[2] === 'A';
        gps.utc        = fields[1] || gps.utc;
        gps.latitude   = nmea_to_degrees(fields[3], fields[4], 2);
        gps.longitude  = nmea_to_degrees(fields[5], fields[6], 3);

        const knots = to_number(fields[7]);
        if (knots !== null) gps.speed_mps = knots * KNOTS_TO_MPS;

        const course = to_number(fields[8]);
        if (course !== null) gps.course_deg = course;

        gps.date = fields[9] || null;

    } else if (type === 'VTG') {

        const course = to_number(fields[1]);
        if (course !== null) gps.course_deg = course;

        const kmh = to_number(fields[7]);
        if (kmh !== null) gps.speed_mps = kmh * KMH_TO_MPS;

    } else if (type === 'GST') {

        // Per-axis standard deviations — the honest accuracy number, far better than HDOP for
        // deciding whether a waypoint arrival is real or noise.
        gps.accuracy.lat_std_m = to_number(fields[6]);
        gps.accuracy.lon_std_m = to_number(fields[7]);
        gps.accuracy.alt_std_m = to_number(fields[8]);

    } else if (type === 'THS' || type === 'HDT') {

        // Dual-antenna true heading in NMEA form. THS adds a mode indicator ('A' = autonomous,
        // 'V' = not valid) that HDT has no room for.
        const heading = to_number(fields[1]);
        if (heading !== null && (type === 'HDT' || fields[2] !== 'V')) {
            white_rabbit.witmotion.received_data.heading_deg = heading;
        }

    } else {
        // GSA, GSV, ZDA and friends — well-formed, just not something this rover reads.
        return;
    }

    white_rabbit.witmotion.frames_ok++;
}

// --- Unicore proprietary ASCII ------------------------------------------------------------
// #UNIHEADINGA,<header fields>;<data fields>*<crc>
// The dual-antenna solution: baseline length, heading and pitch with their standard deviations.
// This is the message that makes the device a compass.
function parse_unicore(white_rabbit, sentence) {

    const semicolon = sentence.indexOf(';');
    const star      = sentence.lastIndexOf('*');
    if (semicolon === -1) {
        white_rabbit.witmotion.frames_bad++;
        return;
    }

    const name = sentence.substring(1, sentence.indexOf(','));
    if (name !== 'UNIHEADINGA' && name !== 'UNIHEADING') return;

    const data = sentence.substring(semicolon + 1, star === -1 ? sentence.length : star).split(',');
    if (data.length < 8) {
        white_rabbit.witmotion.frames_bad++;
        return;
    }

    const received_data = white_rabbit.witmotion.received_data;

    received_data.heading_solution = data[0] || null;  // SOL_COMPUTED / INSUFFICIENT_OBS ...
    received_data.heading_type     = data[1] || null;  // NARROW_INT is the fixed, trustworthy one
    received_data.baseline_m       = to_number(data[2]);

    const heading = to_number(data[3]);
    const pitch   = to_number(data[4]);

    // Only publish an angle the receiver actually solved. A stale heading held through a turn is
    // the exact failure the sidewalk-vision notes warn about, so never fabricate one.
    if (received_data.heading_solution === 'SOL_COMPUTED' && heading !== null) {
        received_data.heading_deg     = (heading + 360) % 360;
        received_data.pitch_deg       = pitch;
        received_data.heading_std_deg = to_number(data[6]);
        received_data.pitch_std_deg   = to_number(data[7]);
    }

    white_rabbit.witmotion.frames_ok++;
}

function log_once_per_second(white_rabbit) {

    if (white_rabbit.witmotion.received_data.timestamp - white_rabbit.witmotion.last_log_ts < 1000) return;

    white_rabbit.witmotion.last_log_ts = white_rabbit.witmotion.received_data.timestamp;

    const gps = white_rabbit.witmotion.received_data.gps;

    white_rabbit.logs.witmotion_message_handler.log(white_rabbit,
        'MJRTK fix:' + gps.fix_type +
        ' lat:' + (gps.latitude === null ? '-' : gps.latitude.toFixed(7)) +
        ' lon:' + (gps.longitude === null ? '-' : gps.longitude.toFixed(7)) +
        ' sats:' + gps.satellites +
        ' heading:' + (white_rabbit.witmotion.received_data.heading_deg === null ? '-' : white_rabbit.witmotion.received_data.heading_deg.toFixed(2)) +
        ' pitch:' + (white_rabbit.witmotion.received_data.pitch_deg === null ? '-' : white_rabbit.witmotion.received_data.pitch_deg.toFixed(2)) +
        ' roll:' + (white_rabbit.witmotion.received_data.imu.present ? white_rabbit.witmotion.received_data.imu.roll_deg.toFixed(2) : 'n/a') +
        ' ok:' + white_rabbit.witmotion.frames_ok + ' bad:' + white_rabbit.witmotion.frames_bad
    );
}

module.exports = witmotion_message_handler;
