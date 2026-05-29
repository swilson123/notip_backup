var set_dump_trailer_delivery = function (white_rabbit) {

    if (white_rabbit.delivery_device === 'dump_trailer') {
        //lower dump trailer
        white_rabbit.servos.dump_tailer.set_pwm = white_rabbit.servos.dump_tailer.min_pwm;
        white_rabbit.servo_dump_tailer(white_rabbit, white_rabbit.servos.dump_tailer.set_pwm);
    }



    //lower arm delivery to min pwm
    setTimeout(() => {

        let speed = 1;
        let rate = 10;



        const interval = setInterval(() => {
            if (white_rabbit.servos.arm_driver_side.set_pwm <= white_rabbit.servos.arm_driver_side.min_pwm) {
                clearInterval(interval); // Stop when below 800
                return;
            }
            if (white_rabbit.delivery_device === 'dump_trailer') {
                white_rabbit.servo_arm_passenger_side(white_rabbit, white_rabbit.servos.arm_driver_side.set_pwm);
            }
            else {
                clearInterval(interval); // Stop if delivery device changed
                return;
            }
            // Decrement
            white_rabbit.servos.arm_driver_side.set_pwm -= speed;

        }, rate);


        const interval2 = setInterval(() => {
            if (white_rabbit.servos.arm_passenger_side.set_pwm >= white_rabbit.servos.arm_passenger_side.min_pwm) {
                clearInterval(interval2); // Stop when below 800
                return;
            }
            if (white_rabbit.delivery_device === 'dump_trailer') {
                white_rabbit.servo_arm_driver_side(white_rabbit, white_rabbit.servos.arm_passenger_side.set_pwm);
            }
            else {
                clearInterval(interval2); // Stop if delivery device changed
                return;
            }
            // Decrement
            white_rabbit.servos.arm_passenger_side.set_pwm += speed;

        }, rate);

    }, 6000);


    //unlock dump tailer bed
    setTimeout(() => {
        if (white_rabbit.delivery_device === 'dump_trailer') {
            white_rabbit.servos.bed.set_pwm = white_rabbit.servos.dump_tailer.min_pwm;
            white_rabbit.servo_bed(white_rabbit, white_rabbit.servos.bed.set_pwm);
        }
    }, 20000);

    // //test deliver package dump trailer
    // setTimeout(() => {
    //     white_rabbit.deliver_package_dump_trailer(white_rabbit);
    // }, 21000);


};
module.exports = set_dump_trailer_delivery;