const { spawn } = require('child_process');
const { SerialPort } = require('serialport');

let motorEnabled = false;

function enableMotor(white_rabbit) {
    if (motorEnabled) return;
    const pin = white_rabbit.rplidar.motor_gpio_pin;
    if (pin == null) return;
    motorEnabled = true;
    const chip = white_rabbit.rplidar.motor_gpio_chip;

    const start = () => {
        const proc = spawn('gpioset', ['-m', 'signal', chip, `${pin}=1`]);
        proc.on('error', (err) => console.error('LIDAR motor GPIO error:', err.message));
        console.log(`LIDAR motor GPIO${pin} enabled`);
    };

    // Release the pin from any orphaned gpioset left by a previous run before
    // re-driving it, so two processes aren't holding the same GPIO.
    let started = false;
    const once = () => { if (!started) { started = true; start(); } };
    const killer = spawn('pkill', ['-f', `gpioset.*${pin}=1`], { stdio: 'ignore' });
    killer.on('close', once);
    killer.on('error', once); // pkill unavailable — proceed directly
}

var lidar_connect = function (white_rabbit) {

    if (!white_rabbit.rplidar.connected && !white_rabbit.rplidar.reconnecting) {
        white_rabbit.rplidar.reconnecting = true;

        // Kill any orphaned ultra_simple from a previous run before reopening the
        // serial port, so two readers don't fight over the LiDAR. The 2 s init
        // delay below gives pkill time to finish before we spawn the new one.
        const usKiller = spawn('pkill', ['-f', 'ultra_simple'], { stdio: 'ignore' });
        usKiller.on('error', () => {}); // pkill unavailable — ignore, spawn proceeds

        enableMotor(white_rabbit);

        setTimeout(() => {

        const lidar = spawn('./ultra_simple', ['--channel', '--serial', white_rabbit.rplidar.comName, '1000000'], {
            cwd: white_rabbit.rplidar.rplidar_directory
        });

        let hadInternalError = false;

        lidar.stdout.setEncoding('utf8');

        lidar.stdout.on('data', (data) => {
            const lines = data.split('\n');
            for (const line of lines) {
                const parsed = parseLidarOutput(line);
                if (parsed) {
                    // Only mark connected on a REAL scan sample. ultra_simple prints
                    // a startup banner ("Ultra simple LIDAR data grabber...Version:")
                    // to stdout even with no device attached; keying off any stdout
                    // would flap connected/restored then close/lost on every retry.
                    if (!white_rabbit.rplidar.connected) {
                        white_rabbit.rplidar.connected = true;
                        if (white_rabbit.rplidar.disconnect_ts) {
                            var dark_s = ((Date.now() - white_rabbit.rplidar.disconnect_ts) / 1000).toFixed(0);
                            white_rabbit.rplidar.disconnect_ts    = null;
                            white_rabbit.rplidar._reconnect_count = 0;
                            console.log('LIDAR: reconnected after ' + dark_s + 's');
                            if (white_rabbit.voice) white_rabbit.voice.say('LiDAR restored.');
                        }
                    }
                    //console.log(parsed);  // Do something with the data
                    white_rabbit.lidar_message_handler(white_rabbit, parsed);
                }
            }
        });

        lidar.stderr.on('data', (data) => {
            console.error(`LIDAR error: ${data}`);
            if (data.toString().includes('internal error')) {
                hadInternalError = true;
            }
        });

        lidar.on('close', (code) => {
            white_rabbit.rplidar.connected    = false;
            white_rabbit.rplidar.reconnecting = false;
            console.log(`ultra_simple exited with code ${code}`);

            // Stamp disconnect and announce once — the last scan zones remain on
            // white_rabbit.zones and go stale by timestamp, so avoid_object keeps
            // working safely. Camera obstacle detection is still live.
            if (!white_rabbit.rplidar.disconnect_ts) {
                white_rabbit.rplidar.disconnect_ts = Date.now();
                if (white_rabbit.voice) white_rabbit.voice.say('LiDAR signal lost. Path sensing by camera.');
            }

            if (hadInternalError) {
                // Hardware reset sequence — fixed timing required by RPLiDAR protocol.
                // Backoff does not apply here: the reset itself IS the recovery step.
                hadInternalError = false;
                console.log('LIDAR internal error — sending reset command before retry...');
                white_rabbit.rplidar.reconnecting = true;
                const port = new SerialPort({ path: white_rabbit.rplidar.comName, baudRate: 1000000 }, (err) => {
                    if (err) {
                        console.error('LIDAR reset port error:', err.message);
                        white_rabbit.rplidar.reconnecting = false;
                        return setTimeout(() => lidar_connect(white_rabbit), 3000);
                    }
                    port.write(Buffer.from([0xA5, 0x40]), () => {
                        setTimeout(() => port.close(() => {
                            white_rabbit.rplidar.reconnecting = false;
                            setTimeout(() => lidar_connect(white_rabbit), 2000);
                        }), 500);
                    });
                });
            } else {
                // Exponential backoff: 3 s → 6 s → 12 s → 30 s max.
                var count     = white_rabbit.rplidar._reconnect_count || 0;
                var delay_ms  = Math.min(3000 * Math.pow(2, count), 30000);
                white_rabbit.rplidar._reconnect_count = count + 1;
                setTimeout(function () { lidar_connect(white_rabbit); }, delay_ms);
            }
        });

        function parseLidarOutput(line) {
            const regex = /theta:\s*([\d.]+)\s*Dist:\s*([\d.]+)\s*Q:\s*(\d+)/;
            const match = line.match(regex);

            if (match) {
                return {
                    angle: parseFloat(match[1]),
                    distance_mm: parseFloat(match[2]),
                    quality: parseInt(match[3]),
                    timestamp: Date.now()
                };
            }

            return null;
        }

        }, 2000); // allow RPLiDAR time to initialize before connecting
    }
};


module.exports = lidar_connect;