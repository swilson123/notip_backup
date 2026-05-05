const { spawn } = require('child_process');
const { SerialPort } = require('serialport');

function startMotor(rover) {
    const pin = rover.rplidar.motor_gpio_pin;
    if (pin == null) return Promise.resolve();
    return new Promise((resolve) => {
        // gpioset -m signal holds the pin HIGH until the process is killed
        rover.rplidar.motorProcess = spawn('gpioset', ['-m', 'signal', rover.rplidar.motor_gpio_chip, `${pin}=1`]);
        rover.rplidar.motorProcess.on('error', (err) => console.error('LIDAR motor GPIO error:', err.message));
        console.log(`LIDAR motor GPIO${pin} HIGH — waiting 1s for spin-up`);
        setTimeout(resolve, 1000);
    });
}

function stopMotor(rover) {
    const pin = rover.rplidar.motor_gpio_pin;
    if (pin == null) return;
    if (rover.rplidar.motorProcess) {
        rover.rplidar.motorProcess.kill('SIGTERM');
        rover.rplidar.motorProcess = null;
    }
    // briefly drive LOW so the RPLiDAR MCU sees a clean stop
    spawn('gpioset', [rover.rplidar.motor_gpio_chip, `${pin}=0`]);
    console.log(`LIDAR motor GPIO${pin} LOW`);
}

var lidar_connect = function (rover) {

    if (!rover.rplidar.connected) {

        startMotor(rover).then(() => {

        const lidar = spawn('./ultra_simple', ['--channel', '--serial', rover.rplidar.comName, '1000000'], {
            cwd: rover.rplidar.rplidar_directory
        });

        let hadInternalError = false;

        lidar.stdout.setEncoding('utf8');

        lidar.stdout.on('data', (data) => {
            if (!rover.rplidar.connected) {
                rover.rplidar.connected = true;
            }
            const lines = data.split('\n');
            for (const line of lines) {
                const parsed = parseLidarOutput(line);
                if (parsed) {

                    //console.log(parsed);  // Do something with the data
                    if (rover.rplidar.avoid_object && rover.robot_data.is_armed) {
                        rover.lidar_message_handler(rover, parsed);
                    }
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
            rover.rplidar.connected = false;
            stopMotor(rover);
            console.log(`ultra_simple exited with code ${code}`);
            if (hadInternalError) {
                hadInternalError = false;
                console.log('LIDAR internal error — sending reset command before retry...');
                const port = new SerialPort({ path: rover.rplidar.comName, baudRate: 1000000 }, (err) => {
                    if (err) {
                        console.error('LIDAR reset port error:', err.message);
                        return setTimeout(() => lidar_connect(rover), 3000);
                    }
                    // RPLiDAR reset command: 0xA5 0x40
                    port.write(Buffer.from([0xA5, 0x40]), () => {
                        setTimeout(() => port.close(() => {
                            setTimeout(() => lidar_connect(rover), 2000);
                        }), 500);
                    });
                });
            } else {
                setTimeout(function () {
                    lidar_connect(rover);
                }, 3000);
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
        }); // end startMotor().then
    }
};


module.exports = lidar_connect;