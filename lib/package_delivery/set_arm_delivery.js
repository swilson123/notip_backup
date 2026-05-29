var set_arm_delivery = function (white_rabbit) {


    if (white_rabbit.delivery_device === 'arm_delivery') {
        //lower dump trailer
        white_rabbit.servos.dump_tailer.set_pwm = white_rabbit.servos.dump_tailer.min_pwm;
        white_rabbit.servo_dump_tailer(white_rabbit, white_rabbit.servos.dump_tailer.set_pwm);
    }

    //locck dump tailer bed
    setTimeout(() => {
        if (white_rabbit.delivery_device === 'arm_delivery') {
            white_rabbit.servos.bed.set_pwm = white_rabbit.servos.dump_tailer.max_pwm;
            white_rabbit.servo_bed(white_rabbit, white_rabbit.servos.bed.set_pwm);
        }
    }, 5000);

    //raise arm delivery to trim
    setTimeout(() => {

        let speed = 1;
        let rate = 10;



        const interval = setInterval(() => {
            if (white_rabbit.servos.arm_driver_side.set_pwm >= white_rabbit.servos.arm_driver_side.trim_pwm) {
                clearInterval(interval); // Stop when below 800
                return;
            }
            if (white_rabbit.delivery_device === 'arm_delivery') {
                white_rabbit.servo_arm_passenger_side(white_rabbit, white_rabbit.servos.arm_driver_side.set_pwm);
            }
            else {
                clearInterval(interval); // Stop if delivery device changed
                return;
            }
            // Decrement
            white_rabbit.servos.arm_driver_side.set_pwm += speed;

        }, rate);


        const interval2 = setInterval(() => {
            if (white_rabbit.servos.arm_passenger_side.set_pwm <= white_rabbit.servos.arm_passenger_side.trim_pwm) {
                clearInterval(interval2); // Stop when below 800
                return;
            }
            if (white_rabbit.delivery_device === 'arm_delivery') {
                white_rabbit.servo_arm_driver_side(white_rabbit, white_rabbit.servos.arm_passenger_side.set_pwm);
            }
            else {
                clearInterval(interval2); // Stop if delivery device changed
                return;
            }
            // Decrement
            white_rabbit.servos.arm_passenger_side.set_pwm -= speed;

        }, rate);

    }, 6000);

    //test deliver package after arm is raised
    setTimeout(() => {
        if (white_rabbit.delivery_device === 'arm_delivery') {
            white_rabbit.deliver_package_arm(white_rabbit);
        }
    }, 25000);


};
module.exports = set_arm_delivery;