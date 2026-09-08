// One-time (or occasional) magnetometer calibration for the WitMotion HWT905-TTL compass.
//
// This is a STANDALONE script — run it directly, not as part of notip's mission boot:
//   node lib/imu/calibrate_witmotion_compass.js
//
// It talks to the sensor over serial by itself (reusing port_path/baud_rate from setup.json)
// and does NOT touch motors, GPS, Pixhawk, or anything else — safe to run any time server.js
// is stopped.
//
// Why this exists: connect_to_witmotion_hwt905.js runs Noah in the chip's 9-axis algorithm,
// where Yaw is fused from the onboard magnetometer and stays absolute across power cycles
// (see assert_algorithm() there). But per WitMotion's manual (2.3.2, "Magnetic Field
// Calibration"), the magnetometer has a large factory zero-bias error until it's calibrated
// once — physically rotating the assembled rover so the chip samples the local field from
// every direction. That physical step can't be automated; this script walks you through it.
//
// Do this with the rover FULLY assembled (motors, motor drivers, battery, all wiring in its
// final position) — those are exactly the hard-iron sources the calibration needs to null out,
// and moving them afterward (rewiring, new mount) means redoing this.
//
// Protocol source: WitMotion's own SDK, WITMOTION/WitStandardProtocol_JY901,
// Linux_C/normal/REG.h. Frame format: [0xFF][0xAA][register][value_low][value_high].

'use strict';
const fs         = require('fs');
const path       = require('path');
const readline   = require('readline');
const { SerialPort } = require('serialport');

const SETUP_PATH = path.join(__dirname, '../../setup.json');

const REG_KEY   = 0x69;
const REG_CALSW = 0x01;
const REG_SAVE  = 0x00;
const KEY_UNLOCK      = 0xB588;
const CALSW_NORMAL    = 0x0000;
const CALSW_MAG2STEP  = 0x0009; // dual-plane magnetic calibration — WitMotion's recommended method for HWT905 in 9-axis mode
const SAVE_PARAM      = 0x0000;
const CMD_GAP_MS      = 250;

const DEFAULT_DURATION_S = 60;

function wit_write_reg(serial, reg, value) {
    serial.write(Buffer.from([0xFF, 0xAA, reg, value & 0xFF, (value >> 8) & 0xFF]));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function ask(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
    const duration_s = Number(process.argv[2]) || DEFAULT_DURATION_S;

    const setup = JSON.parse(fs.readFileSync(SETUP_PATH, 'utf8'));
    const port_path = setup.witmotion_hwt905_comName;
    const baud_rate = (setup.imu && setup.imu.witmotion_hwt905 && setup.imu.witmotion_hwt905.baud_rate) || 9600;

    if (!port_path) {
        console.error('setup.json has no witmotion_hwt905_comName — nothing to calibrate.');
        process.exit(1);
    }

    console.log('WitMotion HWT905 magnetic field calibration');
    console.log('Port: ' + port_path + ' @ ' + baud_rate + ' baud');
    console.log('');
    console.log('Before continuing:');
    console.log('  1. The rover must be FULLY assembled — motors, drivers, battery, wiring all in place.');
    console.log('  2. Stop server.js / notip.service first — this script needs the serial port to itself.');
    console.log('  3. Find open space clear of large metal objects, rebar, vehicles, etc.');
    console.log('  4. When calibration starts you will have ' + duration_s + ' seconds to slowly rotate');
    console.log('     the rover through at least 2-3 full 360° turns, AND tip it through a second plane');
    console.log('     (nose up/down through ~90°) a few times too — this is the "dual-plane" method.');
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await ask(rl, 'Ready to start? (y/n) ');
    if (answer.trim().toLowerCase() !== 'y') {
        console.log('Aborted — nothing was sent to the sensor.');
        rl.close();
        process.exit(0);
    }

    const serial = new SerialPort({ path: port_path, baudRate: baud_rate });

    await new Promise((resolve, reject) => {
        serial.on('open', resolve);
        serial.on('error', reject);
    });
    console.log('Serial port open.');

    wit_write_reg(serial, REG_KEY, KEY_UNLOCK);
    await sleep(CMD_GAP_MS);
    wit_write_reg(serial, REG_CALSW, CALSW_MAG2STEP);
    console.log('Calibration mode entered. Rotate the rover now...');

    for (let remaining = duration_s; remaining > 0; remaining -= 5) {
        await sleep(Math.min(5000, remaining * 1000));
        console.log('  ' + Math.max(0, remaining - 5) + 's remaining...');
    }

    wit_write_reg(serial, REG_KEY, KEY_UNLOCK);
    await sleep(CMD_GAP_MS);
    wit_write_reg(serial, REG_CALSW, CALSW_NORMAL);
    await sleep(CMD_GAP_MS);
    wit_write_reg(serial, REG_SAVE, SAVE_PARAM);
    await sleep(CMD_GAP_MS);

    console.log('Calibration ended and saved to flash.');
    console.log('Restart server.js / notip.service to reconnect and verify heading is stable across a power cycle.');

    rl.close();
    serial.close(() => process.exit(0));
}

main().catch(err => {
    console.error('Calibration failed:', err && err.message);
    process.exit(1);
});
