#!/bin/bash
# Startup script for NHL Legacy League on Linux VPS

set -e

echo "[startup] NHL Legacy League"
echo "================================"

# Check .env exists
if [ ! -f .env ]; then
    echo "[ERROR] .env not found. Copy .env.example to .env and configure it."
    exit 1
fi

# Load env vars
source .env

# Create venv if needed
if [ ! -d venv ]; then
    echo "[setup] Creating Python virtualenv..."
    python3 -m venv venv
fi

# Activate venv
source venv/bin/activate

# Install dependencies
echo "[setup] Installing dependencies..."
pip install -r requirements.txt -q

# Initialize database
echo "[setup] Initializing database..."
python3 -c "from server.db import init_db; init_db()"

# Start Flask server in background
echo "[start] Starting Flask server on port 3001..."
python3 -m server.server &
FLASK_PID=$!

# Start Discord bot in background
echo "[start] Starting Discord bot..."
python3 -m bot.bot &
BOT_PID=$!

echo "[start] Both services started (PIDs: Flask=$FLASK_PID, Bot=$BOT_PID)"
echo "[info] Flask: http://localhost:3001"
echo "[info] Discord bot: connected"
echo ""
echo "To stop: kill $FLASK_PID $BOT_PID"
echo "Or Ctrl+C to stop both"

# Wait for both processes
wait $FLASK_PID $BOT_PID
