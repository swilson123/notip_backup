var carrot = function (white_rabbit) {

    //carrot the goal of this function is to use edge left XY and edge right XY to provide Noah a carrot to follow.
    //this carrot is what guides noah down the yellow_brick_road.
    //Keep Noah always facing forward on the sidewalk is key.

    // Captured before this tick overwrites steering_angle_deg, so the rate limiter at the
    // bottom of this function knows what Noah was actually commanded last tick.
    var _prev_steering_angle_deg = (typeof white_rabbit.motor.steering_angle_deg === 'number') ? white_rabbit.motor.steering_angle_deg : 0;

    //confidence thresholds for path detection
    //white_rabbit.realsense.path_detection.edge_left_conf
    //white_rabbit.realsense.path_detection.edge_right_conf

    //Edge X and Y coordinates in meters
    //white_rabbit.realsense.path_detection.edge_left_x_m
    //white_rabbit.realsense.path_detection.edge_right_x_m
    //white_rabbit.realsense.path_detection.edge_left_y_m
    //white_rabbit.realsense.path_detection.edge_right_y_m

    //carrot.................................................................
    var carrot_angle = 0;
    var carrot_left_angle = 0;
    var carrot_right_angle = 0;


    if (white_rabbit.realsense.path_detection.edge_left_x_m) {
        //Left Edge....edge left is always negative...............................................
        var edge_left_spike = white_rabbit.realsense.path_detection.last_known_edge_left_x_m + white_rabbit.realsense.path_detection.edge_left_x_m;


        if (edge_left_spike > 1.5 || edge_left_spike < -1.5) {
            //edge left is a spike, use last known edge left x
            white_rabbit.realsense.path_detection.edge_left_x_m = white_rabbit.realsense.path_detection.last_known_edge_left_x_m;
            carrot_left_angle = 0.8 + white_rabbit.realsense.path_detection.last_known_edge_left_x_m;
        }
        else {
            carrot_left_angle = 0.6 + white_rabbit.realsense.path_detection.edge_left_x_m;
        }

    }


    if (white_rabbit.realsense.path_detection.edge_right_x_m) {
        //right edge edge right is always possitive....................................................
        var edge_right_spike = white_rabbit.realsense.path_detection.last_known_edge_right_x_m - white_rabbit.realsense.path_detection.edge_right_x_m;

        if (edge_right_spike > 1.5 || edge_right_spike < -1.5) {
            //edge right is a spike, use last known edge right x
            white_rabbit.realsense.path_detection.edge_right_x_m = white_rabbit.realsense.path_detection.last_known_edge_right_x_m;
            carrot_right_angle = white_rabbit.realsense.path_detection.last_known_edge_right_x_m - 0.8;
        }
        else {
            carrot_right_angle = white_rabbit.realsense.path_detection.edge_right_x_m - 0.6;
        }
    }
    else {
        carrot_angle = 0;
    }



    //last known edges.............................................
    if (white_rabbit.realsense.path_detection.edge_left_x_m) {
        white_rabbit.realsense.path_detection.last_known_edge_left_x_m = white_rabbit.realsense.path_detection.edge_left_x_m;
    }

    if (white_rabbit.realsense.path_detection.edge_right_x_m) {
        white_rabbit.realsense.path_detection.last_known_edge_right_x_m = white_rabbit.realsense.path_detection.edge_right_x_m;
    }

    if (white_rabbit.realsense.path_detection.edge_left_y_m) {
        white_rabbit.realsense.path_detection.last_known_edge_left_y_m = white_rabbit.realsense.path_detection.edge_left_y_m;
    }

    if (white_rabbit.realsense.path_detection.edge_right_y_m) {
        white_rabbit.realsense.path_detection.last_known_edge_right_y_m = white_rabbit.realsense.path_detection.edge_right_y_m;
    }

    //if (white_rabbit.realsense.path_detection.edge_left_conf > .50) {
    //use left edge: x is negative, y is positive

    // }
    // else if (white_rabbit.realsense.path_detection.edge_right_conf > .50) {
    //     //use right edge: x is positive, y is positive
    //     var edge_difference = white_rabbit.realsense.path_detection.edge_right_x_m - 0.6;
    // }
    // else {
    //     var edge_difference = 0;
    // }


    // //edge left sum
    // var edge_left_sum = .5 + Math.abs(white_rabbit.realsense.path_detection.edge_left_y_m);

    // //edge right sum
    // var edge_right_sum = .5 + Math.abs(white_rabbit.realsense.path_detection.edge_right_y_m);

    // var edge_difference = 0;
    // // if (edge_left_sum > edge_right_sum) {
    // //     //turn left
    // //     edge_difference = (edge_left_sum - edge_right_sum) * -1;
    // // }
    // // else if (edge_right_sum > edge_left_sum) {
    // //     //turn right
    // //     edge_difference = edge_right_sum - edge_left_sum;
    // // }

    // white_rabbit.realsense.path_detection.edge_left_y_m = white_rabbit.realsense.path_detection.edge_left_y_m * -1;

    //var edge_difference = white_rabbit.realsense.path_detection.edge_left_x_m  + white_rabbit.realsense.path_detection.edge_right_x_m;

    white_rabbit.motor.steering_angle_deg = carrot_left_angle * 30;


    if (white_rabbit.motor.steering_angle_deg > 10) {
        white_rabbit.motor.steering_angle_deg = 10;
    }

    if (white_rabbit.motor.steering_angle_deg < -10) {
        white_rabbit.motor.steering_angle_deg = -10;
    }

    //console.log("edge_difference: " + white_rabbit.realsense.path_detection.edge_left_conf + " " + white_rabbit.realsense.path_detection.edge_right_conf + " " + edge_difference);


    console.log("steering_angle_deg: " + white_rabbit.motor.steering_angle_deg);

    //return carrot steering angle to follow the carrot........
    return white_rabbit.motor.steering_angle_deg;




};
module.exports = carrot;