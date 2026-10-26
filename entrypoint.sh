#!/bin/bash

# Initialize PulseAudio
pulseaudio --start --exit-idle-time=-1 --system=false

# Configure the virtual sound card and default microphone loopback
pactl load-module module-null-sink sink_name=VirtualSpeaker sink_properties=device.description="VirtualSpeaker"
pactl load-module module-virtual-source source_name=VirtualMic master=VirtualSpeaker.monitor source_properties=device.description="VirtualMic"
pactl set-default-source VirtualMic

# Start the web server
exec node server.js
