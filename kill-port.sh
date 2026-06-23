#!/bin/bash
# Usage: ./kill-port.sh <port>
PORT=$1
if [ -z "$PORT" ]; then
  echo "Usage: $0 <port>"
  exit 1
fi
PIDS=$(lsof -ti:$PORT)
if [ -z "$PIDS" ]; then
  echo "No process found on port $PORT"
else
  echo "Killing process(es) on port $PORT: $PIDS"
  kill -9 $PIDS
fi 