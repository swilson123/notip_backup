var deliver_package_dump_trailer = function (rover) {

    //unlock dump tailer bed
    if (rover.delivery_device === 'dump_trailer') {
        rover.servos.bed.set_pwm = rover.servos.dump_tailer.min_pwm;
        rover.servo_bed(rover, rover.servos.bed.set_pwm);
    }

    //raise dump trailer
    setTimeout(() => {
        if (rover.delivery_device === 'dump_trailer') {

            rover.servos.dump_tailer.set_pwm = rover.servos.dump_tailer.max_pwm;
            rover.servo_dump_tailer(rover, rover.servos.dump_tailer.set_pwm);
        }

    }, 1000);

    //lower dump trailer
    setTimeout(() => {
        if (rover.delivery_device === 'dump_trailer') {

            rover.servos.dump_tailer.set_pwm = rover.servos.dump_tailer.min_pwm;
            rover.servo_dump_tailer(rover, rover.servos.dump_tailer.set_pwm);
        }

    }, 10000);

    //lock dump tailer bed
    setTimeout(() => {
        if (rover.delivery_device === 'dump_trailer') {
            rover.servos.bed.set_pwm = rover.servos.dump_tailer.max_pwm;
            rover.servo_bed(rover, rover.servos.bed.set_pwm);
        }
    }, 15000);

};
module.exports = deliver_package_dump_trailer;