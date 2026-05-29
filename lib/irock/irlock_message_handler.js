// IRLock message handler.
//
// Parses an IRLock I2C frame, validates the checksum and sync words,
// and updates white_rabbit.irlock with the latest target.  Also computes the angular
// offset of the beacon relative to the white_rabbit's camera bore — these are the
// steering and elevation signals that follow_the_light.js uses.
//
// IRLock field of view (PixyCam sensor):
//   Horizontal: 320 px → ~60°  (±30° from center)
//   Vertical:   200 px → ~40°  (±20° from center)
//
// The IRLock is mounted on the CENTER BACK of Noah, 0.5334 m (21 in) off the ground,
// facing rearward toward the dock. Noah reverses up the ramp, so the camera looks in
// the direction of travel while docking.
//
// Coordinate convention (camera frame):
//   angle_x > 0  →  beacon is to the RIGHT of the camera bore
//   angle_x < 0  →  beacon is to the LEFT
//   angle_y > 0  →  beacon is BELOW center (looking down at the beacon)
//   angle_y < 0  →  beacon is ABOVE center
// NOTE: because the camera faces rearward, camera-right is Noah's body-left. The
// steering sign flip for this is handled by irlock.steer_invert in follow_the_light.js.
//
// Wire protocol (PixyCam I2C):
//   The sync word 0xAA55 is sent little-endian (bytes: 0x55 0xAA), and the sensor
//   sends it TWICE in a row before each frame.  Frame layout (16 bytes):
//     [0-1]  sync word 1  : 0x55 0xAA  (LE 0xAA55)
//     [2-3]  sync word 2  : 0x55 0xAA  (first object) or 0x56 0xAA (additional)
//     [4-5]  checksum     : sum of sig+x+y+w+h, uint16 LE
//     [6-7]  signature    : 1–7
//     [8-9]  center_x     : 0–319
//     [10-11] center_y    : 0–199
//     [12-13] width
//     [14-15] height
//   Because we read 32 bytes per poll and the I2C stream is not frame-aligned,
//   findSync() scans for the double-sync pattern rather than assuming offset 0.

const IRLOCK_SYNC_WORD    = 0xAA55;   // first sync word (LE on the wire: 0x55 0xAA)
const IRLOCK_SYNC_WORD_CC = 0xAA56;   // additional-object second sync word
const STALE_MS            = 500;      // target is stale after 500 ms without a fresh read

// IRLock sensor physical specs
const FOV_X_DEG  = 60.0;
const FOV_Y_DEG  = 40.0;
const PIX_X_MAX  = 320;
const PIX_Y_MAX  = 200;
const PIX_X_CTR  = PIX_X_MAX / 2;   // 160
const PIX_Y_CTR  = PIX_Y_MAX / 2;   // 100

function readUInt16LE(buf, offset) {
    return buf[offset] | (buf[offset + 1] << 8);
}

// Scan buf for the PixyCam double-sync pattern (two consecutive 0xAA55 words,
// LE on wire as 55 AA).  The second word may be 0xAA56 for additional objects.
// Returns the byte offset of the first sync word, or -1 if not found.
// Only positions with at least 16 bytes remaining are checked so callers can
// safely read 12 data bytes (checksum through height) after the 4 sync bytes.
function findSync(buf) {
    for (let i = 0; i <= buf.length - 16; i++) {
        const w0 = readUInt16LE(buf, i);
        const w1 = readUInt16LE(buf, i + 2);
        if (w0 === IRLOCK_SYNC_WORD &&
                (w1 === IRLOCK_SYNC_WORD || w1 === IRLOCK_SYNC_WORD_CC)) {
            return i;
        }
    }
    return -1;
}

function pixel_to_angle_x(pixel_x) {
    return ((pixel_x - PIX_X_CTR) / PIX_X_CTR) * (FOV_X_DEG / 2);
}

function pixel_to_angle_y(pixel_y) {
    return ((pixel_y - PIX_Y_CTR) / PIX_Y_CTR) * (FOV_Y_DEG / 2);
}

var irlock_message_handler = function (white_rabbit, buf) {
    if (!buf || buf.length < 16) {
        white_rabbit.irlock.target = null;
        return;
    }

    // Scan for the double-sync pattern anywhere in the buffer.
    const syncOffset = findSync(buf);
    if (syncOffset === -1) {
        // No valid target in frame
        white_rabbit.irlock.target = null;
        white_rabbit.irlock.detected = false;
        white_rabbit.irlock.last_no_target_ts = Date.now();
        return;
    }

    // Data begins after the two sync words (4 bytes).
    const d = syncOffset + 4;
    const checksum  = readUInt16LE(buf, d);
    const signature = readUInt16LE(buf, d + 2);
    const center_x  = readUInt16LE(buf, d + 4);
    const center_y  = readUInt16LE(buf, d + 6);
    const width     = readUInt16LE(buf, d + 8);
    const height    = readUInt16LE(buf, d + 10);

    // Validate checksum — sum of the five 16-bit words after the checksum field
    const expected_checksum = (signature + center_x + center_y + width + height) & 0xFFFF;
    if (checksum !== expected_checksum) {
        white_rabbit.irlock.target = null;
        white_rabbit.irlock.detected = false;
        return;
    }

    // Range check
    if (center_x > PIX_X_MAX || center_y > PIX_Y_MAX) {
        white_rabbit.irlock.target = null;
        white_rabbit.irlock.detected = false;
        return;
    }

    const angle_x = pixel_to_angle_x(center_x);
    const angle_y = pixel_to_angle_y(center_y);

    // Size in pixels → approximate relative distance proxy:
    // larger target = closer. Normalise to [0, 1] where 1 = full frame.
    const size_norm = (width * height) / (PIX_X_MAX * PIX_Y_MAX);

    const now = Date.now();

    white_rabbit.irlock.target = {
        signature,
        center_x,
        center_y,
        width,
        height,
        angle_x,     // deg, + = right
        angle_y,     // deg, + = below center
        size_norm,   // proxy for closeness
        timestamp:   now
    };

    white_rabbit.irlock.detected = true;
    white_rabbit.irlock.last_detection_ts = now;

    // 1-Hz log
    if (!white_rabbit.irlock._last_log_ts || now - white_rabbit.irlock._last_log_ts >= 1000) {
        white_rabbit.irlock._last_log_ts = now;
        white_rabbit.logs.irlock.log(white_rabbit,
            'IRLock target: sig=' + signature
            + ' cx=' + center_x + ' cy=' + center_y
            + ' w=' + width + ' h=' + height
            + ' angle_x=' + angle_x.toFixed(1) + '° angle_y=' + angle_y.toFixed(1) + '°'
            + ' size=' + (size_norm * 100).toFixed(1) + '%'
        );
    }
};

// Call this to check if the target is fresh (within STALE_MS)
irlock_message_handler.is_fresh = function (white_rabbit) {
    if (!white_rabbit.irlock.detected || !white_rabbit.irlock.last_detection_ts) return false;
    return (Date.now() - white_rabbit.irlock.last_detection_ts) < STALE_MS;
};

module.exports = irlock_message_handler;
