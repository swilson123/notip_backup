var deliver_package = function (white_rabbit, trigger) {
    console.log('deliver_package: Starting delivery with 180° turn');

   

    setTimeout(function() {
        console.log('Current flight mode:', white_rabbit.flight_data.robot_flight_mode);
        
        // Perform 180 degree turn using the new function
        white_rabbit.preform_turn(white_rabbit, 180).then(function() {
            console.log('180° turn completed - continuing with delivery');
            
            setTimeout(function () {
                console.log('deliver_package: ' + white_rabbit.delivery_device);
                //white_rabbit.mission.package_delivered = true;

                if (white_rabbit.delivery_device == 'dump_trailer') {
                    white_rabbit.deliver_package_dump_trailer(white_rabbit);
                } else if (white_rabbit.delivery_device == 'arm_delivery') {
                    white_rabbit.deliver_package_arm(white_rabbit);
                }

                setTimeout(function () {
                    // Return trip is handled by custom reverse-waypoint navigation in run_mission.js.
                    // arduino_message_handler.js sets package_delivered=true when auto_delivery drops to 0.
                    // This fallback fires if arduino does not confirm delivery within 10 seconds.
                    if (!white_rabbit.mission.package_delivered) {
                        console.log('deliver_package: fallback – setting package_delivered flag');
                        white_rabbit.mission.package_delivered = true;
                        // Guard: never go below 1 — seq 0 is the dock, returning there
                        // without a valid return path causes mission confusion.
                        white_rabbit.mission.current_mission_seq = Math.max(1, (white_rabbit.mission.current_mission_seq || 0) - 2);
                        // Let Jiminy Cricket weigh in on what just happened.
                        if (white_rabbit.intelligence) white_rabbit.intelligence.consider('fallback_delivery_triggered');
                    }
                }, 10000);

            }, 1000);
            
        }).catch(function(error) {
            console.log('Turn failed:', error);
        });

    }, 2000);
};

module.exports = deliver_package;