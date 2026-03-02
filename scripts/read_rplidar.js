#!/usr/bin/env node
"use strict";

// Minimal RPLIDAR reader script using serialport (v9+ / v10+ / v13+ compatible)
// Usage: node scripts/read_rplidar.js --port /dev/ttyUSB0 [--baud 115200] [--parse]
// --parse : attempt to parse 5-byte standard scan nodes into (quality, angle, distance_mm)

const { SerialPort } = require('serialport');
const { ByteLengthParser } = require('@serialport/parser-byte-length');

function usage() {
  console.log('Usage: node scripts/read_rplidar.js --port /dev/ttyUSB0 [--baud 115200] [--parse] [--outfile file.log]');
  process.exit(1);
}

// Simple CLI parse
const argv = require('process').argv.slice(2);
let portPath = null;
let baudRate = 115200;
let doParse = false;
let outFile = null;
let justPing = false;
let cmdHex = null;
let timeoutSec = 6;
let doProbe = false;
let doProbeAll = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port' && argv[i + 1]) { portPath = argv[++i]; }
  else if (a === '--baud' && argv[i + 1]) { baudRate = parseInt(argv[++i], 10); }
  else if (a === '--parse') { doParse = true; }
  else if (a === '--outfile' && argv[i + 1]) { outFile = argv[++i]; }
  else if (a === '--info') { cmdHex = '50'; justPing = true; }
  else if (a === '--health') { cmdHex = '52'; justPing = true; }
  else if (a === '--cmd' && argv[i + 1]) { cmdHex = argv[++i]; justPing = true; }
  else if (a === '--timeout' && argv[i + 1]) { timeoutSec = parseInt(argv[++i], 10) || timeoutSec; }
  else if (a === '--probe' || a === '--autoprobe') { doProbe = true; }
  else if (a === '--probe-all') { doProbeAll = true; doProbe = true; }
  else if (a === '--help' || a === '-h') usage();
  else {
    console.warn('Unknown arg', a);
  }
}

// Allow --probe without --port; require --port only when not probing
if (!portPath && !doProbe) usage();

const fs = require('fs');
const outStream = outFile ? fs.createWriteStream(outFile, { flags: 'a' }) : null;

const SCAN_CMD = Buffer.from([0xA5, 0x20]);
const STOP_CMD = Buffer.from([0xA5, 0x25]);
const INFO_CMD = Buffer.from([0xA5, 0x50]);
const HEALTH_CMD = Buffer.from([0xA5, 0x52]);

function hex(buf) { return Array.from(buf).map(b => b.toString(16).padStart(2,'0')).join(' '); }

function parseNode(chunk) {
  // Heuristic parser for a 5-byte RPLIDAR standard scan node.
  // Many rplidar SDKs use these formulas. If your lidar differs, adapt accordingly.
  if (!chunk || chunk.length !== 5) return null;
  const b0 = chunk[0];
  const b1 = chunk[1];
  const b2 = chunk[2];
  const b3 = chunk[3];
  const b4 = chunk[4];

  // quality: high 6 bits of b0 (shift right by 2)
  const quality = b0 >> 2;
  // start flag: bit0 of b0 (1 = start of new scan)
  const startFlag = (b0 & 0x1) === 1;

  // angle: ((b1 >> 1) + (b2 << 7)) / 64.0
  const angleRaw = ((b1 >> 1) + (b2 << 7));
  const angle = angleRaw / 64.0; // degrees

  // distance (in mm): (b3 + (b4 << 8)) / 4.0
  const distRaw = (b3 | (b4 << 8));
  const distance_mm = distRaw / 4.0;

  return { quality, startFlag, angle, distance_mm };
}

async function main() {
  // Auto-probe mode: iterate serial ports and baud rates and try INFO/SCAN briefly
  async function probePorts() {
  const candidateBauds = doProbeAll ? [9600, 57600, 115200, 128000, 230400, 256000, 500000, 1000000] : [115200, 230400, 256000];
    console.log('Probing serial ports for RPLIDAR. Baud rates:', candidateBauds.join(', '));
    let listFn;
    try {
      listFn = SerialPort && SerialPort.list ? SerialPort.list : require('serialport').list;
    } catch (e) {
      listFn = require('serialport').list;
    }
    let ports = [];
    try { ports = await listFn(); } catch (e) { try { ports = await require('serialport').list(); } catch(e2){ console.error('Failed to list serial ports', e2); return; } }

    if (!ports || ports.length === 0) {
      console.log('No serial ports found.');
      return;
    }

    for (const p of ports) {
      const path = p.path || p.comName || p.device || p.port || p.filename;
      if (!path) continue;
      console.log('\nTrying port', path);
      for (const baud of candidateBauds) {
        console.log('  Trying baud', baud);
        const port = new SerialPort({ path: path, baudRate: baud, autoOpen: false });
        let sawData = false;
        try {
          await new Promise((resolve, reject) => {
            let timer;
            port.open((err) => {
              if (err) return reject(err);
              // optionally toggle DTR/RTS quickly (may reset some devices)
              try {
                if (doProbeAll && typeof port.set === 'function') {
                  port.set({ dtr: true, rts: true }, () => {
                    setTimeout(() => { try { port.set({ dtr: false, rts: false }); } catch(e){} }, 50);
                  });
                }
              } catch(e){}

              // listen for a slightly longer window on extended probe
              port.on('data', (chunk) => {
                sawData = true;
                const ts = (new Date()).toISOString();
                console.log(`    ${ts} saw ${chunk.length} bytes:`, hex(chunk));
                if (outStream) outStream.write(`${ts} ${path} ${baud} raw ${hex(chunk)}\n`);
              });

              // send INFO then SCAN to elicit responses
              try { port.write(INFO_CMD); } catch (e) { /* ignore */ }
              setTimeout(() => { try { port.write(SCAN_CMD); } catch (e) { /* ignore */ } }, 120);

              // wait short period (longer if extended)
              const waitMs = doProbeAll ? 1500 : 800;
              timer = setTimeout(() => {
                // cleanup
                try { port.removeAllListeners('data'); } catch(e){}
                port.close(() => resolve());
              }, waitMs);
            });
          });
        } catch (err) {
          console.log('    open error:', err && err.message);
          try { if (port && port.isOpen) port.close(()=>{}); } catch(e){}
        }
        if (sawData) {
          console.log('  -> Port', path, 'baud', baud, 'appears to respond.');
          // move to next port after a successful response
          break;
        }
      }
    }
    console.log('\nProbe complete.');
  }

  // If probe/autoprobe requested, run it and exit
  if (doProbe) {
    await probePorts();
    return;
  }

  console.log('Opening', portPath, 'baud', baudRate);
  const port = new SerialPort({ path: portPath, baudRate: baudRate, autoOpen: false });

  port.on('error', (err) => {
    console.error('Serial port error', err && err.message);
  });

  port.open((err) => {
    if (err) {
      console.error('Failed to open port', err && err.message);
      process.exit(2);
    }
    console.log('Port opened.');

    // If justPing (info/health/custom cmd) mode, send specific command(s) and wait for timeoutSec seconds
    if (justPing && cmdHex) {
      let buf;
      try {
        const clean = cmdHex.trim().split(/\s+/).map(h => parseInt(h, 16));
        buf = Buffer.from(clean);
      } catch (e) {
        console.error('Invalid --cmd hex:', cmdHex);
        process.exit(3);
      }
      console.log('Sending command:', cmdHex, 'and listening for', timeoutSec, 's');
      port.write(buf);
      port.on('data', (chunk) => {
        const ts = (new Date()).toISOString();
        console.log(ts, 'raw', hex(chunk));
        if (outStream) outStream.write(ts + ' raw ' + hex(chunk) + '\n');
      });

      setTimeout(() => { stopAndExit(0); }, timeoutSec * 1000);
      return;
    }

    console.log('Sending SCAN command...');
    try {
      port.write(SCAN_CMD);
    } catch (writeErr) {
      console.error('Write error', writeErr && writeErr.message);
    }

    if (doParse) {
      const parser = port.pipe(new ByteLengthParser({ length: 5 }));
      parser.on('data', (chunk) => {
        const node = parseNode(chunk);
        const ts = (new Date()).toISOString();
        if (node) {
          const line = `${ts} angle=${node.angle.toFixed(2)} deg distance=${node.distance_mm.toFixed(2)} mm quality=${node.quality} start=${node.startFlag}`;
          console.log(line);
          if (outStream) outStream.write(line + '\n');
        } else {
          console.log(ts, 'raw:', hex(chunk));
          if (outStream) outStream.write(ts + ' raw: ' + hex(chunk) + '\n');
        }
      });
    } else {
      port.on('data', (chunk) => {
        const ts = (new Date()).toISOString();
        console.log(ts, 'raw', hex(chunk));
        if (outStream) outStream.write(ts + ' raw ' + hex(chunk) + '\n');
      });
    }

  });

  // Graceful shutdown: send STOP before exit
  function stopAndExit(code = 0) {
    try {
      if (port && port.isOpen) {
        console.log('Sending STOP command to RPLIDAR...');
        port.write(STOP_CMD, () => {
          setTimeout(() => { try { port.close(() => process.exit(code)); } catch(e){ process.exit(code); } }, 200);
        });
      } else {
        process.exit(code);
      }
    } catch (err) {
      console.error('Error while stopping', err && err.message);
      process.exit(code);
    }
  }

  process.on('SIGINT', () => { console.log('SIGINT'); stopAndExit(0); });
  process.on('SIGTERM', () => { console.log('SIGTERM'); stopAndExit(0); });
}

main().catch(err => { console.error('Fatal error', err); process.exit(1); });
