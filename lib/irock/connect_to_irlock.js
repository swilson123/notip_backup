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

            // Stamp disconnect and announce once — the last beacon angle remains
            // on white_rabbit.irlock_belief so dock alignment holds last known state.
            if (!white_rabbit.irlock.disconnect_ts) {
                white_rabbit.irlock.disconnect_ts = Date.now();
                if (white_rabbit.voice) white_rabbit.voice.say('IRLock signal lost. Holding last beacon.');
            }
            var count    = white_rabbit.irlock._reconnect_count || 0;
            var delay_ms = Math.min(5000 * Math.pow(2, count), 30000);
            white_rabbit.irlock._reconnect_count = count + 1;
            setTimeout(function () { connect_to_irlock(white_rabbit); }, delay_ms);
            return;
        }

        white_rabbit.irlock.connected  = true;
        white_rabbit.irlock.connecting = false;
        console.log('IRLock: connected at I2C 0x54');
        white_rabbit.logs.irlock.log(white_rabbit, 'IRLock connected at I2C 0x54');

        if (white_rabbit.irlock.disconnect_ts) {
            var dark_s = ((Date.now() - white_rabbit.irlock.disconnect_ts) / 1000).toFixed(0);
            white_rabbit.irlock.disconnect_ts    = null;
            white_rabbit.irlock._reconnect_count = 0;
            console.log('IRLock: reconnected after ' + dark_s + 's');
            white_rabbit.logs.irlock.log(white_rabbit, 'IRLock: reconnected after ' + dark_s + 's');
            if (white_rabbit.voice) white_rabbit.voice.say('IRLock restored.');
        }

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

                // Last beacon angle stays in white_rabbit.irlock_belief — the star
                // still shines. Stamp once, voice once, then backoff reconnect.
                if (!white_rabbit.irlock.disconnect_ts) {
                    white_rabbit.irlock.disconnect_ts = Date.now();
                    white_rabbit.logs.irlock.log(white_rabbit, 'IRLock: I2C read error — holding last beacon: ' + err.message);
                    if (white_rabbit.voice) white_rabbit.voice.say('IRLock signal lost. Holding last beacon.');
                }
                var count    = white_rabbit.irlock._reconnect_count || 0;
                var delay_ms = Math.min(5000 * Math.pow(2, count), 30000);
                white_rabbit.irlock._reconnect_count = count + 1;
                setTimeout(function () { connect_to_irlock(white_rabbit); }, delay_ms);
            }
        }, POLL_INTERVAL_MS);

    } catch (err) {
        console.log('IRLock: connect error —', err.message);
        white_rabbit.irlock.connecting = false;
        white_rabbit.irlock.connected  = false;

        if (!white_rabbit.irlock.disconnect_ts) {
            white_rabbit.irlock.disconnect_ts = Date.now();
            if (white_rabbit.voice) white_rabbit.voice.say('IRLock signal lost. Holding last beacon.');
        }
        var count    = white_rabbit.irlock._reconnect_count || 0;
        var delay_ms = Math.min(5000 * Math.pow(2, count), 30000);
        white_rabbit.irlock._reconnect_count = count + 1;
        setTimeout(function () { connect_to_irlock(white_rabbit); }, delay_ms);
    }
};

module.exports = connect_to_irlock;
