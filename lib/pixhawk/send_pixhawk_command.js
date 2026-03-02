var send_pixhawk_command = function(rover, status_message, request, force_send)
	{
		if (rover.pixhawk_port.mavlink)
		{
			if (rover.pixhawk_port.connected)
			{
				rover.logs.send_pixhawk_command.log(rover, status_message);


				if (request)
				{

				
						rover.logs.send_pixhawk_command.log(rover, JSON.stringify(request));
						var p = null;

						try
						{
							p = new Buffer.from(request.pack(rover.pixhawk_port.mavlink));
						}
						catch (e)
						{
							rover.logs.send_pixhawk_command.log(rover, e);
							console.log('send_pixhawk_command: Pack Error!');
						}

						if (rover.sitl.on && p)
						{

							rover.sitl.client.write(p);
						}
						else if (p)
						{
							
							rover.pixhawk_port.serial.write(p);
						}

					
				}
				else
				{
					rover.logs.send_pixhawk_command.log(rover, 'Command Request Not Found');
					console.log('send_pixhawk_command: Command Request Not Found');
				}

			}
			else
			{
				rover.logs.send_pixhawk_command.log(rover, 'Drone not connected via mavlink');

			}

		}
		else
		{

			rover.logs.send_pixhawk_command.log(rover, 'Missing Radio');
		}

	};


module.exports = send_pixhawk_command;