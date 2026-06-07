#!/bin/bash
export LD_LIBRARY_PATH=/home/rover/.local/lib:$LD_LIBRARY_PATH
exec /usr/bin/node server.js
