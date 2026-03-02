var set_dump_trailer_delivery = function (rover) {

    if (rover.delivery_device === 'dump_trailer') {
        //lower dump trailer
        rover.servos.dump_tailer.set_pwm = rover.servos.dump_tailer.min_pwm;
        rover.servo_dump_tailer(rover, rover.servos.dump_tailer.set_pwm);
    }



    //lower arm delivery to min pwm
    setTimeout(() => {

        let speed = 1;
        let rate = 10;



        const interval = setInterval(() => {
            if (rover.servos.arm_driver_side.set_pwm <= rover.servos.arm_driver_side.min_pwm) {
                clearInterval(interval); // Stop when below 800
                return;
            }
            if (rover.delivery_device === 'dump_trailer') {
                rover.servo_arm_passenger_side(rover, rover.servos.arm_driver_side.set_pwm);
            }
            else {
                clearInterval(interval); // Stop if delivery device changed
                return;
            }
            // Decrement
            rover.servos.arm_driver_side.set_pwm -= speed;

        }, rate);


        const interval2 = setInterval(() => {
            if (rover.servos.arm_passenger_side.set_pwm >= rover.servos.arm_passenger_side.min_pwm) {
                clearInterval(interval2); // Stop when below 800
                return;
            }
            if (rover.delivery_device === 'dump_trailer') {
                rover.servo_arm_driver_side(rover, rover.servos.arm_passenger_side.set_pwm);
            }
            else {
                clearInterval(interval2); // Stop if delivery device changed
                return;
            }
            // Decrement
            rover.servos.arm_passenger_side.set_pwm += speed;

        }, rate);

    }, 6000);


    //unlock dump tailer bed
    setTimeout(() => {
        if (rover.delivery_device === 'dump_trailer') {
            rover.servos.bed.set_pwm = rover.servos.dump_tailer.min_pwm;
            rover.servo_bed(rover, rover.servos.bed.set_pwm);
        }
    }, 20000);

    // //test deliver package dump trailer
    // setTimeout(() => {
    //     rover.deliver_package_dump_trailer(rover);
    // }, 21000);


};
module.exports = set_dump_trailer_delivery;