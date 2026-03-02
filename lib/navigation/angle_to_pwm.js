var angle_to_pwm = function (angle) {
   
 
    var minAngle = -90;
    var maxAngle = 90;
    var minPwm = 500;
    var maxPwm = 2500;
    var trim = 1500;
     // Clamp angle
    const clampedAngle = Math.max(minAngle, Math.min(maxAngle, angle));

    // Ranges from center
    const posRange = maxPwm - trim; // +90°
    const negRange = trim - minPwm; // -90°

    let pwm1;

    // Servo 1 normal mapping
    if (clampedAngle >= 0) {
        pwm1 = trim + (clampedAngle / maxAngle) * posRange;
    } else {
        pwm1 = trim + (clampedAngle / minAngle) * -negRange;
    }

    // Servo 2 reversed: mirror around the trim point
    const pwm2 = trim - (pwm1 - trim);

    return {
        servo1: Math.round(pwm1),
        servo2: Math.round(pwm2)
    };
}

module.exports = angle_to_pwm;