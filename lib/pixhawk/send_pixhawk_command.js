var send_pixhawk_command = function(white_rabbit, status_message, request, force_send)
	{
		if (white_rabbit.pixhawk_port.mavlink)
		{
			if (white_rabbit.pixhawk_port.connected)
			{
				white_rabbit.logs.send_pixhawk_command.log(white_rabbit, status_message);


				if (request)
				{

				
						white_rabbit.logs.send_pixhawk_command.log(white_rabbit, JSON.stringify(request));
						var p = null;

						try
						{
							p = new Buffer.from(request.pack(white_rabbit.pixhawk_port.mavlink));
						}
						catch (e)
						{
							white_rabbit.logs.send_pixhawk_command.log(white_rabbit, e);
							console.log('send_pixhawk_command: Pack Error!');
						}

						if (white_rabbit.sitl.on && p)
						{

							white_rabbit.sitl.client.write(p);
						}
						else if (p)
						{
							
							white_rabbit.pixhawk_port.serial.write(p);
						}

					
				}
				else
				{
					white_rabbit.logs.send_pixhawk_command.log(white_rabbit, 'Command Request Not Found');
					console.log('send_pixhawk_command: Command Request Not Found');
				}

			}
			else
			{
				white_rabbit.logs.send_pixhawk_command.log(white_rabbit, 'Drone not connected via mavlink');

			}

		}
		else
		{

			white_rabbit.logs.send_pixhawk_command.log(white_rabbit, 'Missing Radio');
		}

	};


module.exports = send_pixhawk_command;