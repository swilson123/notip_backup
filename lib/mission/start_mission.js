// The single canonical way to enter autonomous mission mode. Every trigger —
// the RC mission switch (radio_commands), the RC-initiated undock completing
// (down_the_rabbit_hole), and the hook limit switch (arduino_message_handler) —
// funnels through here so the mission-start state is set in exactly one place.
//
// Callers own their own gating (RC-connected checks, undock-in-progress queueing,
// dock_state clearing) and call this only once they've decided to go.
var start_mission = function (white_rabbit) {

    white_rabbit.robot_data.mission_mode = true;
    white_rabbit.dock.manual_dock_required = false;
    if (white_rabbit.rc_contoller) white_rabbit.rc_contoller.mission_start_pending = false;

    white_rabbit.mission.first_leg_committed = false;
    white_rabbit.mission.first_leg_start_lat = white_rabbit.robot_data.robot_latitude || null;
    white_rabbit.mission.first_leg_start_lng = white_rabbit.robot_data.robot_longitude || null;

    // Start every mission with a clean avoidance state so navigation engages
    // immediately. If path_clear were left false (from a prior object detection,
    // an arm-time reset, or a previous mission) avoid_object would treat the
    // start as mid-avoidance and creep the rover forward without ever entering
    // mission navigation — the "just moves forward, never enters mission mode"
    // bug. Real obstacles still flip path_clear=false reactively once detected.
    white_rabbit.mission.path_clear = true;
    white_rabbit.mission.avoidance_timed_out = false;
    white_rabbit.mission.realsense_blocked_since = null;
    white_rabbit.mission.avoidance_start_grace_until = Date.now() + 4000;
    white_rabbit.mission.avoidance_turn = null;

    // Defensive: if something left a mission_interval running while mission_mode
    // was reset externally, don't double-spawn.
    if (white_rabbit.mission.mission_interval) {
        clearInterval(white_rabbit.mission.mission_interval);
    }
    white_rabbit.mission.mission_interval = setInterval(() => {
        white_rabbit.run_mission(white_rabbit);
    }, 250);

    if (white_rabbit.compass_calibration) white_rabbit.compass_calibration.start();

};


module.exports = start_mission;
