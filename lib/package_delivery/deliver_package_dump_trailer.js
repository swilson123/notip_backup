var deliver_package_dump_trailer = function (white_rabbit) {

    //unlock dump tailer bed
    if (white_rabbit.delivery_device === 'dump_trailer') {
        white_rabbit.servos.bed.set_pwm = white_rabbit.servos.dump_tailer.min_pwm;
        white_rabbit.servo_bed(white_rabbit, white_rabbit.servos.bed.set_pwm);
    }

    //raise dump trailer
    setTimeout(() => {
        if (white_rabbit.delivery_device === 'dump_trailer') {

            white_rabbit.servos.dump_tailer.set_pwm = white_rabbit.servos.dump_tailer.max_pwm;
            white_rabbit.servo_dump_tailer(white_rabbit, white_rabbit.servos.dump_tailer.set_pwm);
        }

    }, 1000);

    //lower dump trailer
    setTimeout(() => {
        if (white_rabbit.delivery_device === 'dump_trailer') {

            white_rabbit.servos.dump_tailer.set_pwm = white_rabbit.servos.dump_tailer.min_pwm;
            white_rabbit.servo_dump_tailer(white_rabbit, white_rabbit.servos.dump_tailer.set_pwm);
        }

    }, 10000);

    //lock dump tailer bed
    setTimeout(() => {
        if (white_rabbit.delivery_device === 'dump_trailer') {
            white_rabbit.servos.bed.set_pwm = white_rabbit.servos.dump_tailer.max_pwm;
            white_rabbit.servo_bed(white_rabbit, white_rabbit.servos.bed.set_pwm);
        }
    }, 15000);

};
module.exports = deliver_package_dump_trailer;