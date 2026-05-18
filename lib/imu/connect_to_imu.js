// Calibration is now persisted automatically. On the first boot after the sensor reaches
// full calibration (sys=3), its internal calibration registers (0x55-0x6A: accel/mag/gyro
// offsets + radii) are written to bno055_calibration.json. On every subsequent boot the
// saved data is restored before fusion starts, so the heading is consistent across reboots
// and the compass_offset_deg in setup.json remains valid. Delete the JSON file to force
// a fresh calibration (e.g. after relocating the rover to a different magnetic environment).

const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const BNO055_ADDRESS    = 0x28;
const BNO055_CHIP_ID    = 0xA0;

const REG_CHIP_ID       = 0x00;
const REG_PAGE_ID       = 0x07;
const REG_EUL_DATA_X_LSB = 0x1A; // heading, roll, pitch (6 bytes, 1/16 deg/LSB)
const REG_QUA_DATA_W_LSB = 0x20; // w, x, y, z (8 bytes, 1/16384 per LSB)
const REG_LIA_DATA_X_LSB = 0x28; // linear accel x, y, z (6 bytes, 1/100 m/s²/LSB)
const REG_GRV_DATA_X_LSB = 0x2E; // gravity vector x, y, z (6 bytes, 1/100 m/s²/LSB)
const REG_TEMP           = 0x34;
const REG_CALIB_STAT     = 0x35; // bits[7:6]=sys [5:4]=gyro [3:2]=accel [1:0]=mag, 3=fully cal
const REG_UNIT_SEL       = 0x3B;
const REG_OPR_MODE       = 0x3D;
const REG_PWR_MODE       = 0x3E;
const REG_SYS_TRIGGER    = 0x3F;
const REG_CAL_DATA_START = 0x55; // 0x55..0x6A — 22 bytes of accel/mag/gyro offsets + radii

const MODE_CONFIG = 0x00;
const MODE_NDOF   = 0x0C; // 9-DOF absolute orientation fusion
const PWR_NORMAL  = 0x00;

const CAL_DATA_LENGTH = 22;
const CAL_FILE_PATH = path.resolve(process.cwd(), 'bno055_calibration.json');

function load_saved_calibration() {
    try {
        if (!fs.existsSync(CAL_FILE_PATH)) return null;
        const data = JSON.parse(fs.readFileSync(CAL_FILE_PATH, 'utf8'));
        if (!Array.isArray(data.bytes) || data.bytes.length !== CAL_DATA_LENGTH) return null;
        return Buffer.from(data.bytes);
    } catch (e) {
        console.log('BNO055: failed to load saved calibration:', e.message);
        return null;
    }
}

function save_calibration_to_disk(buf) {
    try {
        const payload = {
            saved_at: new Date().toISOString(),
            bytes: Array.from(buf),
        };
        fs.writeFileSync(CAL_FILE_PATH, JSON.stringify(payload, null, 2));
        return true;
    } catch (e) {
        console.log('BNO055: failed to save calibration:', e.message);
        return false;
    }
}

function readInt16LE(buf, offset) {
    const val = buf[offset] | (buf[offset + 1] << 8);
    return val >= 0x8000 ? val - 0x10000 : val;
}

var connect_to_imu = async function (rover) {
    const address = BNO055_ADDRESS;

    try {
        const bus = rover.i2c.openSync(1);

        // Verify chip ID
        const idBuf = Buffer.alloc(1);
        bus.readI2cBlockSync(address, REG_CHIP_ID, 1, idBuf);
        if (idBuf[0] !== BNO055_CHIP_ID) {
            console.log(`BNO055 not found at 0x${address.toString(16)} (chip_id=0x${idBuf[0].toString(16)})`);
            rover.imu_data.connected = false;
            return;
        }

        // Switch to config mode, configure, optionally restore calibration, then enter NDOF fusion
        bus.writeByteSync(address, REG_OPR_MODE, MODE_CONFIG);
        await sleep(25);
        bus.writeByteSync(address, REG_PAGE_ID, 0x00);
        bus.writeByteSync(address, REG_PWR_MODE, PWR_NORMAL);
        bus.writeByteSync(address, REG_UNIT_SEL, 0x00); // degrees, m/s², deg/s, Celsius
        await sleep(10);

        const saved_cal = load_saved_calibration();
        if (saved_cal) {
            bus.writeI2cBlockSync(address, REG_CAL_DATA_START, CAL_DATA_LENGTH, saved_cal);
            await sleep(25);
            console.log('BNO055: restored saved calibration from disk');
            rover.logs.imu.log(rover, 'BNO055: restored saved calibration from disk');
        } else {
            console.log('BNO055: no saved calibration on disk — will save when sensor reaches full cal (sys=3)');
            rover.logs.imu.log(rover, 'BNO055: no saved calibration on disk — will save when sensor reaches full cal (sys=3)');
        }

        bus.writeByteSync(address, REG_OPR_MODE, MODE_NDOF);
        await sleep(25);

        rover.imu_data.connected = true;
        console.log(`BNO055 IMU connected at 0x${address.toString(16)}`);

        const eulBuf = Buffer.alloc(6);
        const quaBuf = Buffer.alloc(8);
        const liaBuf = Buffer.alloc(6);
        const grvBuf = Buffer.alloc(6);
        const tmpBuf = Buffer.alloc(1);
        const calBuf = Buffer.alloc(1);
        const calDataBuf = Buffer.alloc(CAL_DATA_LENGTH);

        let last_log_ts = 0;
        // If we already restored from disk we don't auto-resave; delete the file to force a refresh.
        let calibration_saved_this_session = saved_cal !== null;

        rover.imu_data.poll_interval = setInterval(() => {
            try {
                bus.readI2cBlockSync(address, REG_EUL_DATA_X_LSB, 6, eulBuf);
                bus.readI2cBlockSync(address, REG_QUA_DATA_W_LSB, 8, quaBuf);
                bus.readI2cBlockSync(address, REG_LIA_DATA_X_LSB, 6, liaBuf);
                bus.readI2cBlockSync(address, REG_GRV_DATA_X_LSB, 6, grvBuf);
                bus.readI2cBlockSync(address, REG_TEMP, 1, tmpBuf);
                bus.readI2cBlockSync(address, REG_CALIB_STAT, 1, calBuf);

                const calib = calBuf[0];

                rover.imu_data.heading = (readInt16LE(eulBuf, 0) / 16.0 + rover.imu.compass_offset_deg + 360) % 360;
                rover.imu_data.roll    = readInt16LE(eulBuf, 2) / 16.0;
                rover.imu_data.pitch   = readInt16LE(eulBuf, 4) / 16.0;

                rover.imu_data.quaternion = {
                    w: readInt16LE(quaBuf, 0) / 16384.0,
                    x: readInt16LE(quaBuf, 2) / 16384.0,
                    y: readInt16LE(quaBuf, 4) / 16384.0,
                    z: readInt16LE(quaBuf, 6) / 16384.0,
                };

                rover.imu_data.linear_accel = {
                    x: readInt16LE(liaBuf, 0) / 100.0,
                    y: readInt16LE(liaBuf, 2) / 100.0,
                    z: readInt16LE(liaBuf, 4) / 100.0,
                };

                rover.imu_data.gravity = {
                    x: readInt16LE(grvBuf, 0) / 100.0,
                    y: readInt16LE(grvBuf, 2) / 100.0,
                    z: readInt16LE(grvBuf, 4) / 100.0,
                };

                rover.imu_data.temperature_c = tmpBuf[0];

                rover.imu_data.calibration = {
                    system: (calib >> 6) & 0x03,
                    gyro:   (calib >> 4) & 0x03,
                    accel:  (calib >> 2) & 0x03,
                    mag:    (calib >> 0) & 0x03,
                };

                // Save the BNO055's internal calibration registers to disk the first time the
                // sensor reaches full system calibration this session. Restore happens on boot
                // before NDOF mode, so subsequent reboots use the same calibration immediately.
                if (!calibration_saved_this_session && rover.imu_data.calibration.system === 3) {
                    try {
                        bus.readI2cBlockSync(address, REG_CAL_DATA_START, CAL_DATA_LENGTH, calDataBuf);
                        if (save_calibration_to_disk(calDataBuf)) {
                            calibration_saved_this_session = true;
                            console.log('BNO055: saved calibration to ' + CAL_FILE_PATH);
                            rover.logs.imu.log(rover, 'BNO055: saved calibration to ' + CAL_FILE_PATH);
                        }
                    } catch (err) {
                        console.log('BNO055: error reading cal registers:', err.message);
                    }
                }

                rover.imu_data.timestamp = Date.now();

                if (rover.imu_data.timestamp - last_log_ts >= 1000) {
                    last_log_ts = rover.imu_data.timestamp;
                    const c = rover.imu_data.calibration;
                    rover.logs.imu.log(rover,
                        `heading:${rover.imu_data.heading.toFixed(1)} pitch:${rover.imu_data.pitch.toFixed(1)} roll:${rover.imu_data.roll.toFixed(1)} ` +
                        `temp:${rover.imu_data.temperature_c}c cal(sys:${c.system} gyro:${c.gyro} accel:${c.accel} mag:${c.mag})`
                    );
                    console.log(`IMU: heading=${rover.imu_data.heading.toFixed(1)} pitch=${rover.imu_data.pitch.toFixed(1)} roll=${rover.imu_data.roll.toFixed(1)} ` +
                        `temp=${rover.imu_data.temperature_c}C calib(sys:${c.system} gyro:${c.gyro} accel:${c.accel} mag:${c.mag})`
                    );
                }

            } catch (err) {
                console.log('BNO055 read error:', err.message);
                rover.imu_data.connected = false;
                clearInterval(rover.imu_data.poll_interval);
            }
        }, 50);

        rover.send_imu_to_pixhawk(rover);

    } catch (err) {
        console.log('BNO055 connect error:', err.message);
        rover.imu_data.connected = false;
    }
};

module.exports = connect_to_imu;
