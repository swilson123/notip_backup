// This script connects to an Intel RealSense D435i camera and logs depth frames as JSON.
// Requires 'node-librealsense' (Linux only) or 'python-shell' to call a Python script on macOS.
// This version uses Python via child_process for macOS compatibility.

const { spawn } = require('child_process');

const pythonScript = `${__dirname}/realsense_depth_stream.py`;

const py = spawn('python3', [pythonScript]);

py.stdout.on('data', (data) => {
    try {
        const json = JSON.parse(data.toString());
        console.log('RealSense Depth Data:', json);
    } catch (e) {
        // Ignore non-JSON output
    }
});

py.stderr.on('data', (data) => {
    console.error('Python error:', data.toString());
});

py.on('close', (code) => {
    console.log(`Python script exited with code ${code}`);
});
