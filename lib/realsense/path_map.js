// Persistent world-frame sidewalk map: stores centerline observations from
// successive vision frames, prunes by age + distance behind the rover, and
// projects back to the rover frame on demand. Lets the rover anticipate turns
// and ride through rejected/low-confidence frames instead of losing the path.
//
// Conventions:
//   forward_m         — distance ahead of camera, positive
//   lateral_offset_m  — positive = sidewalk center is LEFT of camera bore
//                       (matches the Python script's published convention)
//   heading_deg       — compass heading, 0 = North, increases clockwise

const R_EARTH_M    = 6371000;
const M_PER_DEG_LAT = 111320;

function deg_to_rad(deg) { return deg * Math.PI / 180; }

function get_rover_heading(rover) {
    if (rover.imu_data && rover.imu_data.connected && typeof rover.imu_data.heading === 'number') {
        return rover.imu_data.heading;
    }
    let h = rover.robot_data && rover.robot_data.VFR_HUD && rover.robot_data.VFR_HUD.heading;
    return typeof h === 'number' ? h : null;
}

function haversine_m(lat1, lng1, lat2, lng2) {
    let phi1 = deg_to_rad(lat1);
    let phi2 = deg_to_rad(lat2);
    let dphi = deg_to_rad(lat2 - lat1);
    let dlam = deg_to_rad(lng2 - lng1);
    let a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
    return 2 * R_EARTH_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function rover_to_world(forward_m, lateral_offset_m, rover_lat, rover_lng, heading_deg) {
    let H = deg_to_rad(heading_deg);
    let d_north = forward_m * Math.cos(H) + lateral_offset_m * Math.sin(H);
    let d_east  = forward_m * Math.sin(H) - lateral_offset_m * Math.cos(H);
    let m_per_deg_lng = M_PER_DEG_LAT * Math.cos(deg_to_rad(rover_lat));
    return {
        lat: rover_lat + d_north / M_PER_DEG_LAT,
        lng: rover_lng + d_east  / m_per_deg_lng
    };
}

function world_to_rover(lat, lng, rover_lat, rover_lng, heading_deg) {
    let m_per_deg_lng = M_PER_DEG_LAT * Math.cos(deg_to_rad(rover_lat));
    let d_north = (lat - rover_lat) * M_PER_DEG_LAT;
    let d_east  = (lng - rover_lng) * m_per_deg_lng;
    let H = deg_to_rad(heading_deg);
    // Inverse of rover_to_world: rotation by -H applied to (d_north, d_east).
    let forward_m        = d_north * Math.cos(H) + d_east * Math.sin(H);
    let lateral_offset_m = d_north * Math.sin(H) - d_east * Math.cos(H);
    return { forward_m, lateral_offset_m };
}

// GPS jump detection: the rover's reported position has moved further from the
// last anchor than is physically plausible given expected motion + GPS noise.
// On a jump the caller should skip ingest and leave path_map.last_pose alone so
// the map stays anchored to the pre-jump pose.
function detect_gps_jump(path_map, rover_lat, rover_lng, eph_m, jump_floor_m, jump_multiplier) {
    let last = path_map.last_pose;
    if (!last) return false;
    let step_m = haversine_m(last.lat, last.lng, rover_lat, rover_lng);
    let threshold = Math.max(jump_floor_m, eph_m * jump_multiplier);
    return step_m > threshold;
}

function ingest_centerline(path_map, centerline, confidence, rover_lat, rover_lng, heading_deg, ts, merge_radius_m) {
    if (!Array.isArray(centerline) || centerline.length === 0) return 0;
    if (!confidence || confidence <= 0) return 0;

    let added = 0;
    let merge_radius_sq = merge_radius_m * merge_radius_m;
    let m_per_deg_lng = M_PER_DEG_LAT * Math.cos(deg_to_rad(rover_lat));

    for (let p of centerline) {
        if (typeof p.forward_m !== 'number' || typeof p.lateral_offset_m !== 'number') continue;
        let w = rover_to_world(p.forward_m, p.lateral_offset_m, rover_lat, rover_lng, heading_deg);

        // Look for nearby existing point and merge (confidence-weighted average).
        let merged = false;
        for (let q of path_map.points) {
            let dn = (w.lat - q.lat) * M_PER_DEG_LAT;
            let de = (w.lng - q.lng) * m_per_deg_lng;
            if (dn * dn + de * de <= merge_radius_sq) {
                let w_old = q.confidence;
                let w_new = confidence;
                let total = w_old + w_new;
                q.lat = (q.lat * w_old + w.lat * w_new) / total;
                q.lng = (q.lng * w_old + w.lng * w_new) / total;
                // Reinforced — but capped so a stale spot can't dominate forever.
                q.confidence = Math.min(1.0, q.confidence + confidence * 0.3);
                q.observed_at = ts;
                merged = true;
                break;
            }
        }
        if (!merged) {
            path_map.points.push({ lat: w.lat, lng: w.lng, confidence, observed_at: ts });
            added++;
        }
    }
    return added;
}

function prune(path_map, rover_lat, rover_lng, heading_deg, max_age_ms, max_behind_m, max_points) {
    let cutoff_ts = Date.now() - max_age_ms;
    let m_per_deg_lng = M_PER_DEG_LAT * Math.cos(deg_to_rad(rover_lat));
    let H = deg_to_rad(heading_deg);
    let cos_H = Math.cos(H);
    let sin_H = Math.sin(H);

    path_map.points = path_map.points.filter(p => {
        if (p.observed_at < cutoff_ts) return false;
        let d_north = (p.lat - rover_lat) * M_PER_DEG_LAT;
        let d_east  = (p.lng - rover_lng) * m_per_deg_lng;
        let forward_m = d_north * cos_H + d_east * sin_H;
        if (forward_m < -max_behind_m) return false;
        return true;
    });

    if (path_map.points.length > max_points) {
        path_map.points.sort((a, b) => a.observed_at - b.observed_at);
        path_map.points.splice(0, path_map.points.length - max_points);
    }
}

// Project all map points back into the current rover frame, bin by forward
// distance, and emit a confidence-weighted-median centerline. Sorted near→far.
function get_fused_centerline(path_map, rover_lat, rover_lng, heading_deg, bin_width_m, max_forward_m) {
    if (!path_map || !path_map.points || path_map.points.length === 0) return [];
    let m_per_deg_lng = M_PER_DEG_LAT * Math.cos(deg_to_rad(rover_lat));
    let H = deg_to_rad(heading_deg);
    let cos_H = Math.cos(H);
    let sin_H = Math.sin(H);

    let bins = new Map();
    for (let p of path_map.points) {
        let d_north = (p.lat - rover_lat) * M_PER_DEG_LAT;
        let d_east  = (p.lng - rover_lng) * m_per_deg_lng;
        let forward_m = d_north * cos_H + d_east * sin_H;
        if (forward_m < 0.2 || forward_m > max_forward_m) continue;
        let lateral_offset_m = d_north * sin_H - d_east * cos_H;
        let bin = Math.floor(forward_m / bin_width_m);
        if (!bins.has(bin)) bins.set(bin, []);
        bins.get(bin).push({ lateral_offset_m, confidence: p.confidence });
    }

    let centerline = [];
    let sorted_bins = Array.from(bins.keys()).sort((a, b) => a - b);
    for (let b of sorted_bins) {
        let arr = bins.get(b);
        arr.sort((x, y) => x.lateral_offset_m - y.lateral_offset_m);
        let total_w = arr.reduce((s, e) => s + e.confidence, 0);
        let half = total_w / 2;
        let cum = 0;
        let median_lat = arr[0].lateral_offset_m;
        for (let e of arr) {
            cum += e.confidence;
            if (cum >= half) { median_lat = e.lateral_offset_m; break; }
        }
        centerline.push({
            forward_m: (b + 0.5) * bin_width_m,
            lateral_offset_m: median_lat,
            confidence: Math.min(1.0, total_w / arr.length),
            count: arr.length
        });
    }
    return centerline;
}

// Path tangent at target_forward_m: angle (radians) of the path direction
// relative to the rover's current heading. Positive = path turning LEFT.
function get_path_heading_at(centerline, target_forward_m) {
    if (!Array.isArray(centerline) || centerline.length < 2) return 0;
    let i = 0;
    while (i < centerline.length - 1 && centerline[i + 1].forward_m < target_forward_m) i++;
    if (i >= centerline.length - 1) i = centerline.length - 2;
    let a = centerline[i];
    let b = centerline[i + 1];
    let dx = b.forward_m - a.forward_m;
    let dy = b.lateral_offset_m - a.lateral_offset_m;
    if (Math.abs(dx) < 1e-6) return 0;
    return Math.atan2(dy, dx);
}

// Average path tangent across the near-field portion of the centerline.
// Used as a "rover pointed wrong" signal that complements offset-based seeking.
function get_near_field_heading(centerline, max_forward_m) {
    if (!Array.isArray(centerline) || centerline.length < 2) return 0;
    let total = 0, count = 0;
    for (let i = 0; i < centerline.length - 1; i++) {
        let a = centerline[i], b = centerline[i + 1];
        if (a.forward_m > max_forward_m) break;
        let dx = b.forward_m - a.forward_m;
        let dy = b.lateral_offset_m - a.lateral_offset_m;
        if (Math.abs(dx) < 1e-6) continue;
        total += Math.atan2(dy, dx);
        count++;
    }
    return count > 0 ? total / count : 0;
}

module.exports = {
    M_PER_DEG_LAT,
    get_rover_heading,
    haversine_m,
    rover_to_world,
    world_to_rover,
    detect_gps_jump,
    ingest_centerline,
    prune,
    get_fused_centerline,
    get_path_heading_at,
    get_near_field_heading
};
