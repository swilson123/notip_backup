//sends message to radio and websocket........................
var init_robotkit = function(white_rabbit)
	{
		if (!white_rabbit.sitl.robotkit && white_rabbit.mav_version == 1)
		{
			//Run this command from terminal: robotkit-sitl copter --home=39.28389,-84.3016354,584,353
			//robotkit-sitl ./lib/robotkit/arducopter --home=39.28389,-84.3016354,584,353
			var command = "robotkit-sitl copter --home=" + white_rabbit.sitl.lat + "," + white_rabbit.sitl.lon + ",584,353";
			//var command = "robotkit-sitl copter --home=" + white_rabbit.sitl.lat + "," + white_rabbit.sitl.lon + ",584,353";
			//Start python ready_to_localize script......................
			white_rabbit.sitl.robotkit = white_rabbit.exec(command, function(error, stdout, stderr)
			{
				if (error)
				{

					white_rabbit.logs.robotkit.log(white_rabbit, 'ERROR Dronekit:\n' + error);
					setTimeout(function()
					{
						white_rabbit.init_robotkit(white_rabbit);
					}, 1000);

					white_rabbit.sitl.robotkit = null;

				}

			});

			white_rabbit.sitl.robotkit.stdout.on('data', function(v)
			{
				white_rabbit.logs.robotkit.log(white_rabbit, v.toString());
			});

			white_rabbit.sitl.robotkit.stdout.on('error', function(e)
			{
				console.log('robotkit: ', e);
			});

		}
		else if (!white_rabbit.sitl.robotkit && white_rabbit.mav_version == 2)
		{
			white_rabbit.sitl.robotkit = true;
			console.log('mavlink 2 SITL Command: robotkit-sitl ./lib/robotkit/arducopter --home=39.28389,-84.3016354,584,353')

		}

	};


module.exports = init_robotkit;