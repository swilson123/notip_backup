# This script connects to Intel RealSense D435i and prints depth data as JSON
# Requires pyrealsense2: pip install pyrealsense2
import pyrealsense2 as rs
import json
import sys

pipeline = rs.pipeline()
config = rs.config()
config.enable_stream(rs.stream.depth, 640, 480, rs.format.z16, 30)

try:
    pipeline.start(config)
    while True:
        frames = pipeline.wait_for_frames()
        depth = frames.get_depth_frame()
        if not depth:
            continue
        # Get distance at center pixel
        width = depth.get_width()
        height = depth.get_height()
        center_distance = depth.get_distance(int(width/2), int(height/2))
        data = {
            'timestamp': frames.get_timestamp(),
            'center_distance_m': center_distance
        }
        print(json.dumps(data))
        sys.stdout.flush()
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.stdout.flush()
finally:
    pipeline.stop()
