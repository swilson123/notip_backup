const LDR_POINT_COUNT = 12;
const LDR_POINTS_OFFSET = 6; // header(1) + ver_len(1) + speed(2) + start_angle(2)

var ldr_message_handler = function (white_rabbit, packet) {

    try {

        const speed = packet.readUInt16LE(2);
        const start_angle_raw = packet.readUInt16LE(4);
        const end_angle_offset = LDR_POINTS_OFFSET + LDR_POINT_COUNT * 3;
        const end_angle_raw = packet.readUInt16LE(end_angle_offset);
        const timestamp = packet.readUInt16LE(end_angle_offset + 2);

        const points = [];
        for (let i = 0; i < LDR_POINT_COUNT; i++) {
            const offset = LDR_POINTS_OFFSET + i * 3;
            points.push({
                distance_mm: packet.readUInt16LE(offset),
                // sensor calls this "intensity" in its own datasheet — same value, renamed
                // here since it's the per-point quality/confidence signal, not a light reading
                confidence: packet[offset + 2]
            });
        }

        // Same spread used by LDRobot's own driver (lipkg.cpp Parse()): the 12 points
        // land evenly across the packet's angular span, wrapping the 0/360 seam.
        const angle_span_raw = (end_angle_raw + 36000 - start_angle_raw) % 36000;
        const step_deg = (angle_span_raw / (LDR_POINT_COUNT - 1)) / 100;
        const start_deg = start_angle_raw / 100;

        points.forEach(function (point, i) {
            let angle_deg = start_deg + i * step_deg;
            if (angle_deg >= 360) angle_deg -= 360;
            point.angle_deg = angle_deg;
        });

        white_rabbit.ldr.received_data = {
            speed_deg_per_sec: speed,
            start_angle_deg: start_deg,
            end_angle_deg: end_angle_raw / 100,
            timestamp_ms: timestamp,
            points: points
        };

        white_rabbit.logs.ldr_message_handler.log(white_rabbit, 'Received data: ' + JSON.stringify(white_rabbit.ldr.received_data));
        
        // Call the edge data processing function after receiving new LDR data
        white_rabbit.ldr_edge_data(white_rabbit);

    }
    catch (e) {
        white_rabbit.logs.ldr_message_handler.log(white_rabbit, 'parse error: ' + e.message);
    }

};

module.exports = ldr_message_handler;
