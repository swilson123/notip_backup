// The STL-19P sits vertically on Noah's front — 0 deg points straight down at the
// ground, 180 deg straight up. That splits the circle into two halves, each sweeping
// from beneath the sensor out toward horizontal on one side of the rover: angles
// (0,180) are raw side "A", angles (180,360) are raw side "B". white_rabbit.ldr.side_invert
// decides which raw side is physically left vs right on the hardware.
//
// On flat ground a beam at theta degrees off nadir returns a steadily growing slant
// range as theta grows. A sidewalk edge — a curb dropping to grass/street, or a raised
// lip — breaks that continuity: distance jumps up (surface fell away) or down (something
// closer popped up) between adjacent thetas. The first such jump scanning outward from
// under the sensor is the near edge on that side.

function _theta_to_bin(theta_deg, raw_side) {
    return raw_side === 'A' ? theta_deg : (360 - theta_deg) % 360;
}

function _find_edge_mm(white_rabbit, raw_side) {

    let previous = null; // { distance_mm, theta_deg } of the last valid reading seen

    for (let theta_deg = white_rabbit.ldr.edge_min_theta_deg; theta_deg <= white_rabbit.ldr.edge_max_theta_deg; theta_deg++) {

        const reading = white_rabbit.ldr.scan[_theta_to_bin(theta_deg, raw_side)];
        if (!reading) continue;

        if (previous && Math.abs(reading.distance_mm - previous.distance_mm) >= white_rabbit.ldr.edge_delta_threshold_mm) {
            return Math.round(previous.distance_mm * Math.sin(previous.theta_deg * Math.PI / 180));
        }

        previous = { distance_mm: reading.distance_mm, theta_deg: theta_deg };
    }

    return null;
}

function _broadcast_display(white_rabbit) {

    if (!white_rabbit.ldr.display_enabled || !white_rabbit.ldr.display_server) return;

    const points = [];
    white_rabbit.ldr.scan.forEach(function (reading, angle_deg) {
        if (reading) points.push({ angle_deg: angle_deg, distance_mm: reading.distance_mm });
    });

    const payload = JSON.stringify({
        mount_height_mm: white_rabbit.ldr.mount_height_mm,
        edge_left_distance_mm: white_rabbit.ldr.edge_left_distance_mm,
        edge_right_distance_mm: white_rabbit.ldr.edge_right_distance_mm,
        points: points
    });

    white_rabbit.ldr.display_last_payload = payload;

    white_rabbit.ldr.display_server.clients.forEach(function (client) {
        if (client.readyState === 1 /* WebSocket.OPEN */) client.send(payload);
    });
}

var ldr_edge_data = function (white_rabbit) {

    if (white_rabbit.ldr.received_data.points) {
        white_rabbit.ldr.received_data.points.forEach(function (point) {
            if (point.distance_mm > 0) {
                white_rabbit.ldr.scan[Math.round(point.angle_deg) % 360] = {
                    distance_mm: point.distance_mm,
                    confidence: point.confidence
                };
            }
        });
    }

    const raw_right = white_rabbit.ldr.side_invert ? 'B' : 'A';
    const raw_left = white_rabbit.ldr.side_invert ? 'A' : 'B';

    white_rabbit.ldr.edge_right_distance_mm = _find_edge_mm(white_rabbit, raw_right);
    white_rabbit.ldr.edge_left_distance_mm = _find_edge_mm(white_rabbit, raw_left);

    _broadcast_display(white_rabbit);

    return {
        edge_left_distance_mm: white_rabbit.ldr.edge_left_distance_mm,
        edge_right_distance_mm: white_rabbit.ldr.edge_right_distance_mm
    };

};

module.exports = ldr_edge_data;
