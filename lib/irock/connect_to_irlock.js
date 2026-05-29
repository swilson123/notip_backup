// Connect to IRLock sensor over I2C.
//
// IRLock uses the PixyCam I2C protocol at address 0x54.
// Frame parsing (sync detection, checksum, field extraction) is handled by
// irlock_message_handler.js.  See that file for the wire-protocol details.
//
// Polls every 50 ms. On error, disconnects and retries on next connect cycle.
// Updates white_rabbit.irlock with the latest target data.

const IRLOCK_ADDRESS   = 0x54;
const IRLOCK_READ_SIZE = 32;   // 2× 16-byte frames — guarantees a full frame regardless of alignment
const POLL_INTERVAL_MS = 50;

var connect_to_irlock = function (white_rabbit) {
    if (white_rabbit.irlock.connected || white_rabbit.irlock.connecting) return;
    white_rabbit.irlock.connecting = true;

    try {
        const bus = white_rabbit.i2c.openSync(1);

        // Verify there is a device at 0x54 by attempting a read
        const probe = Buffer.alloc(IRLOCK_READ_SIZE);
        try {
            bus.i2cReadSync(IRLOCK_ADDRESS, IRLOCK_READ_SIZE, probe);
        } catch (err) {
            console.log('IRLock: no device at 0x54 —', err.message);
            white_rabbit.irlock.connecting = false;
            return;
        }

        white_rabbit.irlock.connected  = true;
        white_rabbit.irlock.connecting = false;
        console.log('IRLock: connected at I2C 0x54');
        white_rabbit.logs.irlock.log(white_rabbit, 'IRLock connected at I2C 0x54');

        const buf = Buffer.alloc(IRLOCK_READ_SIZE);

        white_rabbit.irlock.poll_interval = setInterval(() => {
            try {
                bus.i2cReadSync(IRLOCK_ADDRESS, IRLOCK_READ_SIZE, buf);

                white_rabbit.irlock_message_handler(white_rabbit, buf);

            } catch (err) {
                console.log('IRLock: read error —', err.message);
                white_rabbit.logs.irlock.log(white_rabbit, 'IRLock read error: ' + err.message);
                white_rabbit.irlock.connected = false;
                clearInterval(white_rabbit.irlock.poll_interval);
                white_rabbit.irlock.poll_interval = null;
            }
        }, POLL_INTERVAL_MS);

    } catch (err) {
        console.log('IRLock: connect error —', err.message);
        white_rabbit.irlock.connecting = false;
        white_rabbit.irlock.connected  = false;
    }
};

module.exports = connect_to_irlock;
