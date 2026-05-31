// Recall — unified time and location queries across memory and learning.
// Mounted on the God variable so any code with `white_rabbit` in scope can ask:
//   • "What's happening here?"           white_rabbit.recall_here(5)
//   • "What happened over there?"        white_rabbit.recall({ near: { lat, lng, radius_m: 5 } })
//   • "What's been going on lately?"     white_rabbit.recall({ time_back_ms: 5000 })
//   • "Have I been stuck near here?"     white_rabbit.recall({ near: {...}, types: ['stuck_event'] })
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

function recall(white_rabbit, query) {
    query = query || {};
    const out = { memory: [], learning: [], summary: null };

    const near         = (query.near && typeof query.near.lat === 'number' && typeof query.near.lng === 'number') ? query.near : null;
    const radius_m     = near && typeof near.radius_m === 'number' ? near.radius_m : 3.0;
    const time_back_ms = typeof query.time_back_ms === 'number' ? query.time_back_ms : null;
    const type_set     = Array.isArray(query.types) ? new Set(query.types) : null;

    // --- memory side ---
    if (!query.only_learning && white_rabbit.memory) {
        const snaps = time_back_ms ? white_rabbit.memory.recent(time_back_ms) : white_rabbit.memory.all();
        out.memory = snaps.filter(s => {
            if (!near) return true;
            return s.gps && within_radius(s.gps.lat, s.gps.lng, near.lat, near.lng, radius_m, white_rabbit.gps_distance);
        });
    }

    // --- learning side ---
    if (!query.only_memory && white_rabbit.learning) {
        const records = white_rabbit.learning.list();
        const now_ts  = Date.now();
        out.learning = records.filter(r => {
            if (type_set && !type_set.has(r.type)) return false;
            if (time_back_ms != null && (now_ts - r.timestamp) > time_back_ms) return false;
            if (!near) return true;
            return r.payload && within_radius(r.payload.lat, r.payload.lng, near.lat, near.lng, radius_m, white_rabbit.gps_distance);
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

// Convenience: recall around the white_rabbit's *current* GPS position. Pass a
// radius (default 5 m) and optional time-back filter. Returns the same shape
// as recall() and is the right entry point for "what does the white_rabbit know
// about where it is right now?"
function recall_here(white_rabbit, radius_m, time_back_ms) {
    const lat = white_rabbit.robot_data && white_rabbit.robot_data.robot_latitude;
    const lng = white_rabbit.robot_data && white_rabbit.robot_data.robot_longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
        return { memory: [], learning: [], summary: { reason: 'no_gps' } };
    }
    return recall(white_rabbit, {
        near:         { lat: lat, lng: lng, radius_m: typeof radius_m === 'number' ? radius_m : 5.0 },
        time_back_ms: typeof time_back_ms === 'number' ? time_back_ms : null
    });
}

var white_rabbit_recall = function (white_rabbit) {
    white_rabbit.recall      = (query) => recall(white_rabbit, query);
    white_rabbit.recall_here = (radius_m, time_back_ms) => recall_here(white_rabbit, radius_m, time_back_ms);
}

module.exports = white_rabbit_recall;
