// Filters an array of recent LIDAR readings using Median Absolute Deviation (MAD)
// Each reading: { timestamp, distance_mm, angle }
// Returns true if the new reading is consistent, false if it's an outlier
function lidar_message_filter(recentReadings, newReading, thresholdMultiplier = 3, angleThreshold = 10) {
    const now = Date.now();
    // Only use readings from the last 3 seconds
    const filteredReadings = Array.isArray(recentReadings)
        ? recentReadings.filter(r => now - r.timestamp <= 3000)
        : [];
    if (filteredReadings.length < 3) {
        // Not enough recent data to filter, accept by default
        return true;
    }
    // Extract distances and angles
    const distances = filteredReadings.map(r => r.distance_mm);
    const angles = filteredReadings.map(r => r.angle);
    // Compute median for distance and angle
    const medianDist = distances.slice().sort((a, b) => a - b)[Math.floor(distances.length / 2)];
    const medianAngle = angles.slice().sort((a, b) => a - b)[Math.floor(angles.length / 2)];
    // Compute absolute deviations
    const absDevsDist = distances.map(d => Math.abs(d - medianDist));
    const absDevsAngle = angles.map(a => Math.abs(a - medianAngle));
    // Compute MAD for distance and angle
    const madDist = absDevsDist.slice().sort((a, b) => a - b)[Math.floor(absDevsDist.length / 2)];
    const madAngle = absDevsAngle.slice().sort((a, b) => a - b)[Math.floor(absDevsAngle.length / 2)];
    // Outlier if deviation from median exceeds threshold * MAD for distance or angle
    const deviationDist = Math.abs(newReading.distance_mm - medianDist);
    const deviationAngle = Math.abs(newReading.angle - medianAngle);
    const distOk = deviationDist <= thresholdMultiplier * madDist;
    const angleOk = deviationAngle <= angleThreshold || deviationAngle <= thresholdMultiplier * madAngle;
    return distOk && angleOk;
}

module.exports = lidar_message_filter;
