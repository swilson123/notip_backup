var deliver_package = function (rover, trigger) {
    console.log('deliver_package: Starting delivery with 180° turn');

   

    setTimeout(function() {
        console.log('Current flight mode:', rover.flight_data.robot_flight_mode);
        
        // Perform 180 degree turn using the new function
        rover.preform_turn(rover, 180).then(function() {
            console.log('180° turn completed - continuing with delivery');
            
            setTimeout(function () {
                console.log('deliver_package: ' + rover.delivery_device);
                //rover.mission.package_delivered = true;

                if (rover.delivery_device == 'dump_trailer') {
                    rover.deliver_package_dump_trailer(rover);
                } else if (rover.delivery_device == 'arm_delivery') {
                    rover.deliver_package_arm(rover);
                }

                setTimeout(function () {
                    rover.set_flight_mode(rover, 'SMART_RTL');
                }, 10000);

            }, 1000);
            
        }).catch(function(error) {
            console.log('Turn failed:', error);
        });

    }, 2000);
};

module.exports = deliver_package;