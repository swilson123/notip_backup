// "Self love comes first."
// Before committing to the delivery, Noah checks whether it has enough power
// to complete the mission AND return home to dock. If the answer is no, Noah
// turns back. The mission cannot end stranded in the field. The light must be
// reached. Called every mission tick so the odometer stays current.

var SENTINEL_MV = [0, 65535]; // MAVLink SYS_STATUS "no reading" values

var power_guardian = function (white_rabbit) {
    var nav_tuning = white_rabbit.nav_tuning || {};
    var mission    = white_rabbit.mission;

    // Only guard during outbound — once delivered (or already aborting), we
    // are already heading home. The guardian's work is done.
    if (mission.package_delivered || mission.finished_package_yaw || mission.power_abort) return;

    // Read battery voltage (mV → V). Ignore MAVLink no-reading sentinels.
    var sys = white_rabbit.robot_data && white_rabbit.robot_data.SYS_STATUS;
    if (!sys) return;
    var mv = sys.voltage_battery;
    if (typeof mv !== 'number' || mv <= 0 || SENTINEL_MV.indexOf(mv) !== -1) return;
    var voltage_v = mv / 1000;

    var lat = white_rabbit.robot_data.robot_latitude;
    var lng = white_rabbit.robot_data.robot_longitude;

    // First call: plant the start voltage and seed the odometer.
    if (!mission._power_start_voltage_v) {
        mission._power_start_voltage_v = voltage_v;
        mission._power_last_lat        = lat;
        mission._power_last_lng        = lng;
        mission._power_odometer_m      = 0;
        return;
    }

    // Update odometer: GPS delta since last tick.
    // Jump-protected: ignore steps > 2 m per 250 ms tick (GPS noise / outlier).
    // Ignore steps < 0.01 m (stationary jitter that inflates distance).
    if (lat && lng && mission._power_last_lat && mission._power_last_lng) {
        var step_m = white_rabbit.gps_distance(
            mission._power_last_lat, mission._power_last_lng, lat, lng
        ) * 1000;
        if (step_m > 0.01 && step_m < 2.0) {
            mission._power_odometer_m += step_m;
        }
    }
    mission._power_last_lat = lat;
    mission._power_last_lng = lng;

    var odometer_m = mission._power_odometer_m || 0;

    // Need minimum distance before the consumption rate is meaningful.
    var min_dist_m = typeof nav_tuning.power_guardian_min_distance_m === 'number'
        ? nav_tuning.power_guardian_min_distance_m : 5;
    if (odometer_m < min_dist_m) return;

    var voltage_dropped_v = mission._power_start_voltage_v - voltage_v;
    // If voltage has not meaningfully dropped, consumption rate is near-zero.
    // No threat — skip rather than divide by near-zero noise.
    if (voltage_dropped_v < 0.05) return;

    // Consumption rate over the actual path walked (not straight-line).
    var rate_v_per_m = voltage_dropped_v / odometer_m;

    // Tuning params — all configurable from setup.json nav_tuning block.
    var safety_factor   = typeof nav_tuning.power_guardian_safety_factor   === 'number' ? nav_tuning.power_guardian_safety_factor   : 1.4;
    var dock_overhead_v = typeof nav_tuning.power_guardian_dock_overhead_v === 'number' ? nav_tuning.power_guardian_dock_overhead_v : 0.4;
    var min_safe_v      = typeof nav_tuning.power_guardian_min_safe_v      === 'number' ? nav_tuning.power_guardian_min_safe_v      : 14.8;

    // Voltage needed: retrace the outbound path (same distance as odometer,
    // since breadcrumbs follow the exact path walked) + docking overhead.
    // Safety factor accounts for rough terrain, wind drag, obstacle detours.
    var voltage_to_return = (rate_v_per_m * odometer_m * safety_factor) + dock_overhead_v;

    // Voltage available above the floor Noah must never fall below.
    var voltage_available = voltage_v - min_safe_v;

    if (voltage_available < voltage_to_return) {
        mission.power_abort = true;

        console.log([
            'power_guardian: ABORT — not enough power to return home',
            '  voltage        = ' + voltage_v.toFixed(2)                      + ' V',
            '  start          = ' + mission._power_start_voltage_v.toFixed(2) + ' V',
            '  rate           = ' + (rate_v_per_m * 1000).toFixed(1)          + ' mV/m',
            '  outbound       = ' + odometer_m.toFixed(1)                     + ' m',
            '  need_to_return = ' + voltage_to_return.toFixed(2)              + ' V',
            '  available      = ' + voltage_available.toFixed(2)              + ' V'
        ].join('\n'));

        if (white_rabbit.voice) {
            white_rabbit.voice.say('Returning to the light. Self love comes first.');
        }

        // Learning: record where and when power was insufficient so future
        // missions can carry this knowledge — heavier load, longer route,
        // or lower starting charge than planned.
        if (white_rabbit.learning && typeof white_rabbit.learning.add === 'function') {
            white_rabbit.learning.add('power_abort', {
                lat:              lat,
                lng:              lng,
                voltage_v:        voltage_v,
                start_voltage_v:  mission._power_start_voltage_v,
                odometer_m:       odometer_m,
                rate_mv_per_m:    rate_v_per_m * 1000,
                voltage_needed_v: voltage_to_return
            });
        }
    }
};

module.exports = power_guardian;
