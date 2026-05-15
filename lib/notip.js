/*
#========================================================================================================================================== #
..................................................................Global Variables.........................................................
#========================================================================================================================================== #
*/

var notip_init = function (config) {
    const rover = {
        motor: {
            motor_type: config.motor_type,
            motor_steering: config.motor_steering,
            throttle_percentage: config.throttle_percentage ? config.throttle_percentage / 100 : .25,
            motor_speed_cmd: 0,
            last_motor_speed_cmd: 0,
            current_steering_type: "two_wheels",
            steering_angle_deg: 0
        },
        nav_tuning: {
            two_wheel_steering_gain: config.nav_tuning && typeof config.nav_tuning.two_wheel_steering_gain === 'number' ? config.nav_tuning.two_wheel_steering_gain : 0.3,
            two_wheel_steering_deadband_deg: config.nav_tuning && typeof config.nav_tuning.two_wheel_steering_deadband_deg === 'number' ? config.nav_tuning.two_wheel_steering_deadband_deg : 3,
            two_wheel_max_steering_deg: config.nav_tuning && typeof config.nav_tuning.two_wheel_max_steering_deg === 'number' ? config.nav_tuning.two_wheel_max_steering_deg : 8,
            two_wheel_max_steering_delta_deg: config.nav_tuning && typeof config.nav_tuning.two_wheel_max_steering_delta_deg === 'number' ? config.nav_tuning.two_wheel_max_steering_delta_deg : 2,
            two_wheel_slowdown_yaw_low_deg: config.nav_tuning && typeof config.nav_tuning.two_wheel_slowdown_yaw_low_deg === 'number' ? config.nav_tuning.two_wheel_slowdown_yaw_low_deg : 6,
            two_wheel_slowdown_yaw_medium_deg: config.nav_tuning && typeof config.nav_tuning.two_wheel_slowdown_yaw_medium_deg === 'number' ? config.nav_tuning.two_wheel_slowdown_yaw_medium_deg : 10,
            two_wheel_slowdown_yaw_high_deg: config.nav_tuning && typeof config.nav_tuning.two_wheel_slowdown_yaw_high_deg === 'number' ? config.nav_tuning.two_wheel_slowdown_yaw_high_deg : 15,
            two_wheel_speed_limit_low: config.nav_tuning && typeof config.nav_tuning.two_wheel_speed_limit_low === 'number' ? config.nav_tuning.two_wheel_speed_limit_low : 130,
            two_wheel_speed_limit_medium: config.nav_tuning && typeof config.nav_tuning.two_wheel_speed_limit_medium === 'number' ? config.nav_tuning.two_wheel_speed_limit_medium : 95,
            two_wheel_speed_limit_high: config.nav_tuning && typeof config.nav_tuning.two_wheel_speed_limit_high === 'number' ? config.nav_tuning.two_wheel_speed_limit_high : 70,
            mission_yaw_start_deg: config.nav_tuning && typeof config.nav_tuning.mission_yaw_start_deg === 'number' ? config.nav_tuning.mission_yaw_start_deg : 20,
            mission_yaw_stop_deg: config.nav_tuning && typeof config.nav_tuning.mission_yaw_stop_deg === 'number' ? config.nav_tuning.mission_yaw_stop_deg : 6,
            mission_yaw_stable_cycles: config.nav_tuning && typeof config.nav_tuning.mission_yaw_stable_cycles === 'number' ? config.nav_tuning.mission_yaw_stable_cycles : 3,
            mission_yaw_gain: config.nav_tuning && typeof config.nav_tuning.mission_yaw_gain === 'number' ? config.nav_tuning.mission_yaw_gain : 1.1,
            mission_yaw_min_speed: config.nav_tuning && typeof config.nav_tuning.mission_yaw_min_speed === 'number' ? config.nav_tuning.mission_yaw_min_speed : 18,
            mission_yaw_max_speed: config.nav_tuning && typeof config.nav_tuning.mission_yaw_max_speed === 'number' ? config.nav_tuning.mission_yaw_max_speed : 40,
            mission_yaw_brake_window_deg: config.nav_tuning && typeof config.nav_tuning.mission_yaw_brake_window_deg === 'number' ? config.nav_tuning.mission_yaw_brake_window_deg : 15
        },
        imu: {
            compass_offset_deg: config.imu && typeof config.imu.compass_offset_deg === 'number' ? config.imu.compass_offset_deg : 0
        },
        zling: {
            comName1: config.motor_driver1_comName,
            comName1_connected: false,
            comName2: config.motor_driver2_comName,
            comName2_connected: false,
            baudrate: 115200,
            slave1_Id: 1,
            slave2_Id: 1,
            REG_CONTROL_WORD: 0x200E,
            REG_OP_MODE: 0x200D,
            REG_L_TARGET_RPM: 0x2088,
            REG_R_TARGET_RPM: 0x2089,
            REG_L_FEEDBACK: 0x20AB,
            REG_R_FEEDBACK: 0x20AC,
        },
        gps: null,
        pixhawk_port: {
            comName: config.pixhawk_comName,
            configuredComName: config.pixhawk_comName,
            baudrate: 57600,
            serial: null,
            mavlink: null,
            ping_num: 0,
            targetSystem: 1,
            targetComponent: 0,
            connected: false,
            opening: false,
            heartbeatTimeout: null,
            heartbeatTimeoutMs: 10000
        },
        gps: {
            latitude: 0,
            longitude: 0,
            altitude: 0,
        },
        pixhawk: {},
        pixhawk_drone: {},
        message_count: 0,
        commandSystem: 1,
        commandComponent: 1,
        targetSystem: 1,
        targetComponent: 0,
        dateFormat: require('dateformat'),
        fs: require('fs'),
        net: require('net'),
        SerialPort: require("serialport").SerialPort,
        Readline: require('@serialport/parser-readline').ReadlineParser,
        mavlink: require("./pixhawk/mavlink2.js"),
        init_logs: require("./logging/init_logs.js"),
        create_logs: require("./logging/create_logs.js"),
        logging: require("./logging/logging.js"),
        update_serialports: require('./serial/update_serialports.js'),
        request_data_stream: require('./pixhawk/request_data_stream.js'),
        mavlink_messages: require('./pixhawk/mavlink_messages.js'),
        send_pixhawk_command: require('./pixhawk/send_pixhawk_command.js'),
        pixhawk_message_handler: require('./pixhawk/pixhawk_message_handler.js'),
        set_flight_mode: require('./pixhawk/set_flight_mode.js'),
        update_mav_mode: require('./pixhawk/update_mav_mode.js'),
        gpio_connect: require('./gpio/gpio_connect.js'),
        lidar_connect: require('./lidar/lidar_connect.js'),
        lidar_message_handler: require('./lidar/lidar_message_handler.js'),
        GPS: require("gps"),
        gps_distance: require('gps-distance'),
        angles: require("angles"),
        bufferpack: require("bufferpack"),
        connect_to_robot_pixhawk: require("./pixhawk/connect_to_robot_pixhawk.js"),
        init_robotkit: require('./robotkit/init_robotkit.js'),
        connect_to_sitl: require('./robotkit/connect_to_sitl.js'),
        deliver_package: require('./mission/deliver_package.js'),
        mission_item_reached: require('./mission/mission_item_reached.js'),
        download_mission: require('./mission/download_mission.js'),
        reset_rover: require('./mission/reset_rover.js'),
        disarm_robot: require('./pixhawk/disarm_robot.js'),
        mission_item_array: require('./mission/mission_item_array.js'),
        guided_mode_command: require('./mission/guided_mode_command.js'),
        avoid_object: require('./mission/avoid_object.js'),
        get_bearing: require('./mission/get_bearing.js'),
        servo_bed: require('./servos/servo_bed.js'),
        servo_arm_driver_side: require('./servos/servo_arm_driver_side.js'),
        servo_arm_passenger_side: require('./servos/servo_arm_passenger_side.js'),
        servo_dump_tailer: require('./servos/servo_dump_tailer.js'),
        set_delivery_type: require('./package_delivery/set_delivery_type.js'),
        set_arm_delivery: require('./package_delivery/set_arm_delivery.js'),
        set_dump_trailer_delivery: require('./package_delivery/set_dump_trailer_delivery.js'),
        deliver_package_arm: require('./package_delivery/deliver_package_arm.js'),
        deliver_package_dump_trailer: require('./package_delivery/deliver_package_dump_trailer.js'),
        connect_to_devices: require('./start_rover_devices/connect_to_devices.js'),
        preform_turn: require('./mission/preform_turn.js'),
        delivery_device: null,
        servos: {
            arm_driver_side: { min_pwm: 750, trim_pwm: 1400, max_pwm: 2000, set_pwm: 750, servo_id: null  },
            arm_passenger_side: { min_pwm: 1900, trim_pwm: 1250, max_pwm: 650, set_pwm: 1900, servo_id: null },
            dump_tailer: { min_pwm: 1000, trim_pwm: 1500, max_pwm: 1600, set_pwm: 1000, servo_id: null },
            bed: { min_pwm: 1000, trim_pwm: 1500, max_pwm: 2000, set_pwm: 1000, servo_id: null },
            motor_front_driver: { set_pwm: 1500, commanded_pwm: 1500, servo_id: 11 },
            motor_back_driver: { set_pwm: 1500, commanded_pwm: 1500, servo_id: 12 },
            motor_front_passenger: { set_pwm: 1500, commanded_pwm: 1500, servo_id: 13 },
            motor_back_passenger: { set_pwm: 1500, commanded_pwm: 1500, servo_id: 14 },
        },
        gpio: {
            connected: false,
            gpio_comName: config.gpio_comName ? config.gpio_comName : null,
        },
        rplidar: {
            connected: false,
            reconnecting: false,
            rplidar_directory: config.rplidar_directory,
            comName: config.rplidar_comName,
            motor_gpio_pin: config.rplidar_motor_gpio != null ? config.rplidar_motor_gpio : null,
            motor_gpio_chip: 'gpiochip0',
            avoid_object: false,
            red_light_green_light: null
        },
        rc_contoller: {
            pause_cmd: false,
            connected: false
        },
        flight_mode_trigger: null,
        sitl: {
            on: false,
            port: 5760,
            host: '127.0.0.1',
            robotkit: null
        },
        logs: {
            count: 1
        },
        robot_data: {
            is_armed: false,
            mission_mode: false,
            robot_latitude: 0,
            robot_longitude: 0,
            LOCAL_POSITION_NED: {},
            GLOBAL_POSITION_INT: {
                lat: 0,
                lon: 0
            },
            HEARTBEAT: {},
            SYS_STATUS: {},
            STATUSTEXT: {},
            ATTITUDE: {},
            VFR_HUD: {},
            GLOBAL_POSITION_INT: {
                lat: 0,
                lon: 0
            },
            SERVO_OUTPUT_RAW: {},
            LOCAL_POSITION_NED: {},
            ATTITUDE_QUATERNION: {},
            HIGHRES_IMU: {},
            GPS_RAW_INT: {},
            PING: {},
            SYSTEM_TIME: {},
            RANGEFINDER: {},
            MISSION_CURRENT: {},
            COMMAND_ACK: {},
            PARAM_ACK: {},
            MISSION_ACK: {},
            PARAM_VALUE: {},
            DISTANCE_SENSOR: {}
        },
        flight_data: {
            mission_step: null,
            launch_location: {},
            land_location: {},
            current_location: {},
            horizontal_distance_m: 0,
            vertical_distance_m: 0,
            inflight: 0,
            flight_type: null,
            manual_intervention: null,
            control_type: null,
            robot_help: null,
            help_reason: null,
            robot_modem_signal_strength: null,
            robot_flight_mode: null,
            robot_alert: null,
            robot_delivery_state: null,
            robot_claw_state: null,
            robot_dropoff_status: null,
            travel_speed: null,
            mav_state: null,
            robot_base_mode: null,
            package_delivered: null,
            bowl_distance_m: null,
            land_robot: null,
            launch_command_received: null,
            recall_cammand_received: null

        },
        FlightModes: {
            0: 'Manual',
            1: 'Acro',
            3: 'Steering',
            4: 'Hold',
            5: 'Loiter',
            6: 'Follow',
            7: 'Simple',
            10: 'Auto',
            11: 'RTL',
            12: 'SMART_RTL',
            15: 'Guided',
            72: 'Circle'
        },
        MavStates: {
            0: 'MAV_STATE_UNINIT',
            1: 'MAV_STATE_BOOT',
            2: 'MAV_STATE_CALIBRATING',
            3: 'MAV_STATE_STANDBY',
            4: 'MAV_STATE_ACTIVE',
            5: 'MAV_STATE_CRITICAL',
            6: 'MAV_STATE_EMERGENCY',
            7: 'MAV_STATE_POWEROFF',
            8: 'MAV_STATE_ENUM_END'

        },
        altitude: {
            take_off_msl_alt_meters: 0,
            rangefinder_alt_meters: 0,
            relative_alt_meters: 0,
            msl_alt_meters: 0,
            updating_travel_alt: false
        },
        mission: {
            last_reached_mission_seq: 0,
            current_mission_seq: 0,
            mission_count: 0,
            package_delivered: false,
            waypoints: [],
            path_clear: true,
            mission_interval: null,
            auto_delivery: false,
            package_delivery_yaw: null,
            finished_package_yaw: null,
            pause_mission: false

        },
        guided_mode_command_robot: {
            mav_frame: 8,
            type_mask: '0b100111111000',
            yaw_rate: 0.5,
        },
        zones: [
            { zone: 1, light: "red", min_angle: 30, max_angle: 60, min_distance_mm: 100, max_distance_mm: 2000, timestamp: null, distance_mm: null, angle: null },
            { zone: 2, light: "red", min_angle: 60, max_angle: 90, min_distance_mm: 100, max_distance_mm: 2000, timestamp: null, distance_mm: null, angle: null },
            { zone: 3, light: "red", min_angle: 90, max_angle: 120, min_distance_mm: 100, max_distance_mm: 2000, timestamp: null, distance_mm: null, angle: null },
            { zone: 4, light: "red", min_angle: 120, max_angle: 150, min_distance_mm: 100, max_distance_mm: 2000, timestamp: null, distance_mm: null, angle: null },
            { zone: 5, light: "red", min_angle: 150, max_angle: 180, min_distance_mm: 100, max_distance_mm: 2000, timestamp: null, distance_mm: null, angle: null },
            { zone: 6, light: "red", min_angle: 180, max_angle: 210, min_distance_mm: 100, max_distance_mm: 2000, timestamp: null, distance_mm: null, angle: null },
            { zone: 7, light: "red", min_angle: 210, max_angle: 240, min_distance_mm: 100, max_distance_mm: 2000, timestamp: null, distance_mm: null, angle: null },
            { zone: 8, light: "red", min_angle: 240, max_angle: 270, min_distance_mm: 100, max_distance_mm: 2000, timestamp: null, distance_mm: null, angle: null },
            { zone: 9, light: "red", min_angle: 270, max_angle: 300, min_distance_mm: 100, max_distance_mm: 2000, timestamp: null, distance_mm: null, angle: null },
            { zone: 10, light: "red", min_angle: 300, max_angle: 330, min_distance_mm: 100, max_distance_mm: 2000, timestamp: null, distance_mm: null, angle: null },
            { zone: 11, light: "red", min_angle: 330, max_angle: 360, min_distance_mm: 100, max_distance_mm: 2000, timestamp: null, distance_mm: null, angle: null },
            { zone: 12, light: "red", min_angle: 0, max_angle: 30, min_distance_mm: 100, max_distance_mm: 2000, timestamp: null, distance_mm: null, angle: null },
        ],
        mav_version: 1,
        waveshare: {
            baudrate: 115200,
            port_path: config.waveshare_comName,
            connected: false,
            serial: null,
            parser: null
        },
        arduino:{
            baudrate: 115200,
            port_path: config.arduino_comName,
            connected: false,
            serial: null,
            parser: null,
            received_data:{}

        },
        realsense:{
            baudrate: 115200,
            port_path: config.realsense_comName,
            connected: false,
            connecting: false,
            transport: null,
            serial: null,
            parser: null,
            process: null,
            stdout_buffer: '',
            stderr_buffer: '',
            received_data:{},
            last_status: null,
            last_detection_log_ts: 0,
            objects: [],
            path_detection: {
                offset_meters: 0,
                path_width_meters: 0,
                confidence: 0,
                left_boundary_visible: false,
                right_boundary_visible: false,
                timestamp: 0,
                fps_current: 0,
                fps_target: 0,
                cpu_percent: 0,
                centerline: [],
                source: null
            },
            vision: {
                enabled: config.realsense_vision ? config.realsense_vision.enabled !== false : false,
                python_path: config.realsense_vision && config.realsense_vision.python_path ? config.realsense_vision.python_path : 'python3',
                script_path: config.realsense_vision && config.realsense_vision.script_path ? config.realsense_vision.script_path : './lib/realsense/realsense_vision.py',
                width: config.realsense_vision && typeof config.realsense_vision.width === 'number' ? config.realsense_vision.width : 640,
                height: config.realsense_vision && typeof config.realsense_vision.height === 'number' ? config.realsense_vision.height : 480,
                fps_normal: config.realsense_vision && typeof config.realsense_vision.fps_normal === 'number' ? config.realsense_vision.fps_normal : 15,
                fps_high_cpu: config.realsense_vision && typeof config.realsense_vision.fps_high_cpu === 'number' ? config.realsense_vision.fps_high_cpu : 10,
                fps_critical_cpu: config.realsense_vision && typeof config.realsense_vision.fps_critical_cpu === 'number' ? config.realsense_vision.fps_critical_cpu : 7,
                cpu_high_threshold: config.realsense_vision && typeof config.realsense_vision.cpu_high_threshold === 'number' ? config.realsense_vision.cpu_high_threshold : 70,
                cpu_critical_threshold: config.realsense_vision && typeof config.realsense_vision.cpu_critical_threshold === 'number' ? config.realsense_vision.cpu_critical_threshold : 85,
                confidence_threshold: config.realsense_vision && typeof config.realsense_vision.confidence_threshold === 'number' ? config.realsense_vision.confidence_threshold : 0.6,
                correction_direction: config.realsense_vision && typeof config.realsense_vision.correction_direction === 'number' ? config.realsense_vision.correction_direction : -1,
                path_center_deadband_m: config.realsense_vision && typeof config.realsense_vision.path_center_deadband_m === 'number' ? config.realsense_vision.path_center_deadband_m : 0.03,
                stale_detection_ms: config.realsense_vision && typeof config.realsense_vision.stale_detection_ms === 'number' ? config.realsense_vision.stale_detection_ms : 1200,
                camera_height_m: config.realsense_vision && typeof config.realsense_vision.camera_height_m === 'number' ? config.realsense_vision.camera_height_m : 0.406,
                rover_width_m: config.realsense_vision && typeof config.realsense_vision.rover_width_m === 'number' ? config.realsense_vision.rover_width_m : 0.432,
                rover_length_m: config.realsense_vision && typeof config.realsense_vision.rover_length_m === 'number' ? config.realsense_vision.rover_length_m : 0.686,
                object_detection_enabled: config.realsense_vision ? config.realsense_vision.object_detection_enabled !== false : true,
                object_max_distance_m: config.realsense_vision && typeof config.realsense_vision.object_max_distance_m === 'number' ? config.realsense_vision.object_max_distance_m : 2.0,
                object_min_height_m: config.realsense_vision && typeof config.realsense_vision.object_min_height_m === 'number' ? config.realsense_vision.object_min_height_m : 0.127, // 5 inches
                object_min_area_px: config.realsense_vision && typeof config.realsense_vision.object_min_area_px === 'number' ? config.realsense_vision.object_min_area_px : 200,
                object_emergency_stop_m: config.realsense_vision && typeof config.realsense_vision.object_emergency_stop_m === 'number' ? config.realsense_vision.object_emergency_stop_m : 1.0,
                segmentation_model_path: config.realsense_vision && config.realsense_vision.segmentation_model_path ? config.realsense_vision.segmentation_model_path : '',
                segmentation_input_width: config.realsense_vision && typeof config.realsense_vision.segmentation_input_width === 'number' ? config.realsense_vision.segmentation_input_width : 512,
                segmentation_input_height: config.realsense_vision && typeof config.realsense_vision.segmentation_input_height === 'number' ? config.realsense_vision.segmentation_input_height : 256,
                sidewalk_seek_offset_m: config.realsense_vision && typeof config.realsense_vision.sidewalk_seek_offset_m === 'number' ? config.realsense_vision.sidewalk_seek_offset_m : 0.1,
                sidewalk_seek_exit_m: config.realsense_vision && typeof config.realsense_vision.sidewalk_seek_exit_m === 'number' ? config.realsense_vision.sidewalk_seek_exit_m : 0.08,
                sidewalk_seek_confidence_threshold: config.realsense_vision && typeof config.realsense_vision.sidewalk_seek_confidence_threshold === 'number' ? config.realsense_vision.sidewalk_seek_confidence_threshold : 0.4,
                detection_history_ms: config.realsense_vision && typeof config.realsense_vision.detection_history_ms === 'number' ? config.realsense_vision.detection_history_ms : 10000,
                max_lateral_adjust_m: config.realsense_vision && typeof config.realsense_vision.max_lateral_adjust_m === 'number' ? config.realsense_vision.max_lateral_adjust_m : 0.5,
                carrot_distance_m: config.realsense_vision && typeof config.realsense_vision.carrot_distance_m === 'number' ? config.realsense_vision.carrot_distance_m : 1.5
            }

        },
        claw:{
            rc_claw: 1500,
            rc_belt: null,
            rc_actuator: null,
            rc_telescope: null
        },
        dock:{
             dock_state: null,
             dock_latitude: null,
             dock_longitude: null,
             dock_pitch: null,
             dock_heading: null,
             undock_latitude: null,
             undock_longitude: null,
             undock_pitch: null,
             undock_heading: null,
             rc_dock: 1500,
             undock_interval: null,
             undock_complete_timeout: null        
        },
        undock_rover: require("./dock/undock_rover"),
        dock_rover: require("./dock/dock_rover"),
        connect_to_waveshare: require("./waveshare/connect_to_waveshare"),
        create_waveshare_message: require("./waveshare/create_waveshare_message"),
        radio_commands: require("./radio_controller/radio_commands"),
        move_rover: require("./waveshare/move_rover"),
        servo_send_command: require("./servos/servo_send_command"),
        get_heading: require("./navigation/get_heading"),
        get_pitch: require("./navigation/get_pitch"),
        calculate_bearing: require("./navigation/calculate_bearing"),
        go_to_waypoint: require("./navigation/go_to_waypoint"),
        yaw_rover: require("./navigation/yaw_rover"),
        run_mission: require("./navigation/run_mission"),
        angle_to_pwm: require("./navigation/angle_to_pwm"),
        calc_steering_and_rpm: require("./navigation/calc_steering_and_rpm"),
        calc_speed_based_on_distance: require("./navigation/calc_speed_based_on_distance"),
        ModbusRTU: require("modbus-serial"),
        calc_motor_rpm_value: require("./navigation/calc_motor_rpm_value"),
        zling_motor_test: require("./waveshare/zling_motor_test.js"),
        ddsm_motor_test: require("./waveshare/ddsm_motor_test.js"),
        connect_to_arduino: require("./arduino/connect_to_arduino"),
        arduino_message_handler: require("./arduino/arduino_message_handler"),
        create_arduino_message: require("./arduino/create_arduino_message"),
        radio_claw_commands: require("./radio_controller/radio_claw_commands"),
        radio_dock_commands: require("./radio_controller/radio_dock_commands"),
        opposite_pwm: require("./navigation/opposite_pwm"),
        throttle_up: require("./navigation/throttle_up"),
        yaw_rover_for_package_delivery: require("./navigation/yaw_rover_for_package_delivery"),
        pwm_to_angle: require("./navigation/pwm_to_angle"),
        connect_to_realsense: require("./realsense/connect_to_realsense"),
        realsense_message_handler: require("./realsense/realsense_message_handler"),
        create_realsense_message: require("./realsense/create_realsense_message"),
        waveshare_message_handler: require("./waveshare/waveshare_message_handler"),
        i2c: require('i2c-bus'),
        connect_to_screens: require('./lcd_screen/connect_to_lcd.js'),
        write_to_lcd: require('./lcd_screen/write_to_lcd.js'),
        lcd_screens: {
            write_to_lcd_interval: null,
            screen1: { address: 0x27, connected: false },
            screen2: { address: 0x26, connected: false },
            screen3: { address: 0x25, connected: false}
         },
        connect_to_imu: require('./imu/connect_to_imu.js'),
        send_imu_to_pixhawk: require('./imu/send_imu_to_pixhawk.js'),
        imu_send_to_pixhawk_interval: null,
        imu_data:{
            connected: false,
            heading: 0,
            roll: 0,
            pitch: 0,
            quaternion: { w: 0, x: 0, y: 0, z: 0 },
            linear_accel: { x: 0, y: 0, z: 0 },
            gravity: { x: 0, y: 0, z: 0 },
            temperature_c: null,
            calibration: { system: 0, gyro: 0, accel: 0, mag: 0 },
            timestamp: null,
            poll_interval: null
        }

    };

    // host information used by logging
    rover.hostname = require('os').hostname();

    //Logs: Create..............
    rover.init_logs(rover);


    //SITL: Software in the loop settings...................
    if (rover.sitl.on) {

        rover.init_robotkit(rover);

        setTimeout(function () {
            rover.connect_to_sitl(rover);
        }, 2000);

    }


};

module.exports = notip_init;



