// WitMotion HWT905-TTL — 9-axis IMU / digital compass, over UART (TX/RX serial).
//
// This is an ALTERNATE compass driver, alongside the I2C-based HWT906 (connect_to_witmotion.js)
// and the original BNO055 (connect_to_imu.js, I2C). All three populate the SAME white_rabbit.imu_data
// struct, so everything downstream (get_heading / get_pitch / get_roll / send_imu_to_pixhawk /
// compass_calibration) is unchanged regardless of which is active. Set imu.compass_type back to
// "witmotion" or "bno055" in setup.json to roll back to either of the other two.
//
// PROTOCOL: WitMotion's standard serial output is a stream of fixed 11-byte packets:
//   [0x55][type][d0 d1][d2 d3][d4 d5][d6 d7][checksum]
// where each [dN dN+1] pair is a signed 16-bit little-endian word, and
// checksum = sum(byte0..byte9) & 0xFF. Relevant types (others are ignored):
//   0x51 acceleration     (ax, ay, az, T)     raw/32768*16g
//   0x52 angular velocity (wx, wy, wz, T)     raw/32768*2000 deg/s
//   0x53 angle            (Roll, Pitch, Yaw, T) raw/32768*180 deg
// The device streams all enabled packet types together each output cycle, with Angle (0x53) last
// in WitMotion's default output order (Time, Accel, Gyro, Angle, Mag, ...) — so an Angle packet is
// treated as "this cycle's reading is complete" and publishes heading/quaternion/timestamp, using
// whatever Accel/Gyro values arrived earlier in the same burst.
//
// ORIENTATION: same configurable remap as the I2C HWT906 driver, via imu.witmotion_hwt905:
//   heading_invert  (default true)  negate Yaw so heading increases clockwise like a compass
//   swap_roll_pitch (default false) swap the Roll/Pitch channels if the mount needs it
//   invert_roll / invert_pitch (default false) flip a channel's sign
//   port_path, baud_rate  the TX/RX serial connection (factory default 9600 baud)
// The absolute heading zero-reference is still handled by imu.compass_offset_deg + compass_calibration
// (including the "Hey Noah, set compass to X" voice command), exactly as with the other two drivers.

const WITMOTION_PACKET_HEADER = 0x55;
const WITMOTION_PACKET_LENGTH = 11;

const TYPE_ACCEL = 0x51;
const TYPE_GYRO  = 0x52;
const TYPE_ANGLE = 0x53;

const ANGLE_SCALE = 180.0 / 32768.0;
const ACCEL_SCALE = 16.0 * 9.80665 / 32768.0; // g → m/s²
const GYRO_SCALE  = 2000.0 / 32768.0;
const TEMP_SCALE  = 1.0 / 100.0;

function readInt16LE(buf, offset) {
    const val = buf[offset] | (buf[offset + 1] << 8);
    return val >= 0x8000 ? val - 0x10000 : val;
}

function checksum_ok(packet) {
    let sum = 0;
    for (let i = 0; i < WITMOTION_PACKET_LENGTH - 1; i++) sum += packet[i];
    return (sum & 0xFF) === packet[WITMOTION_PACKET_LENGTH - 1];
}

// Tait-Bryan ZYX (yaw-pitch-roll) Euler → quaternion. Synthesised from the corrected Euler angles,
// same as the I2C HWT906 driver, so downstream consumers get an identical contract regardless of
// which WitMotion variant is wired up. send_imu_to_pixhawk applies compass_offset_deg on top, so we
// pass the RAW heading (no offset), matching the other two drivers' contract.
function euler_to_quaternion(roll_rad, pitch_rad, yaw_rad) {
    const cr = Math.cos(roll_rad / 2),  sr = Math.sin(roll_rad / 2);
    const cp = Math.cos(pitch_rad / 2), sp = Math.sin(pitch_rad / 2);
    const cy = Math.cos(yaw_rad / 2),   sy = Math.sin(yaw_rad / 2);
    return {
        w: cr * cp * cy + sr * sp * sy,
        x: sr * cp * cy - cr * sp * sy,
        y: cr * sp * cy + sr * cp * sy,
        z: cr * cp * sy - sr * sp * cy,
    };
}

var connect_to_witmotion_hwt905 = function (white_rabbit) {
    const cfg = white_rabbit.imu.witmotion_hwt905;

    const heading_sign = cfg.heading_invert === false ? 1 : -1; // default invert (CCW yaw → CW compass)
    const swap_rp       = cfg.swap_roll_pitch === true;
    const roll_sign     = cfg.invert_roll  === true ? -1 : 1;
    const pitch_sign    = cfg.invert_pitch === true ? -1 : 1;

    if (cfg.port_path) {

        cfg.serial = new white_rabbit.SerialPort({ path: cfg.port_path, baudRate: cfg.baud_rate });

        cfg.serial.on('open', function () {

            console.log(`WitMotion HWT905 connected on ${cfg.port_path} @ ${cfg.baud_rate} baud (heading_invert=${heading_sign === -1}, swap_roll_pitch=${swap_rp})`);
            white_rabbit.logs.imu.log(white_rabbit, `WitMotion HWT905 connected on ${cfg.port_path} heading_invert=${heading_sign === -1} swap_roll_pitch=${swap_rp}`);

            white_rabbit.imu_data.connected = true;

            // Accel/gyro arrive as separate packets ahead of the Angle packet in the same burst —
            // held here so the Angle packet can publish a complete reading in one shot.
            const latest = {
                accel: { x: 0, y: 0, z: 0 },
                gyro:  { x: 0, y: 0, z: 0 },
                temperature_c: 0,
            };

            let last_log_ts = 0;
            let _byte_buf = Buffer.alloc(0);

            cfg.serial.on('data', function (chunk) {

                _byte_buf = Buffer.concat([_byte_buf, chunk]);

                while (_byte_buf.length >= WITMOTION_PACKET_LENGTH) {

                    if (_byte_buf[0] !== WITMOTION_PACKET_HEADER) {
                        _byte_buf = _byte_buf.subarray(1);
                        continue;
                    }

                    const packet = _byte_buf.subarray(0, WITMOTION_PACKET_LENGTH);

                    if (!checksum_ok(packet)) {
                        _byte_buf = _byte_buf.subarray(1);
                        continue;
                    }

                    const type = packet[1];

                    if (type === TYPE_ACCEL) {
                        latest.accel.x = readInt16LE(packet, 2) * ACCEL_SCALE;
                        latest.accel.y = readInt16LE(packet, 4) * ACCEL_SCALE;
                        latest.accel.z = readInt16LE(packet, 6) * ACCEL_SCALE;
                        latest.temperature_c = readInt16LE(packet, 8) * TEMP_SCALE;

                    } else if (type === TYPE_GYRO) {
                        latest.gyro.x = readInt16LE(packet, 2) * GYRO_SCALE;
                        latest.gyro.y = readInt16LE(packet, 4) * GYRO_SCALE;
                        latest.gyro.z = readInt16LE(packet, 6) * GYRO_SCALE;

                    } else if (type === TYPE_ANGLE) {
                        const yaw_raw = readInt16LE(packet, 6); // pre-scale register word, for diagnostics
                        let roll_deg  = readInt16LE(packet, 2) * ANGLE_SCALE;
                        let pitch_deg = readInt16LE(packet, 4) * ANGLE_SCALE;
                        const yaw_deg = yaw_raw * ANGLE_SCALE;

                        if (swap_rp) { const t = roll_deg; roll_deg = pitch_deg; pitch_deg = t; }
                        roll_deg  *= roll_sign;
                        pitch_deg *= pitch_sign;

                        // No per-tick rate limiter: the HWT905 outputs a clean absolute heading and a
                        // hand-spin easily exceeds any sane cap, which would compress the reading.
                        const heading_raw = (heading_sign * yaw_deg + 360) % 360;

                        white_rabbit.imu_data.heading_raw = heading_raw;
                        white_rabbit.imu_data.heading = (heading_raw + white_rabbit.imu.compass_offset_deg + 360) % 360;
                        white_rabbit.imu_data.roll  = roll_deg;
                        white_rabbit.imu_data.pitch = pitch_deg;

                        const D2R = Math.PI / 180;
                        white_rabbit.imu_data.quaternion = euler_to_quaternion(roll_deg * D2R, pitch_deg * D2R, heading_raw * D2R);

                        white_rabbit.imu_data.linear_accel = latest.accel;
                        white_rabbit.imu_data.gravity = latest.accel; // HWT905 reports total accel
                        white_rabbit.imu_data.angular_velocity = latest.gyro;
                        white_rabbit.imu_data.temperature_c = latest.temperature_c;

                        // HWT905 is factory-calibrated and reports no live cal status — report "good" so any
                        // downstream cal-status reader treats it as ready (compass_calibration uses heading_raw).
                        white_rabbit.imu_data.calibration = { system: 3, gyro: 3, accel: 3, mag: 3 };

                        white_rabbit.imu_data.timestamp = Date.now();

                        if (white_rabbit.imu_data.timestamp - last_log_ts >= 1000) {
                            last_log_ts = white_rabbit.imu_data.timestamp;
                            // yaw_raw/yaw_deg exposed for scaling diagnosis: spin the rover slowly through a
                            // known angle and confirm yaw_deg tracks 1:1. If a 180° physical turn moves
                            // yaw_deg far less, the magnetometer needs calibration, not a code change.
                            white_rabbit.logs.imu.log(white_rabbit,
                                `WitMotion heading:${white_rabbit.imu_data.heading.toFixed(1)} raw:${white_rabbit.imu_data.heading_raw.toFixed(1)} yaw_deg:${yaw_deg.toFixed(1)} yaw_reg:${yaw_raw} pitch:${white_rabbit.imu_data.pitch.toFixed(1)} roll:${white_rabbit.imu_data.roll.toFixed(1)} temp:${white_rabbit.imu_data.temperature_c.toFixed(1)}c`
                            );

                            console.log( `WitMotion heading:${white_rabbit.imu_data.heading.toFixed(1)} raw:${white_rabbit.imu_data.heading_raw.toFixed(1)} yaw_deg:${yaw_deg.toFixed(1)} yaw_reg:${yaw_raw} pitch:${white_rabbit.imu_data.pitch.toFixed(1)} roll:${white_rabbit.imu_data.roll.toFixed(1)} temp:${white_rabbit.imu_data.temperature_c.toFixed(1)}c`);
                        }
                    }

                    _byte_buf = _byte_buf.subarray(WITMOTION_PACKET_LENGTH);
                }
            });

            white_rabbit.send_imu_to_pixhawk(white_rabbit);
        });

        cfg.serial.on('close', function (e) {
            console.log('WitMotion HWT905 serial close: ', e);
            white_rabbit.imu_data.connected = false;
        });

        cfg.serial.on('error', function (e) {
            console.log('WitMotion HWT905 serial error: ', e);
            white_rabbit.imu_data.connected = false;
        });

    } else {
        console.log('No witmotion_hwt905 port defined');
    }
};

module.exports = connect_to_witmotion_hwt905;
