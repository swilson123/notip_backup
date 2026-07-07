#!/bin/bash
# Toggles the live HDMI vision preview (highlighted sidewalk mask + x_angle_deg
# arrow) on the currently running realsense_vision.py process. Works whether that
# process was started by a live mission or launched standalone for bench testing --
# it just flips display_enabled in that process via SIGUSR1, since the RealSense
# camera can only be held open by one process at a time.

PID=$(pgrep -f "realsense_vision.py" | head -n 1)

if [ -z "$PID" ]; then
    echo "realsense_vision.py is not running -- start a mission (or run it standalone) first."
    exit 1
fi

kill -USR1 "$PID"
echo "Toggled vision display on PID $PID."
