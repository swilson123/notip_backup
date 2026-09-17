// WitMotion MJRTK-UM982 — dual-antenna RTK GNSS receiver, over USB serial.
//
// This is a SEPARATE device from the two WitMotion compasses already in the tree
// (connect_to_witmotion.js = HWT906 over I2C, connect_to_witmotion_hwt905.js = HWT905 over UART).
// Those populate white_rabbit.imu_data. This one populates white_rabbit.witmotion.received_data
// and is mounted as white_rabbit.connect_to_witmotion_mjrtk so it does not shadow them.
//
// WHAT THIS DEVICE GIVES US
//   position / RTK   from NMEA $--GGA, $--RMC, $--VTG, $--GST
//   heading          from the DUAL-ANTENNA baseline — Unicore #UNIHEADINGA, or NMEA $--THS/$--HDT.
//                    This is a true GNSS heading: it has no magnetometer, so the drivetrain's
//                    magnetic field cannot pull it. That is the reason to prefer it over the
//                    HWT905 for compass duty (see imu.compass_offset_deg churn in CLAUDE.md).
//   pitch            also from the baseline — the vector between the two antennas tilts.
//   roll             NOT OBSERVABLE from two antennas. A 2-antenna baseline is a line, and a line
//                    cannot sense rotation about itself. Roll therefore arrives ONLY if this board
//                    also streams a WitMotion IMU, which uses the same 0x55 11-byte packets the
//                    HWT905 driver already parses — so that path is handled below too, and roll
//                    stays null when the board is GNSS-only. Do not synthesise a roll from GNSS.
//
// THE STREAM IS MIXED. A UM982 emits ASCII sentences ('$' NMEA and '#' Unicore, both \r\n
// terminated) and, if an IMU is present, binary 0x55 frames — interleaved on one wire. The reader
// below walks the byte buffer and dispatches whichever frame starts at the front, resyncing a byte
// at a time when it recognises nothing, exactly like connect_to_ldr.js does for the STL-19P.

const NMEA_START    = 0x24; // '$'
const UNICORE_START = 0x23; // '#'
const WIT_HEADER    = 0x55;
const WIT_PACKET_LENGTH = 11;
const LINE_END      = 0x0A; // '\n'

// A sentence this long is not a sentence — it is a sync that never recovered (usually the wrong
// baud rate). Dropping the buffer keeps memory flat instead of growing until the process dies.
const MAX_BUFFER_BYTES = 4096;

// If nothing valid has parsed by now, say so once, loudly, with the likely cause. Silence is the
// worst failure mode for a serial device: it looks identical to "connected and idle".
const QUIET_STREAM_WARN_MS = 5000;

function witmotion_checksum_ok(packet) {
    let sum = 0;
    for (let i = 0; i < WIT_PACKET_LENGTH - 1; i++) sum += packet[i];
    return (sum & 0xFF) === packet[WIT_PACKET_LENGTH - 1];
}

var connect_to_witmotion = function (white_rabbit) {

    if (!white_rabbit.witmotion.port_path) {
        console.log('No witmotion port defined — set witmotion_mjrtk_comName in setup.json');
        return;
    }

    white_rabbit.witmotion.serial = new white_rabbit.SerialPort({
        path: white_rabbit.witmotion.port_path,
        baudRate: white_rabbit.witmotion.baudrate
    });

    //When port is open
    white_rabbit.witmotion.serial.on('open', function () {

        console.log('Connected to witmotion MJRTK-UM982 on port: ' + white_rabbit.witmotion.port_path + ' @ ' + white_rabbit.witmotion.baudrate + ' baud');
        white_rabbit.logs.witmotion_message_handler.log(white_rabbit, 'Connected to witmotion MJRTK-UM982 on port: ' + white_rabbit.witmotion.port_path + ' @ ' + white_rabbit.witmotion.baudrate + ' baud');

        white_rabbit.witmotion.connected = true;

        // Whatever bytes have arrived but not yet formed a complete frame.
        let _byte_buf = Buffer.alloc(0);

        white_rabbit.witmotion.serial.on('data', function (chunk) {

            _byte_buf = Buffer.concat([_byte_buf, chunk]);

            if (_byte_buf.length > MAX_BUFFER_BYTES) {
                white_rabbit.witmotion.frames_bad++;
                white_rabbit.logs.witmotion_message_handler.log(white_rabbit, 'buffer overrun with no complete frame — dropping ' + _byte_buf.length + ' bytes (wrong baud rate?)');
                _byte_buf = Buffer.alloc(0);
                return;
            }

            while (_byte_buf.length > 0) {

                const start = _byte_buf[0];

                if (start === NMEA_START || start === UNICORE_START) {

                    const line_end = _byte_buf.indexOf(LINE_END);

                    // Sentence still arriving — leave it buffered and wait for the rest.
                    if (line_end === -1) break;

                    const sentence = _byte_buf.subarray(0, line_end).toString('ascii').trim();
                    _byte_buf = _byte_buf.subarray(line_end + 1);

                    if (sentence.length > 0) {
                        white_rabbit.witmotion_message_handler(white_rabbit, sentence);
                    }

                } else if (start === WIT_HEADER) {

                    // Binary IMU frame — only present if this board carries an IMU alongside the GNSS.
                    if (_byte_buf.length < WIT_PACKET_LENGTH) break;

                    const packet = _byte_buf.subarray(0, WIT_PACKET_LENGTH);

                    if (witmotion_checksum_ok(packet)) {
                        white_rabbit.witmotion_message_handler(white_rabbit, packet);
                        _byte_buf = _byte_buf.subarray(WIT_PACKET_LENGTH);
                    } else {
                        // 0x55 was data inside some other frame, not a real header — step past it.
                        _byte_buf = _byte_buf.subarray(1);
                    }

                } else {
                    // Mid-frame garbage or a partial sentence we joined late. Resync one byte at a time.
                    _byte_buf = _byte_buf.subarray(1);
                }
            }
        });

        // One-shot health check rather than a repeating interval: the only question worth asking
        // is "did this port ever speak our language", and the answer does not change after boot.
        setTimeout(function () {
            if (white_rabbit.witmotion.frames_ok === 0) {
                console.log('witmotion MJRTK: no valid frames in ' + QUIET_STREAM_WARN_MS + 'ms on ' + white_rabbit.witmotion.port_path + ' @ ' + white_rabbit.witmotion.baudrate + ' baud. Bytes seen: ' + white_rabbit.witmotion.frames_bad + '. Check witmotion_mjrtk_baudrate in setup.json (UM982 ships at 115200).');
                white_rabbit.logs.witmotion_message_handler.log(white_rabbit, 'no valid frames in ' + QUIET_STREAM_WARN_MS + 'ms — check baud rate');
            }
        }, QUIET_STREAM_WARN_MS);

    });

    white_rabbit.witmotion.serial.on('close', function (e) {

        console.log('white_rabbit.witmotion.serial close: ', e);
        white_rabbit.witmotion.connected = false;

    });

    white_rabbit.witmotion.serial.on('error', function (e) {

        console.log('white_rabbit.witmotion.serial error: ', e);
        white_rabbit.witmotion.connected = false;

    });

};

module.exports = connect_to_witmotion;
