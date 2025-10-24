#!/bin/bash

check_active_playback() {
    # Check if there's an active ffmpeg process (indicating active playback)
    if pgrep -f "ffmpeg.*webm" > /dev/null; then
        exit 1  # Active playback, don't update
    fi
    # Check if there's an active yt-dlp process
    if pgrep -f "yt-dlp" > /dev/null; then
        exit 1  # Active download, don't update
    fi
}

# Check for active playback before proceeding
check_active_playback

# If we get here, no active playback or downloads
echo "No active playback, checking for yt-dlp updates..."
yt-dlp -U 2>/dev/null || {
    echo "Downloading latest yt-dlp..."
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
    chmod a+rx /usr/local/bin/yt-dlp
}