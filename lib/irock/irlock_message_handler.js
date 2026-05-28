// IRLock message handler.
//
// Parses a 14-byte IRLock I2C block, validates the checksum and sync bytes,
// and updates rover.irlock with the latest target.  Also computes the angular
// offset of the beacon relative to the rover's camera bore — these are the
// steering and elevation signals that follow_the_light.js uses.
//
// IRLock field of view (PixyCam sensor):
//   Horizontal: 320 px → ~60°  (±30° from center)
//   Vertical:   200 px → ~40°  (±20° from center)
//
// Coordinate convention:
//   angle_x > 0  →  beacon is to the RIGHT of the rover's camera bore
//   angle_x < 0  →  beacon is to the LEFT
//   angle_y > 0  →  beacon is BELOW center (looking down at the beacon)
//   angle_y < 0  →  beacon is ABOVE center

const IRLOCK_SYNC_0    = 0xAA;
const IRLOCK_SYNC_1    = 0x55;
const IRLOCK_SYNC_1_CC = 0x56;
const STALE_MS         = 500;   // target is stale after 500 ms without a fresh read

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

function pixel_to_angle_x(pixel_x) {
    return ((pixel_x - PIX_X_CTR) / PIX_X_CTR) * (FOV_X_DEG / 2);
}

function pixel_to_angle_y(pixel_y) {
    return ((pixel_y - PIX_Y_CTR) / PIX_Y_CTR) * (FOV_Y_DEG / 2);
}

var irlock_message_handler = function (rover, buf) {
    if (!buf || buf.length < 14) {
        rover.irlock.target = null;
        return;
    }

    // Validate sync bytes
    const sync0 = buf[0];
    const sync1 = buf[1];
    if (sync0 !== IRLOCK_SYNC_0 || (sync1 !== IRLOCK_SYNC_1 && sync1 !== IRLOCK_SYNC_1_CC)) {
        // No valid target in frame
        rover.irlock.target = null;
        rover.irlock.detected = false;
        rover.irlock.last_no_target_ts = Date.now();
        return;
    }

    const checksum  = readUInt16LE(buf,  2);
    const signature = readUInt16LE(buf,  4);
    const center_x  = readUInt16LE(buf,  6);
    const center_y  = readUInt16LE(buf,  8);
    const width     = readUInt16LE(buf, 10);
    const height    = readUInt16LE(buf, 12);

    // Validate checksum — sum of the five 16-bit words after the checksum field
    const expected_checksum = (signature + center_x + center_y + width + height) & 0xFFFF;
    if (checksum !== expected_checksum) {
        rover.irlock.target = null;
        rover.irlock.detected = false;
        return;
    }

    // Range check
    if (center_x > PIX_X_MAX || center_y > PIX_Y_MAX) {
        rover.irlock.target = null;
        rover.irlock.detected = false;
        return;
    }

    const angle_x = pixel_to_angle_x(center_x);
    const angle_y = pixel_to_angle_y(center_y);

    // Size in pixels → approximate relative distance proxy:
    // larger target = closer. Normalise to [0, 1] where 1 = full frame.
    const size_norm = (width * height) / (PIX_X_MAX * PIX_Y_MAX);

    const now = Date.now();

    rover.irlock.target = {
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

    rover.irlock.detected = true;
    rover.irlock.last_detection_ts = now;

    // 1-Hz log
    if (!rover.irlock._last_log_ts || now - rover.irlock._last_log_ts >= 1000) {
        rover.irlock._last_log_ts = now;
        rover.logs.irlock.log(rover,
            'IRLock target: sig=' + signature
            + ' cx=' + center_x + ' cy=' + center_y
            + ' w=' + width + ' h=' + height
            + ' angle_x=' + angle_x.toFixed(1) + '° angle_y=' + angle_y.toFixed(1) + '°'
            + ' size=' + (size_norm * 100).toFixed(1) + '%'
        );
    }
};

// Call this to check if the target is fresh (within STALE_MS)
irlock_message_handler.is_fresh = function (rover) {
    if (!rover.irlock.detected || !rover.irlock.last_detection_ts) return false;
    return (Date.now() - rover.irlock.last_detection_ts) < STALE_MS;
};

module.exports = irlock_message_handler;
