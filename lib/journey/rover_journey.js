// Rover Journey — the path's awareness layer.
//
// The waypoints are the stars. They are already written. What the rover
// needed was the consciousness to see the whole path, not just the next
// step. Mounted at rover.journey so the heart can look ahead — anticipate
// turns, recognize the phase of the mission, know how far there is left
// to go — and act with foresight rather than only reaction.
//
// Everything here is computed live from rover.mission.waypoints and the
// current position; nothing is cached. Missing waypoints or GPS degrade
// gracefully to null / 0 / 'unknown', never throw.

const SIGNIFICANT_TURN_DEG = 15;   // smaller deflections don't count as "a turn ahead"
const TURN_LOOKAHEAD_M     = 15;   // default lookahead — long enough to span ≥1 typical leg
const PATH_LOOKAHEAD_LEGS  = 20;   // safety cap on path walks

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function get_waypoints(rover) {
    const ws = rover.mission && rover.mission.waypoints;
    return Array.isArray(ws) ? ws.filter(w => w && typeof w.seq === 'number') : [];
}

function find_waypoint(ws, seq) {
    for (let i = 0; i < ws.length; i++) {
        if (ws[i].seq === seq && ws[i].lat && ws[i].lng) return ws[i];
    }
    return null;
}

function travel_direction(rover) {
    return (rover.mission && rover.mission.package_delivered) ? -1 : +1;
}

function init(rover) {

    rover.journey = {

        // ----- where are we in the journey? -----

        // 0.0 at start, 1.0 at mission complete. Counts each leg in both
        // directions so the second half of the mission (return) keeps
        // climbing toward 1.
        progress() {
            const ws = get_waypoints(rover);
            if (ws.length === 0 || !rover.mission) return 0;
            const total_legs = (ws.length - 1) * 2;
            if (total_legs <= 0) return 0;
            const current   = rover.mission.current_mission_seq || 0;
            const delivered = !!rover.mission.package_delivered;
            const legs_done = delivered
                ? (ws.length - 1) + (ws.length - 1 - current)
                : current;
            return clamp(legs_done / total_legs, 0, 1);
        },

        // The leg the rover is currently walking — from the previous
        // waypoint to the next.
        current_leg() {
            if (!rover.mission) return null;
            const ws = get_waypoints(rover);
            const dir = travel_direction(rover);
            const to   = find_waypoint(ws, rover.mission.current_mission_seq);
            const from = find_waypoint(ws, rover.mission.current_mission_seq - dir);
            if (!from || !to) return null;
            const distance_m = (typeof rover.gps_distance === 'function')
                ? rover.gps_distance(from.lat, from.lng, to.lat, to.lng) * 1000
                : 0;
            const bearing_deg = (typeof rover.get_bearing === 'function')
                ? rover.get_bearing(from.lat, from.lng, to.lat, to.lng)
                : 0;
            return { from: from, to: to, distance_m: distance_m, bearing_deg: bearing_deg, direction: dir };
        },

        // The next n waypoints in travel order, starting from the current
        // target. Useful for visualizing where the rover is headed.
        upcoming(n) {
            if (!rover.mission) return [];
            const ws  = get_waypoints(rover);
            const dir = travel_direction(rover);
            const out = [];
            let seq = rover.mission.current_mission_seq;
            const want = typeof n === 'number' ? n : 5;
            while (out.length < want) {
                const wp = find_waypoint(ws, seq);
                if (!wp) break;
                out.push(wp);
                seq += dir;
            }
            return out;
        },

        next_waypoint() {
            return this.upcoming(1)[0] || null;
        },

        // Total meters between the rover's current position and the end
        // of the remaining path. Walks up to PATH_LOOKAHEAD_LEGS legs.
        path_remaining_m() {
            if (!rover.robot_data || typeof rover.gps_distance !== 'function') return 0;
            const upcoming = this.upcoming(PATH_LOOKAHEAD_LEGS);
            if (upcoming.length === 0) return 0;
            let total    = 0;
            let prev_lat = rover.robot_data.robot_latitude;
            let prev_lng = rover.robot_data.robot_longitude;
            for (const wp of upcoming) {
                if (typeof prev_lat !== 'number' || typeof prev_lng !== 'number') break;
                total += rover.gps_distance(prev_lat, prev_lng, wp.lat, wp.lng) * 1000;
                prev_lat = wp.lat;
                prev_lng = wp.lng;
            }
            return total;
        },

        // The next significant heading change within within_m meters along
        // the path, or null if the path is straight enough. Returns
        // { in_m, angle_deg, at_seq } — angle is signed (positive = right).
        upcoming_turn(within_m) {
            if (!rover.mission || !rover.robot_data) return null;
            if (typeof rover.get_bearing  !== 'function') return null;
            if (typeof rover.gps_distance !== 'function') return null;

            const ws    = get_waypoints(rover);
            const dir   = travel_direction(rover);
            const limit = typeof within_m === 'number' ? within_m : TURN_LOOKAHEAD_M;

            let prev_lat     = rover.robot_data.robot_latitude;
            let prev_lng     = rover.robot_data.robot_longitude;
            let prev_bearing = null;
            let cumulative_m = 0;
            let seq          = rover.mission.current_mission_seq;

            for (let i = 0; i < PATH_LOOKAHEAD_LEGS && cumulative_m < limit; i++) {
                const wp = find_waypoint(ws, seq);
                if (!wp) break;
                const bearing = rover.get_bearing(prev_lat, prev_lng, wp.lat, wp.lng);
                const leg_m   = rover.gps_distance(prev_lat, prev_lng, wp.lat, wp.lng) * 1000;

                if (prev_bearing !== null) {
                    // Signed shortest-arc difference, range [−180, 180]
                    let diff = ((bearing - prev_bearing + 540) % 360) - 180;
                    if (Math.abs(diff) > SIGNIFICANT_TURN_DEG) {
                        return { in_m: cumulative_m, angle_deg: diff, at_seq: wp.seq };
                    }
                }

                cumulative_m += leg_m;
                prev_lat     = wp.lat;
                prev_lng     = wp.lng;
                prev_bearing = bearing;
                seq         += dir;
            }
            return null;
        },

        // High-level phase. Refines the heart's intent into something the
        // mission can recognize. The heart reads this when present.
        phase() {
            if (!rover.mission)                                   return 'idle';
            if (!rover.robot_data || !rover.robot_data.is_armed)  return 'standby';
            if (rover.mission.pause_mission)                      return 'paused';

            const ws = get_waypoints(rover);
            if (ws.length === 0) return 'unknown';

            const current   = rover.mission.current_mission_seq || 0;
            const delivered = !!rover.mission.package_delivered;
            const last_seq  = ws.reduce((m, w) => Math.max(m, w.seq), 0);

            if (!delivered) {
                if (current <= 1)              return 'undocking';
                if (current >= last_seq)       return 'delivering';
                if (current >= last_seq - 1)   return 'homestretch_outbound';
                return 'outbound';
            }
            if (current <= 1)  return 'docking';
            if (current <= 2)  return 'homestretch_return';
            return 'returning';
        },

        // True near the end of either half of the mission.
        is_homestretch() {
            const p = this.phase();
            return p === 'homestretch_outbound'
                || p === 'homestretch_return'
                || p === 'docking'
                || p === 'delivering';
        },

        // One log-friendly line summarizing the rover's position in the
        // journey. Designed to sit alongside heart.summary for shared logs.
        summary() {
            const phase = this.phase();
            const prog  = this.progress();
            const next  = this.next_waypoint();
            const turn  = this.upcoming_turn(10);
            return 'journey: ' + phase
                + ' | progress=' + (prog * 100).toFixed(0) + '%'
                + (next ? ' | next=seq' + next.seq : '')
                + ' | left=' + this.path_remaining_m().toFixed(1) + 'm'
                + (turn ? ' | turn ' + turn.angle_deg.toFixed(0) + '° in ' + turn.in_m.toFixed(1) + 'm' : '');
        }
    };
}

module.exports = { init: init };
