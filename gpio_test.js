const { execSync } = require('child_process');

const IN_CHIP = '/dev/gpiochip0';
const IN_OFFSET = 17;   // switch input (BCM17)
const POLL_MS = 100;

function readIn() {
  try {
    return execSync(`gpioget ${IN_CHIP} ${IN_OFFSET}`, { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString().trim(); // "0" or "1"
  } catch (e) {
    console.error('gpioget failed:', e.message || e);
    process.exit(1);
  }
}

let last = null;
try {
  last = readIn();
  console.log(`Initial: input ${IN_OFFSET}=${last}`);
} catch (e) {
  console.error(e);
  process.exit(1);
}

setInterval(() => {
  const cur = readIn();
  if (cur !== last) {
    last = cur;
    console.log(`Switch -> ${cur === '1' ? 'CLOSED (HIGH)' : 'OPEN (LOW)'}`);
  }
}, POLL_MS);