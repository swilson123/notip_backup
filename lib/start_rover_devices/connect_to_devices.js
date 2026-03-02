var connect_to_devices = function (rover) {

    rover.update_serialports(rover, true);

    if (rover.rplidar.connected === false) {
      rover.lidar_connect(rover);
    }

    if (rover.pixhawk_port.connected === false) {
        //Serial: Start...................................
        rover.connect_to_robot_pixhawk(rover);
    }
    else {

        //GPIO: Start...................................
        if (rover.gpio.connected === false) {
            rover.gpio_connect(rover);
        }
    }


    if (rover.motor.motor_type === "ZLAC8015D") {
        if (!rover.zling.comName1_connected || !rover.zling.comName2_connected) {
            rover.connect_to_waveshare(rover);
        }
    }
    else if (rover.motor.motor_type === "DDSM115") {
        if (!rover.waveshare.connected) {
            rover.connect_to_waveshare(rover);
        }
    }
    else {
        // If motor type is not set or unknown, try to connect
        if (!rover.zling.comName1_connected || !rover.zling.comName2_connected || !rover.waveshare.connected) {
            rover.connect_to_waveshare(rover);
        }
    }
    
    if (rover.arduino.connected === false) {
        rover.connect_to_arduino(rover);
    }
};


module.exports = connect_to_devices;