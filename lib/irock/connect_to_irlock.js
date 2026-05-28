// Connect to IRLock sensor over I2C.
//
// IRLock uses the PixyCam I2C protocol at address 0x54.
// Each detected target block is 14 bytes:
//   [0-1]   sync: 0xAA 0x55 (first object) or 0xAA 0x56 (additional)
//   [2-3]   checksum (sum of sig + x + y + w + h, uint16 little-endian)
//   [4-5]   signature  (1–7, which IR target)
//   [6-7]   center_x   (0–319, left=0, right=319)
//   [8-9]   center_y   (0–199, top=0, bottom=199)
//   [10-11] width
//   [12-13] height
//
// Polls every 50 ms. On error, disconnects and retries on next connect cycle.
// Updates rover.irlock with the latest target data.

const IRLOCK_ADDRESS    = 0x54;
const IRLOCK_SYNC_0     = 0xAA;
const IRLOCK_SYNC_1     = 0x55;
const IRLOCK_SYNC_1_CC  = 0x56;   // additional-object sync byte
const IRLOCK_BLOCK_SIZE = 14;
const POLL_INTERVAL_MS  = 50;

function readUInt16LE(buf, offset) {
    return buf[offset] | (buf[offset + 1] << 8);
}

var connect_to_irlock = function (rover) {
    if (rover.irlock.connected || rover.irlock.connecting) return;
    rover.irlock.connecting = true;

    try {
        const bus = rover.i2c.openSync(1);

        // Verify there is a device at 0x54 by attempting a read
        const probe = Buffer.alloc(IRLOCK_BLOCK_SIZE);
        try {
            bus.i2cReadSync(IRLOCK_ADDRESS, IRLOCK_BLOCK_SIZE, probe);
        } catch (err) {
            console.log('IRLock: no device at 0x54 —', err.message);
            rover.irlock.connecting = false;
            return;
        }

        rover.irlock.connected  = true;
        rover.irlock.connecting = false;
        console.log('IRLock: connected at I2C 0x54');
        rover.logs.irlock.log(rover, 'IRLock connected at I2C 0x54');

        const buf = Buffer.alloc(IRLOCK_BLOCK_SIZE);

        rover.irlock.poll_interval = setInterval(() => {
            try {
                bus.i2cReadSync(IRLOCK_ADDRESS, IRLOCK_BLOCK_SIZE, buf);

                rover.irlock_message_handler(rover, buf);

            } catch (err) {
                console.log('IRLock: read error —', err.message);
                rover.logs.irlock.log(rover, 'IRLock read error: ' + err.message);
                rover.irlock.connected = false;
                clearInterval(rover.irlock.poll_interval);
                rover.irlock.poll_interval = null;
            }
        }, POLL_INTERVAL_MS);

    } catch (err) {
        console.log('IRLock: connect error —', err.message);
        rover.irlock.connecting = false;
        rover.irlock.connected  = false;
    }
};

module.exports = connect_to_irlock;
