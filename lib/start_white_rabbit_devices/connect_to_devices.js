var connect_to_devices = function (white_rabbit) {

    white_rabbit.update_serialports(white_rabbit, true);

    if (white_rabbit.rplidar.connected === false && !white_rabbit.rplidar.reconnecting) {
      white_rabbit.lidar_connect(white_rabbit);
    }

    if (white_rabbit.pixhawk_port.connected === false) {
        //Serial: Start...................................
        white_rabbit.connect_to_robot_pixhawk(white_rabbit);
    }
    else {

        //GPIO: Start...................................
        if (white_rabbit.gpio.connected === false) {
            white_rabbit.gpio_connect(white_rabbit);
        }
    }


    if (white_rabbit.motor.motor_type === "ZLAC8015D") {
        if (!white_rabbit.zling.comName1_connected || !white_rabbit.zling.comName2_connected) {
            white_rabbit.connect_to_waveshare(white_rabbit);
        }
    }
    else if (white_rabbit.motor.motor_type === "DDSM115") {
        if (!white_rabbit.waveshare.connected) {
            white_rabbit.connect_to_waveshare(white_rabbit);
        }
    }
    else {
        // If motor type is not set or unknown, try to connect
        if (!white_rabbit.zling.comName1_connected || !white_rabbit.zling.comName2_connected || !white_rabbit.waveshare.connected) {
            white_rabbit.connect_to_waveshare(white_rabbit);
        }
    }
    
    if (white_rabbit.arduino.connected === false) {
        white_rabbit.connect_to_arduino(white_rabbit);
    }

    if (white_rabbit.ldr.connected === false) {
        white_rabbit.connect_to_ldr(white_rabbit);
    }


    if (white_rabbit.realsense.connected === false) {
        white_rabbit.connect_to_realsense(white_rabbit);
    }

    if (white_rabbit.imu && white_rabbit.imu.enable_imu && white_rabbit.imu_data.connected === false) {
        if (white_rabbit.imu.compass_type === 'witmotion') {
            white_rabbit.connect_to_witmotion(white_rabbit); // WitMotion HWT906 over I2C
        } else {
            white_rabbit.connect_to_imu(white_rabbit);        // BNO055 (rollback)
        }
    }

    if (!white_rabbit.lcd_screens.write_to_lcd_interval) {
        white_rabbit.connect_to_screens(white_rabbit);
    }

    if (white_rabbit.irlock.connected === false && !white_rabbit.irlock.connecting) {
        white_rabbit.connect_to_irlock(white_rabbit);
    }

};


module.exports = connect_to_devices;