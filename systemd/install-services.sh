#!/bin/bash

# Install systemd services for btc-trader
# Run as root: sudo ./install-services.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="/etc/systemd/system"

echo "Installing btc-trader services..."

# Copy service files
cp "$SCRIPT_DIR/bot@.service" "$SYSTEMD_DIR/"
cp "$SCRIPT_DIR/dashboard.service" "$SYSTEMD_DIR/"
cp "$SCRIPT_DIR/ui.service" "$SYSTEMD_DIR/"

# Reload systemd
systemctl daemon-reload

echo "Services installed. Enable and start with:"
echo ""
echo "  # Dashboard"
echo "  sudo systemctl enable dashboard"
echo "  sudo systemctl start dashboard"
echo ""
echo "  # UI"
echo "  sudo systemctl enable ui"
echo "  sudo systemctl start ui"
echo ""
echo "  # Bots (use bot ID from bots.json)"
echo "  sudo systemctl enable bot@btc-daily"
echo "  sudo systemctl start bot@btc-daily"
echo ""
echo "  sudo systemctl enable bot@4h-mfi"
echo "  sudo systemctl start bot@4h-mfi"
echo ""
echo "  # Check status"
echo "  sudo systemctl status dashboard"
echo "  sudo systemctl status 'bot@*'"
