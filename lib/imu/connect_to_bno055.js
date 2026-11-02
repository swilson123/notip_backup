// Two Bosch BNO055s on I2C bus 1 — 0x28 (ADR low) and 0x29 (ADR jumpered to 3.3V).
//
// These are WITNESSES, not the compass. get_heading still reads the HWT905 through
// white_rabbit.imu_data. The BNO055s exist to answer one question: when Noah's heading jumps,
// does ONE compass jump (that sensor / its I2C link is bad — a median would fix it) or do ALL
// compasses jump together (the field around Noah changed — motors, a car, rebar — and no vote
// can fix it)? compass_watch.js compares all three after every poll.
//
// Each sensor gets its own offset_deg, set from the car compass on undock (and by the
// "set compass" voice command) in compass_calibration.set_heading. Until that first sync the
// raw headings point nowhere in particular, so compass_watch ignores an unsynced sensor.
//
// The rollback BNO055 driver (connect_to_imu.js) also lives at 0x28. connect_to_devices never
// starts this one when imu.compass_type === "bno055", so the two never share a chip.
//
// I2C: openPromisified + recursive setTimeout, never setInterval. The BNO055 stretches the
// I2C clock, which the Pi handles badly; a slow read must finish before the next one starts.

const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const BNO055_CHIP_ID = 0xA0;

const REG_CHIP_ID        = 0x00;
const REG_PAGE_ID        = 0x07;
const REG_GYR_DATA_X_LSB = 0x14; // gyro x,y,z (1/16 deg/s) then Euler heading,roll,pitch (1/16 deg) — 12 contiguous bytes
const REG_CALIB_STAT     = 0x35; // bits[7:6]=sys [5:4]=gyro [3:2]=accel [1:0]=mag, 3=fully cal
const REG_UNIT_SEL       = 0x3B;
const REG_OPR_MODE       = 0x3D;
const REG_PWR_MODE       = 0x3E;
const REG_CAL_DATA_START = 0x55; // 0x55..0x6A — 22 bytes of accel/mag/gyro offsets + radii

const MODE_CONFIG = 0x00;
const MODE_NDOF   = 0x0C; // 9-DOF absolute orientation fusion
const PWR_NORMAL  = 0x00;

const CAL_DATA_LENGTH = 22;

function cal_file_path(sensor) {
    return path.resolve(process.cwd(), `bno055_calibration_0x${sensor.address.toString(16)}.json`);
}

function readInt16LE(buf, offset) {
    const val = buf[offset] | (buf[offset + 1] << 8);
    return val >= 0x8000 ? val - 0x10000 : val;
}

function load_saved_calibration(sensor) {
    try {
        if (!fs.existsSync(cal_file_path(sensor))) return null;
        const data = JSON.parse(fs.readFileSync(cal_file_path(sensor), 'utf8'));
        if (!Array.isArray(data.bytes) || data.bytes.length !== CAL_DATA_LENGTH) return null;
        return Buffer.from(data.bytes);
    } catch (e) {
        console.log(`${sensor.name}: failed to load saved calibration:`, e.message);
        return null;
    }
}

function save_calibration_to_disk(sensor, buf) {
    try {
        fs.writeFileSync(cal_file_path(sensor), JSON.stringify({ saved_at: new Date().toISOString(), bytes: Array.from(buf) }, null, 2));
        return true;
    } catch (e) {
        console.log(`${sensor.name}: failed to save calibration:`, e.message);
        return false;
    }
}

async function start_sensor(white_rabbit, sensor) {
    const id = Buffer.alloc(1);
    try {
        await white_rabbit.bno055.bus.readI2cBlock(sensor.address, REG_CHIP_ID, 1, id);
    } catch (err) {
        if (!sensor.missing_logged) {
            sensor.missing_logged = true;
            console.log(`${sensor.name}: no device on I2C bus 1 — ${err.message}`);
            white_rabbit.logs.imu.log(white_rabbit, `${sensor.name}: no device on I2C bus 1 — ${err.message}`);
        }
        return;
    }
    if (id[0] !== BNO055_CHIP_ID) {
        console.log(`${sensor.name}: wrong chip_id 0x${id[0].toString(16)} — not a BNO055`);
        return;
    }

    await white_rabbit.bno055.bus.writeByte(sensor.address, REG_OPR_MODE, MODE_CONFIG);
    await sleep(25);
    await white_rabbit.bno055.bus.writeByte(sensor.address, REG_PAGE_ID, 0x00);
    await white_rabbit.bno055.bus.writeByte(sensor.address, REG_PWR_MODE, PWR_NORMAL);
    await white_rabbit.bno055.bus.writeByte(sensor.address, REG_UNIT_SEL, 0x00); // degrees, m/s², deg/s, Celsius
    await sleep(10);

    const saved_cal = load_saved_calibration(sensor);
    if (saved_cal) {
        await white_rabbit.bno055.bus.writeI2cBlock(sensor.address, REG_CAL_DATA_START, CAL_DATA_LENGTH, saved_cal);
        await sleep(25);
    }
    // Restored from disk → don't auto-resave; delete the JSON file to force a fresh calibration.
    sensor.calibration_saved = saved_cal !== null;

    await white_rabbit.bno055.bus.writeByte(sensor.address, REG_OPR_MODE, MODE_NDOF);
    await sleep(25);

    sensor.connected = true;
    sensor.missing_logged = false;
    const msg = `${sensor.name}: connected${saved_cal ? ', restored saved calibration' : ' — will save calibration when sys=3'}`;
    console.log(msg);
    white_rabbit.logs.imu.log(white_rabbit, msg);
}

async function read_sensor(white_rabbit, sensor) {
    const data = Buffer.alloc(12);
    const cal  = Buffer.alloc(1);
    await white_rabbit.bno055.bus.readI2cBlock(sensor.address, REG_GYR_DATA_X_LSB, 12, data);
    await white_rabbit.bno055.bus.readI2cBlock(sensor.address, REG_CALIB_STAT, 1, cal);

    sensor.gyro_z      = readInt16LE(data, 4) / 16.0;
    sensor.heading_raw = (readInt16LE(data, 6) / 16.0 + 360) % 360;
    sensor.heading     = (sensor.heading_raw + sensor.offset_deg + 360) % 360;
    sensor.roll        = readInt16LE(data, 8) / 16.0;
    sensor.pitch       = readInt16LE(data, 10) / 16.0;

    const mag = cal[0] & 0x03;
    // A mag calibration change is the BNO055 re-deciding where north is — exactly the moment a
    // heading snap shows up, so it is logged as an event, not just carried in the 1 s summary.
    if (sensor.calibration.mag !== mag && sensor.timestamp !== null) {
        white_rabbit.logs.imu.log(white_rabbit, `${sensor.name}: mag calibration ${sensor.calibration.mag} → ${mag}`);
    }
    sensor.calibration = {
        system: (cal[0] >> 6) & 0x03,
        gyro:   (cal[0] >> 4) & 0x03,
        accel:  (cal[0] >> 2) & 0x03,
        mag:    mag
    };
    sensor.timestamp = Date.now();

    if (!sensor.calibration_saved && sensor.calibration.system === 3) {
        const cal_data = Buffer.alloc(CAL_DATA_LENGTH);
        await white_rabbit.bno055.bus.readI2cBlock(sensor.address, REG_CAL_DATA_START, CAL_DATA_LENGTH, cal_data);
        if (save_calibration_to_disk(sensor, cal_data)) {
            sensor.calibration_saved = true;
            white_rabbit.logs.imu.log(white_rabbit, `${sensor.name}: saved calibration to ${cal_file_path(sensor)}`);
        }
    }
}

async function poll(white_rabbit) {
    for (const sensor of white_rabbit.bno055.sensors) {
        if (!sensor.connected) continue;
        try {
            await read_sensor(white_rabbit, sensor);
        } catch (err) {
            // connect_to_devices retries a dropped sensor every 5 s.
            sensor.connected = false;
            console.log(`${sensor.name}: read error — ${err.message}`);
            white_rabbit.logs.imu.log(white_rabbit, `${sensor.name}: read error — ${err.message}`);
        }
    }
    white_rabbit.compass_watch(white_rabbit);
}

var connect_to_bno055 = async function (white_rabbit) {
    if (white_rabbit.bno055.connecting) return;
    white_rabbit.bno055.connecting = true;

    try {
        if (!white_rabbit.bno055.bus) {
            white_rabbit.bno055.bus = await white_rabbit.i2c.openPromisified(1);
        }
        for (const sensor of white_rabbit.bno055.sensors) {
            if (sensor.connected) continue;
            try {
                await start_sensor(white_rabbit, sensor);
            } catch (err) {
                console.log(`${sensor.name}: connect error — ${err.message}`);
            }
        }

        if (!white_rabbit.bno055.poll_timer && white_rabbit.bno055.sensors.some(s => s.connected)) {
            const tick_fn = () => {
                poll(white_rabbit)
                    .catch(err => console.log('BNO055 poll error:', err.message))
                    .finally(() => {
                        white_rabbit.bno055.poll_timer = white_rabbit.bno055.sensors.some(s => s.connected)
                            ? setTimeout(tick_fn, white_rabbit.bno055.poll_interval_ms)
                            : null;
                    });
            };
            white_rabbit.bno055.poll_timer = setTimeout(tick_fn, white_rabbit.bno055.poll_interval_ms);
        }
    } catch (err) {
        console.log('BNO055: bus open error —', err.message);
    } finally {
        white_rabbit.bno055.connecting = false;
    }
};

module.exports = connect_to_bno055;
