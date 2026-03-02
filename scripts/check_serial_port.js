// Utility to check and log processes using a serial port
// Usage: node check_serial_port.js /dev/tty.usbserial-21340

const { exec } = require('child_process');

const port = process.argv[2];
if (!port) {
    console.error('Usage: node check_serial_port.js <serial_port_path>');
    process.exit(1);
}

exec(`lsof | grep ${port}`, (err, stdout, stderr) => {
    // Ignore exit code 1 (no match found), only treat other errors as real errors
    if (err && err.code !== 1) {
        console.error('Error running lsof:', err);
        process.exit(1);
    }
    if (stdout.trim().length === 0) {
        console.log(`No processes are using ${port}.`);
    } else {
        console.log(`Processes using ${port} (PID first column):\n`);
        console.log(stdout);
        console.log('\nTo kill a process: kill -9 <PID>');
        // Extract PIDs and kill them, then wait before continuing
        const lines = stdout.trim().split('\n');
        const pids = lines.map(line => line.split(/\s+/)[1]).filter(pid => pid && !isNaN(pid));
        if (pids.length > 0) {
            const killCmd = `kill -9 ${pids.join(' ')}`;
            exec(killCmd, (killErr) => {
                if (killErr) {
                    console.error('Error killing process(es):', killErr);
                } else {
                    console.log(`Killed process(es): ${pids.join(', ')}`);
                    // Wait 1 second to allow OS to release the port
                    setTimeout(() => {
                        console.log('Waited 1 second for port release.');
                    }, 1000);
                }
            });
        }
    }
});
