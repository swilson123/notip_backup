var set_arm_delivery = function (rover) {


    if (rover.delivery_device === 'arm_delivery') {
        //lower dump trailer
        rover.servos.dump_tailer.set_pwm = rover.servos.dump_tailer.min_pwm;
        rover.servo_dump_tailer(rover, rover.servos.dump_tailer.set_pwm);
    }

    //locck dump tailer bed
    setTimeout(() => {
        if (rover.delivery_device === 'arm_delivery') {
            rover.servos.bed.set_pwm = rover.servos.dump_tailer.max_pwm;
            rover.servo_bed(rover, rover.servos.bed.set_pwm);
        }
    }, 5000);

    //raise arm delivery to trim
    setTimeout(() => {

        let speed = 1;
        let rate = 10;



        const interval = setInterval(() => {
            if (rover.servos.arm_driver_side.set_pwm >= rover.servos.arm_driver_side.trim_pwm) {
                clearInterval(interval); // Stop when below 800
                return;
            }
            if (rover.delivery_device === 'arm_delivery') {
                rover.servo_arm_passenger_side(rover, rover.servos.arm_driver_side.set_pwm);
            }
            else {
                clearInterval(interval); // Stop if delivery device changed
                return;
            }
            // Decrement
            rover.servos.arm_driver_side.set_pwm += speed;

        }, rate);


        const interval2 = setInterval(() => {
            if (rover.servos.arm_passenger_side.set_pwm <= rover.servos.arm_passenger_side.trim_pwm) {
                clearInterval(interval2); // Stop when below 800
                return;
            }
            if (rover.delivery_device === 'arm_delivery') {
                rover.servo_arm_driver_side(rover, rover.servos.arm_passenger_side.set_pwm);
            }
            else {
                clearInterval(interval2); // Stop if delivery device changed
                return;
            }
            // Decrement
            rover.servos.arm_passenger_side.set_pwm -= speed;

        }, rate);

    }, 6000);

    //test deliver package after arm is raised
    setTimeout(() => {
        if (rover.delivery_device === 'arm_delivery') {
            rover.deliver_package_arm(rover);
        }
    }, 25000);


};
module.exports = set_arm_delivery;