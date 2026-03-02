var connect_to_sitl = function(rover)
	{

		rover.sitl.client = new rover.net.Socket();


		rover.sitl.client.connect(rover.sitl.port, rover.sitl.host, function()
		{


			rover.logs.server.log(rover, "SITL Port is open");


			rover.pixhawk_port.mavlink = new MAVLink(null, rover.pixhawk_port.targetSystem, rover.pixhawk_port.targetComponent);
			rover.pixhawk_port.connected = true;

			rover.request_data_stream(rover);

			


			rover.sitl.client.on('data', function(data)
			{

				rover.pixhawk_port.mavlink.parseBuffer(data);
			});

			//On pixhawk usb/serial port message...........................
			rover.pixhawk_port.mavlink.on("message", function(message)
			{
				//console.log(message);
				rover.pixhawk_message_handler(rover, message);

			});

		});


		rover.sitl.client.on('close', function()
		{

			rover.logs.server.log(rover, "SITL Connection closed");
			setTimeout(function()
			{
				rover.init_robotkit(rover);
				rover.connect_to_sitl(rover);
			}, 3000);
		});


		rover.sitl.client.on('error', function()
		{

			rover.logs.server.log(rover, "SITL Connection error");
		});

	};


module.exports = connect_to_sitl;