const { spawn } = require('child_process');

var lidar_connect = function (rover) {

    if (!rover.rplidar.connected) {

        const lidar = spawn('./ultra_simple', ['--channel', '--serial', rover.rplidar.comName, '1000000'], {
            cwd: rover.rplidar.rplidar_directory
        });

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
        });

        lidar.on('close', (code) => {
            rover.rplidar.connected = false;
            console.log(`ultra_simple exited with code ${code}`);
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
    }
};


module.exports = lidar_connect;