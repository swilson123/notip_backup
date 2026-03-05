var calc_steering_and_rpm = function (rover, steering_angle_deg, base_rpm) {
    const wheelbase_in = 13; // distance between front and back wheels
    const track_width_in = 14.5; // distance between left/right wheels
    const half_wheelbase = wheelbase_in / 2;
    const half_track = track_width_in / 2;

    const angle = Number(steering_angle_deg) || 0;
    const rpm = Number(base_rpm) || 0;

    if (angle === 0) {
        return {
            servo_angles_deg: {
                front_driver: 0,
                back_driver: 0,
                front_passenger: 0,
                back_passenger: 0
            },
            motor_rpm: {
                front_driver: rpm,
                back_driver: rpm,
                front_passenger: rpm,
                back_passenger: rpm
            }
        };
    }

    const turn_left = angle > 0;
    const angle_rad = Math.abs(angle) * (Math.PI / 180);
    const radius_center = half_wheelbase / Math.tan(angle_rad);
    const safe_center = Math.max(Math.abs(radius_center), 0.0001);

    const inner_radius = Math.max(safe_center - half_track, 0.0001);
    const outer_radius = safe_center + half_track;

    const inner_angle = Math.atan2(half_wheelbase, inner_radius) * (180 / Math.PI);
    const outer_angle = Math.atan2(half_wheelbase, outer_radius) * (180 / Math.PI);

    const front_left_angle = turn_left ? inner_angle : outer_angle;
    const front_right_angle = turn_left ? outer_angle : inner_angle;
    const back_left_angle = -front_left_angle;
    const back_right_angle = -front_right_angle;

    const inner_wheel_radius = Math.hypot(inner_radius, half_wheelbase);
    const outer_wheel_radius = Math.hypot(outer_radius, half_wheelbase);

    const inner_rpm = rpm * (inner_wheel_radius / safe_center);
    const outer_rpm = rpm * (outer_wheel_radius / safe_center);

    const driver_rpm = turn_left ? inner_rpm : outer_rpm;
    const passenger_rpm = turn_left ? outer_rpm : inner_rpm;

    return {
        servo_angles_deg: {
            front_driver: front_left_angle,
            back_driver: back_left_angle,
            front_passenger: front_right_angle,
            back_passenger: back_right_angle
        },
        motor_rpm: {
            front_driver: driver_rpm,
            back_driver: driver_rpm,
            front_passenger: passenger_rpm,
            back_passenger: passenger_rpm
        }
    };
};

module.exports = calc_steering_and_rpm;
