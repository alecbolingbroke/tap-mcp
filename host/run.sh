#!/bin/sh
# Starts hosted Tap with its settings. launchd (or any supervisor) runs this as the service user; the env file holds
# TAP_BASE_URL, TAP_SECRET, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and is readable by that user only (chmod 600).
set -a
. "$HOME/.tap/hosted.env"
set +a
exec tap-mcp-http
