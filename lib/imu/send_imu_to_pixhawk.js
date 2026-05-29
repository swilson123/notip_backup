var send_imu_to_pixhawk = function (white_rabbit) {
    //Set EK3_MAG_CAL = 6
    // jspack._PackSeries reads values as a flat array, so the q float[4] must be
    // spread rather than passed as a nested array.
    white_rabbit.mavlink.messages.att_pos_mocap.prototype.pack = function(mav) {
        return white_rabbit.mavlink.message.prototype.pack.call(this, mav, this.crc_extra,
            jspack.Pack(this.format, [this.time_usec, this.q[0], this.q[1], this.q[2], this.q[3], this.x, this.y, this.z, ...new Array(21).fill(0)])
        );
    };

    clearInterval(white_rabbit.imu_send_to_pixhawk_interval);
    white_rabbit.imu_send_to_pixhawk_interval = setInterval(() => {
        if (!white_rabbit.imu_data || !white_rabbit.imu_data.connected) return;

        const raw = white_rabbit.imu_data.quaternion;
        const half = (white_rabbit.imu.compass_offset_deg * Math.PI / 180) / 2;
        const cH = Math.cos(half), sH = Math.sin(half);
        const q = {
            w: cH * raw.w - sH * raw.z,
            x: cH * raw.x - sH * raw.y,
            y: cH * raw.y + sH * raw.x,
            z: cH * raw.z + sH * raw.w,
        };

        const msg = new white_rabbit.mavlink.messages.att_pos_mocap(
            Date.now() * 1000,
            [q.w, q.x, q.y, q.z],
            0, 0, 0
        );

        white_rabbit.send_pixhawk_command(white_rabbit, 'att_pos_mocap', msg);
    }, 100);
};

module.exports = send_imu_to_pixhawk;
