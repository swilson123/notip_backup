var calc_speed_based_on_distance = function (zone, distance) {
   const minDist = zone.max_distance_mm / 2;
    const maxDist = zone.max_distance_mm;
    const minRpm = 10;
    const maxRpm = 200;

    // Clamp distance to valid range
    const d = Math.max(minDist, Math.min(maxDist, distance));

    // Map distance to RPM (slow down as distance decreases)
    const ratio = (d - minDist) / (maxDist - minDist); // 0 → 1
    const rpm = minRpm + ratio * (maxRpm - minRpm);

    return rpm;
 
}

module.exports = calc_speed_based_on_distance;