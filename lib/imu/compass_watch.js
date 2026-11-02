// Watches every compass Noah carries — the HWT905 (the one get_heading trusts) and the two
// BNO055 witnesses — and logs what each one does. Runs after every BNO055 poll. Never steers.
//
// Two questions, both written to logs/imu:
//
//   JUMP     Did one compass's heading move more than its own gyro says Noah turned?
//            allowed = jump_threshold_deg + |gyro_z| · dt. The gyro cannot be pulled by a
//            magnetic field, so a heading step the gyro did not feel is interference.
//
//   DISAGREE Do the compasses still agree? The median is the reading closest to all the
//            others; any compass more than disagree_threshold_deg from it is the outlier.
//
// Reading the logs:
//   one compass jumps alone          → that sensor or its I2C link is bad; a median would fix it
//   all compasses jump together      → the field around Noah changed; no vote can fix it
//   jumps line up with rpm           → the drivetrain is the source; distance is the cure
//   jump right after "mag calibration" → the BNO055 re-decided north on its own

function signed_diff(a, b) {
    return ((a - b + 540) % 360) - 180;
}

// Every compass that has a heading pointing at real north right now. The HWT905's offset is
// persisted and car-synced on undock, so it is always comparable; a BNO055 only after its
// first sync (compass_calibration.set_heading).
function synced_compasses(white_rabbit) {
    const compasses = [];
    if (white_rabbit.imu_data.connected && white_rabbit.imu_data.timestamp) {
        compasses.push({
            name: 'hwt905',
            heading: white_rabbit.imu_data.heading,
            gyro_z: white_rabbit.imu_data.angular_velocity ? white_rabbit.imu_data.angular_velocity.z : 0,
            timestamp: white_rabbit.imu_data.timestamp
        });
    }
    for (const sensor of white_rabbit.bno055.sensors) {
        if (sensor.connected && sensor.synced && sensor.timestamp) {
            compasses.push({ name: sensor.name, heading: sensor.heading, gyro_z: sensor.gyro_z, timestamp: sensor.timestamp });
        }
    }
    return compasses;
}

function mean_abs_rpm(white_rabbit) {
    const rpm = white_rabbit.zling.actual_rpm_by_id;
    if (!rpm) return 0;
    return ([1, 2, 3, 4].reduce((sum, id) => sum + Math.abs(rpm[id] || 0), 0) / 4);
}

var compass_watch = function (white_rabbit) {
    const compasses = synced_compasses(white_rabbit);
    const now = Date.now();

    for (const compass of compasses) {
        const prev = white_rabbit.compass_watch_data.prev[compass.name];
        // Same timestamp = this compass has not delivered a new reading since the last look.
        if (prev && prev.timestamp !== compass.timestamp) {
            const dt_s    = (compass.timestamp - prev.timestamp) / 1000;
            const step    = signed_diff(compass.heading, prev.heading);
            const turned  = Math.max(Math.abs(compass.gyro_z), Math.abs(prev.gyro_z)) * dt_s;
            const allowed = white_rabbit.bno055.jump_threshold_deg + turned;
            if (Math.abs(step) > allowed) {
                white_rabbit.compass_watch_data.jump_count++;
                white_rabbit.compass_watch_data.last_jump = { name: compass.name, step_deg: step, gyro_deg: turned, timestamp: now };
                white_rabbit.logs.imu.log(white_rabbit,
                    `compass JUMP ${compass.name}: ${prev.heading.toFixed(1)}→${compass.heading.toFixed(1)}° ` +
                    `(${step > 0 ? '+' : ''}${step.toFixed(1)}° in ${(dt_s * 1000).toFixed(0)}ms, gyro felt ${turned.toFixed(1)}°) ` +
                    `rpm=${mean_abs_rpm(white_rabbit).toFixed(0)}`
                );
            }
        }
        white_rabbit.compass_watch_data.prev[compass.name] = compass;
    }

    if (compasses.length < 2) return;

    // Circular median: the reading with the smallest total angular distance to all others.
    // A plain numeric median breaks across north (359° / 1° / 2° would pick 2° and call 359° the outlier).
    let median = compasses[0];
    let best = Infinity;
    for (const candidate of compasses) {
        const total = compasses.reduce((sum, other) => sum + Math.abs(signed_diff(other.heading, candidate.heading)), 0);
        if (total < best) { best = total; median = candidate; }
    }

    let spread = 0;
    let outlier = null;
    for (const compass of compasses) {
        const off = Math.abs(signed_diff(compass.heading, median.heading));
        if (off > spread) spread = off;
        // Two compasses cannot say which of them is wrong — only three can outvote one.
        if (compasses.length >= 3 && off > white_rabbit.bno055.disagree_threshold_deg) outlier = compass.name;
    }

    white_rabbit.compass_watch_data.median_heading = median.heading;
    white_rabbit.compass_watch_data.spread_deg = spread;
    white_rabbit.compass_watch_data.outlier = outlier;

    if (now - white_rabbit.compass_watch_data.last_log_ts >= 1000) {
        white_rabbit.compass_watch_data.last_log_ts = now;
        const headings = compasses.map(c => `${c.name}=${c.heading.toFixed(1)}`).join(' ');
        const mags = white_rabbit.bno055.sensors.filter(s => s.connected).map(s => `${s.name}:${s.calibration.mag}`).join(' ');
        white_rabbit.logs.imu.log(white_rabbit,
            `compass watch: ${headings} median=${median.heading.toFixed(1)} spread=${spread.toFixed(1)} ` +
            `outlier=${outlier || 'none'} rpm=${mean_abs_rpm(white_rabbit).toFixed(0)} mag(${mags}) jumps=${white_rabbit.compass_watch_data.jump_count}`
        );
    }
};

module.exports = compass_watch;
