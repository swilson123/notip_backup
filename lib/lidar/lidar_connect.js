const { spawn } = require('child_process');
const { SerialPort } = require('serialport');

let motorEnabled = false;

function enableMotor(white_rabbit) {
    if (motorEnabled) return;
    const pin = white_rabbit.rplidar.motor_gpio_pin;
    if (pin == null) return;
    motorEnabled = true;
    const proc = spawn('gpioset', ['-m', 'signal', white_rabbit.rplidar.motor_gpio_chip, `${pin}=1`]);
    proc.on('error', (err) => console.error('LIDAR motor GPIO error:', err.message));
    console.log(`LIDAR motor GPIO${pin} enabled`);
}

var lidar_connect = function (white_rabbit) {

    if (!white_rabbit.rplidar.connected && !white_rabbit.rplidar.reconnecting) {
        white_rabbit.rplidar.reconnecting = true;

        enableMotor(white_rabbit);

        setTimeout(() => {

        const lidar = spawn('./ultra_simple', ['--channel', '--serial', white_rabbit.rplidar.comName, '1000000'], {
            cwd: white_rabbit.rplidar.rplidar_directory
        });

        let hadInternalError = false;

        lidar.stdout.setEncoding('utf8');

        lidar.stdout.on('data', (data) => {
            if (!white_rabbit.rplidar.connected) {
                white_rabbit.rplidar.connected = true;
            }
            const lines = data.split('\n');
            for (const line of lines) {
                const parsed = parseLidarOutput(line);
                if (parsed) {

                    //console.log(parsed);  // Do something with the data
                    if (white_rabbit.rplidar.avoid_object && white_rabbit.robot_data.is_armed) {
                        white_rabbit.lidar_message_handler(white_rabbit, parsed);
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
            white_rabbit.rplidar.connected = false;
            white_rabbit.rplidar.reconnecting = false;
            console.log(`ultra_simple exited with code ${code}`);
            if (hadInternalError) {
                hadInternalError = false;
                console.log('LIDAR internal error — sending reset command before retry...');
                white_rabbit.rplidar.reconnecting = true;
                const port = new SerialPort({ path: white_rabbit.rplidar.comName, baudRate: 1000000 }, (err) => {
                    if (err) {
                        console.error('LIDAR reset port error:', err.message);
                        white_rabbit.rplidar.reconnecting = false;
                        return setTimeout(() => lidar_connect(white_rabbit), 3000);
                    }
                    // RPLiDAR reset command: 0xA5 0x40
                    port.write(Buffer.from([0xA5, 0x40]), () => {
                        setTimeout(() => port.close(() => {
                            white_rabbit.rplidar.reconnecting = false;
                            setTimeout(() => lidar_connect(white_rabbit), 2000);
                        }), 500);
                    });
                });
            } else {
                setTimeout(function () {
                    lidar_connect(white_rabbit);
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

        }, 2000); // allow RPLiDAR time to initialize before connecting
    }
};


module.exports = lidar_connect;