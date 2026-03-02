const { execSync } = require('child_process');



var gpio_connect = function (rover) {

  if (rover.gpio.gpio_comName) {

    const IN_CHIP = rover.gpio.gpio_comName; // e.g., "/dev/gpiochip0"  
    const IN_OFFSET = 17;   // switch input (BCM17)
    const POLL_MS = 100;

    function readIn() {
      try {
        return execSync(`gpioget ${IN_CHIP} ${IN_OFFSET}`, { stdio: ['ignore', 'pipe', 'pipe'] })
          .toString().trim(); // "0" or "1"
      } catch (e) {
        console.error('gpioget failed:', e.message || e);

      }
    }

    let last = null;
    try {
      last = readIn();
      rover.gpio.connected = true;
      rover.set_delivery_type(rover, last);

    } catch (e) {
      console.error(e);

    }

    setInterval(() => {
      const cur = readIn();
      if (cur !== last) {
        last = cur;

        rover.set_delivery_type(rover, cur);
      }
    }, POLL_MS);

  }

};


module.exports = gpio_connect;