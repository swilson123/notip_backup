// WitMotion HWT906 — high-precision industrial inclinometer / digital compass / gyro, over I2C (SDA/SCL).
//
// This is an ALTERNATE compass driver. The original BNO055 driver lives in connect_to_imu.js and is
// left fully intact for rollback: set imu.compass_type back to "bno055" in setup.json to use it again.
// Both drivers populate the SAME white_rabbit.imu_data struct, so everything downstream
// (get_heading / get_pitch / get_roll / send_imu_to_pixhawk / compass_calibration) is unchanged.
//
// ORIENTATION: the HWT906 is mounted flipped relative to the old compass — its X axis points
// forward/back and its Y axis points left/right. WitMotion defines Roll about X, Pitch about Y,
// Yaw about Z (right-hand rule, so Yaw is counter-clockwise-positive while a compass heading is
// clockwise-positive). The orientation is therefore fully configurable via imu.witmotion:
//   heading_invert  (default true)  negate Yaw so heading increases clockwise like a compass
//   swap_roll_pitch (default false) swap the Roll/Pitch channels if the mount needs it
//   invert_roll / invert_pitch (default false) flip a channel's sign
//   i2c_address     (default 0x50)  WitMotion default 7-bit address
// The absolute heading zero-reference is still handled by imu.compass_offset_deg + compass_calibration
// (including the "Hey Noah, set compass to X" voice command), exactly as with the BNO055.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const WITMOTION_DEFAULT_ADDRESS = 0x50;

// WitMotion data registers — each holds one signed 16-bit little-endian word.
const REG_AX   = 0x34; // 0x34..0x36 accel  x,y,z   (raw / 32768 * 16 g)
const REG_GX   = 0x37; // 0x37..0x39 gyro   x,y,z   (raw / 32768 * 2000 °/s)
const REG_HX   = 0x3A; // 0x3A..0x3C mag    x,y,z   (raw counts)
const REG_ROLL = 0x3D; // 0x3D Roll, 0x3E Pitch, 0x3F Yaw  (raw / 32768 * 180 °)
const REG_TEMP = 0x40; // temperature (raw / 100 °C)

const ANGLE_SCALE = 180.0 / 32768.0;
const ACCEL_SCALE = 16.0 * 9.80665 / 32768.0; // g → m/s²
const GYRO_SCALE  = 2000.0 / 32768.0;

function readInt16LE(buf, offset) {
    const val = buf[offset] | (buf[offset + 1] << 8);
    return val >= 0x8000 ? val - 0x10000 : val;
}

// Tait-Bryan ZYX (yaw-pitch-roll) Euler → quaternion. We synthesise the quaternion from the
// corrected Euler angles rather than reading the WitMotion quaternion registers, so it stays
// consistent with the orientation remapping above and doesn't depend on the device's quaternion
// output being enabled. send_imu_to_pixhawk applies compass_offset_deg on top, so we pass the
// RAW heading (no offset), matching the BNO055 contract.
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

var connect_to_witmotion = function (white_rabbit) {
    const cfg = (white_rabbit.imu && white_rabbit.imu.witmotion) || {};
    const address       = typeof cfg.i2c_address === 'number' ? cfg.i2c_address : WITMOTION_DEFAULT_ADDRESS;
    const heading_sign  = cfg.heading_invert === false ? 1 : -1; // default invert (CCW yaw → CW compass)
    const swap_rp       = cfg.swap_roll_pitch === true;
    const roll_sign     = cfg.invert_roll  === true ? -1 : 1;
    const pitch_sign    = cfg.invert_pitch === true ? -1 : 1;

    try {
        const bus = white_rabbit.i2c.openSync(1);

        // No reliable WHO_AM_I on WitMotion; a successful angle read is our connection proof.
        const probeBuf = Buffer.alloc(6);
        bus.readI2cBlockSync(address, REG_ROLL, 6, probeBuf);

        white_rabbit.imu_data.connected = true;
        console.log(`WitMotion HWT906 connected at 0x${address.toString(16)} (heading_invert=${heading_sign === -1}, swap_roll_pitch=${swap_rp})`);
        white_rabbit.logs.imu.log(white_rabbit, `WitMotion HWT906 connected at 0x${address.toString(16)} heading_invert=${heading_sign === -1} swap_roll_pitch=${swap_rp}`);

        const angBuf = Buffer.alloc(6);
        const accBuf = Buffer.alloc(6);
        const gyrBuf = Buffer.alloc(6);
        const tmpBuf = Buffer.alloc(2);

        let last_log_ts = 0;
        let last_guard_log_ts = 0;
        let prev_raw_heading = null;
        // Cap heading change per 50 ms tick (10° ≈ 200°/s — never interferes with deliberate yaw,
        // but rejects single-tick I2C glitches). The HWT906's fusion is clean so this rarely fires.
        const HDG_TICK_CAP = 10.0;

        white_rabbit.imu_data.poll_interval = setInterval(() => {
            try {
                bus.readI2cBlockSync(address, REG_ROLL, 6, angBuf);
                bus.readI2cBlockSync(address, REG_AX,   6, accBuf);
                bus.readI2cBlockSync(address, REG_GX,   6, gyrBuf);
                bus.readI2cBlockSync(address, REG_TEMP, 2, tmpBuf);

                let roll_deg  = readInt16LE(angBuf, 0) * ANGLE_SCALE;
                let pitch_deg = readInt16LE(angBuf, 2) * ANGLE_SCALE;
                const yaw_deg = readInt16LE(angBuf, 4) * ANGLE_SCALE;

                if (swap_rp) { const t = roll_deg; roll_deg = pitch_deg; pitch_deg = t; }
                roll_deg  *= roll_sign;
                pitch_deg *= pitch_sign;

                const raw_new = (heading_sign * yaw_deg + 360) % 360;

                let guarded_raw;
                if (prev_raw_heading !== null) {
                    const diff = ((raw_new - prev_raw_heading + 540) % 360) - 180;
                    if (Math.abs(diff) > HDG_TICK_CAP) {
                        const capped = (diff > 0 ? 1 : -1) * HDG_TICK_CAP;
                        guarded_raw  = ((prev_raw_heading + capped) + 360) % 360;
                        const now = Date.now();
                        if (now - last_guard_log_ts >= 1000) {
                            last_guard_log_ts = now;
                            console.log(`WitMotion jump guard: raw ${prev_raw_heading.toFixed(1)}→${raw_new.toFixed(1)}° (${diff > 0 ? '+' : ''}${diff.toFixed(1)}°) capped to ${capped > 0 ? '+' : ''}${capped.toFixed(1)}°`);
                            white_rabbit.logs.imu.log(white_rabbit, `WitMotion jump guard: raw ${prev_raw_heading.toFixed(1)}→${raw_new.toFixed(1)}° diff=${diff.toFixed(1)}° capped=${capped.toFixed(1)}°`);
                        }
                    } else {
                        guarded_raw = raw_new;
                    }
                } else {
                    guarded_raw = raw_new;
                }
                prev_raw_heading = guarded_raw;

                white_rabbit.imu_data.heading_raw = guarded_raw;
                white_rabbit.imu_data.heading = (guarded_raw + white_rabbit.imu.compass_offset_deg + 360) % 360;
                white_rabbit.imu_data.roll  = roll_deg;
                white_rabbit.imu_data.pitch = pitch_deg;

                const D2R = Math.PI / 180;
                white_rabbit.imu_data.quaternion = euler_to_quaternion(roll_deg * D2R, pitch_deg * D2R, guarded_raw * D2R);

                white_rabbit.imu_data.linear_accel = {
                    x: readInt16LE(accBuf, 0) * ACCEL_SCALE,
                    y: readInt16LE(accBuf, 2) * ACCEL_SCALE,
                    z: readInt16LE(accBuf, 4) * ACCEL_SCALE,
                };
                white_rabbit.imu_data.gravity = white_rabbit.imu_data.linear_accel; // HWT906 reports total accel
                white_rabbit.imu_data.angular_velocity = {
                    x: readInt16LE(gyrBuf, 0) * GYRO_SCALE,
                    y: readInt16LE(gyrBuf, 2) * GYRO_SCALE,
                    z: readInt16LE(gyrBuf, 4) * GYRO_SCALE,
                };
                white_rabbit.imu_data.temperature_c = readInt16LE(tmpBuf, 0) / 100.0;

                // HWT906 is factory-calibrated and reports no live cal status — report "good" so any
                // downstream cal-status reader treats it as ready (compass_calibration uses heading_raw).
                white_rabbit.imu_data.calibration = { system: 3, gyro: 3, accel: 3, mag: 3 };

                white_rabbit.imu_data.timestamp = Date.now();

                if (white_rabbit.imu_data.timestamp - last_log_ts >= 1000) {
                    last_log_ts = white_rabbit.imu_data.timestamp;
                    white_rabbit.logs.imu.log(white_rabbit,
                        `WitMotion heading:${white_rabbit.imu_data.heading.toFixed(1)} pitch:${white_rabbit.imu_data.pitch.toFixed(1)} roll:${white_rabbit.imu_data.roll.toFixed(1)} temp:${white_rabbit.imu_data.temperature_c.toFixed(1)}c`
                    );
                    console.log(`WitMotion IMU: heading=${white_rabbit.imu_data.heading.toFixed(1)} pitch=${white_rabbit.imu_data.pitch.toFixed(1)} roll=${white_rabbit.imu_data.roll.toFixed(1)} temp=${white_rabbit.imu_data.temperature_c.toFixed(1)}C`);
                }

            } catch (err) {
                console.log('WitMotion read error:', err.message);
                white_rabbit.imu_data.connected = false;
                clearInterval(white_rabbit.imu_data.poll_interval);
            }
        }, 50);

        white_rabbit.send_imu_to_pixhawk(white_rabbit);

    } catch (err) {
        console.log('WitMotion connect error:', err.message);
        white_rabbit.imu_data.connected = false;
    }
};

module.exports = connect_to_witmotion;
