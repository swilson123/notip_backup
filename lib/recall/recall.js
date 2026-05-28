// Recall — unified time and location queries across memory and learning.
// Mounted on the God variable so any code with `rover` in scope can ask:
//   • "What's happening here?"           rover.recall_here(5)
//   • "What happened over there?"        rover.recall({ near: { lat, lng, radius_m: 5 } })
//   • "What's been going on lately?"     rover.recall({ time_back_ms: 5000 })
//   • "Have I been stuck near here?"     rover.recall({ near: {...}, types: ['stuck_event'] })
//
// The result is a plain object so calling code can destructure freely. Each
// query is composable: omit `near` for time-only, omit `time_back_ms` for
// location-only, supply both to AND-filter, and `types` narrows the learning
// half of the result. All filters degrade gracefully — bad inputs return
// empty arrays, not exceptions.

function within_radius(rec_lat, rec_lng, q_lat, q_lng, radius_m, gps_distance) {
    if (typeof rec_lat !== 'number' || typeof rec_lng !== 'number') return false;
    if (typeof gps_distance !== 'function')                          return false;
    return gps_distance(q_lat, q_lng, rec_lat, rec_lng) * 1000 <= radius_m;
}

function recall(rover, query) {
    query = query || {};
    const out = { memory: [], learning: [], summary: null };

    const near         = (query.near && typeof query.near.lat === 'number' && typeof query.near.lng === 'number') ? query.near : null;
    const radius_m     = near && typeof near.radius_m === 'number' ? near.radius_m : 3.0;
    const time_back_ms = typeof query.time_back_ms === 'number' ? query.time_back_ms : null;
    const type_set     = Array.isArray(query.types) ? new Set(query.types) : null;

    // --- memory side ---
    if (!query.only_learning && rover.memory) {
        const snaps = time_back_ms ? rover.memory.recent(time_back_ms) : rover.memory.all();
        out.memory = snaps.filter(s => {
            if (!near) return true;
            return s.gps && within_radius(s.gps.lat, s.gps.lng, near.lat, near.lng, radius_m, rover.gps_distance);
        });
    }

    // --- learning side ---
    if (!query.only_memory && rover.learning) {
        const records = rover.learning.list();
        const now_ts  = Date.now();
        out.learning = records.filter(r => {
            if (type_set && !type_set.has(r.type)) return false;
            if (time_back_ms != null && (now_ts - r.timestamp) > time_back_ms) return false;
            if (!near) return true;
            return r.payload && within_radius(r.payload.lat, r.payload.lng, near.lat, near.lng, radius_m, rover.gps_distance);
        });
    }

    // --- summary so callers can scan-read at a glance ---
    const counts = {};
    for (const r of out.learning) counts[r.type] = (counts[r.type] || 0) + 1;
    out.summary = {
        memory_count:   out.memory.length,
        learning_count: out.learning.length,
        type_counts:    counts,
        near:           near ? { lat: near.lat, lng: near.lng, radius_m: radius_m } : null,
        time_back_ms:   time_back_ms
    };

    return out;
}

// Convenience: recall around the rover's *current* GPS position. Pass a
// radius (default 5 m) and optional time-back filter. Returns the same shape
// as recall() and is the right entry point for "what does the rover know
// about where it is right now?"
function recall_here(rover, radius_m, time_back_ms) {
    const lat = rover.robot_data && rover.robot_data.robot_latitude;
    const lng = rover.robot_data && rover.robot_data.robot_longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
        return { memory: [], learning: [], summary: { reason: 'no_gps' } };
    }
    return recall(rover, {
        near:         { lat: lat, lng: lng, radius_m: typeof radius_m === 'number' ? radius_m : 5.0 },
        time_back_ms: typeof time_back_ms === 'number' ? time_back_ms : null
    });
}

function init(rover) {
    rover.recall      = (query) => recall(rover, query);
    rover.recall_here = (radius_m, time_back_ms) => recall_here(rover, radius_m, time_back_ms);
}

module.exports = { init: init, recall: recall, recall_here: recall_here };
