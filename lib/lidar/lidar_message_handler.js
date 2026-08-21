const lidar_message_filter = require('./lidar_message_filter');
//const lidar_ws_server = require('./lidar_ws_server');

var lidar_message_handler = function (white_rabbit, message) {
   


    //console.log('LIDAR Data:', message);


    // Expect message to be an object: { quality, startFlag, angle, distance_mm }
    if (message && typeof message === 'object' && typeof message.angle === 'number' && typeof message.distance_mm === 'number') {
        // Normalize angle to [0, 360)
        let angle = message.angle % 360;
        if (angle < 0) angle += 360;

        // Update zones if angle and distance match, with filtering
        if (Array.isArray(white_rabbit.zones)) {
            white_rabbit.zones.forEach((zone) => {
                if (
                    angle >= zone.min_angle && angle < zone.max_angle &&
                    message.distance_mm >= zone.min_distance_mm && message.distance_mm < zone.max_distance_mm
                ) {
                    // Ignore readings with low quality (e.g., < 10)
                    if (typeof message.quality === 'number' && message.quality < 10) return;

                    // Maintain recent readings for each zone
                    if (!zone.recent_readings) zone.recent_readings = [];
                    const newReading = {
                        timestamp: Date.now(),
                        distance_mm: message.distance_mm,
                        angle: angle,
                        quality: message.quality
                    };
                    // Add new reading to recent_readings (limit to last 20)
                    zone.recent_readings.push(newReading);
                    if (zone.recent_readings.length > 20) zone.recent_readings.shift();

                    // Filter out inconsistent readings
                    if (lidar_message_filter(zone.recent_readings.slice(0, -1), newReading)) {
                        zone.timestamp = newReading.timestamp;
                        zone.distance_mm = newReading.distance_mm;
                        zone.angle = newReading.angle;
                        zone.quality = newReading.quality;
                    } else {
                        // Optionally log or handle outlier
                        // console.log('Filtered out inconsistent LIDAR reading:', newReading);
                    }
                }
            });
        }

        // After zone updates, send all recent readings to WebSocket clients
        // if (Array.isArray(white_rabbit.zones)) {
        //     // Flatten all recent readings from all zones into one array
        //     const allPoints = white_rabbit.zones.flatMap(zone => zone.recent_readings || []);
        //     lidar_ws_server.update(allPoints);
        // }


    }

    // Manage red/green light status based on zone activity
    if (!white_rabbit.rplidar.red_light_green_light) {
        white_rabbit.rplidar.red_light_green_light = setInterval(() => {

            for (var i = 0; i < white_rabbit.zones.length; i++) {

                if (white_rabbit.zones[i].timestamp + 1000 > Date.now()) {
                    if (white_rabbit.zones[i].distance_mm < white_rabbit.zones[i].max_distance_mm/2) {
                        white_rabbit.zones[i].light = "red";
                    }
                    else {
                        white_rabbit.zones[i].light = "yellow";
                    }
                }
                else {
                    white_rabbit.zones[i].light = "green";
                }
                //console.log(white_rabbit.zones[i].zone+": "+white_rabbit.zones[i].light);

            }

            white_rabbit.avoid_object(white_rabbit);

            // Log zone state summary every 2 seconds
            if (!white_rabbit.rplidar.last_zone_log_ts || Date.now() - white_rabbit.rplidar.last_zone_log_ts >= 2000) {
                white_rabbit.rplidar.last_zone_log_ts = Date.now();
                let zone_summary = white_rabbit.zones.map(function(z) {
                    return 'z' + z.zone + ':' + z.light[0] + (z.distance_mm ? '(' + z.distance_mm + 'mm)' : '');
                }).join(' ');
                white_rabbit.logs.lidar_message_filter.log(white_rabbit, 'zones: ' + zone_summary);
            }

        }, 100);
    }

};


module.exports = lidar_message_handler;