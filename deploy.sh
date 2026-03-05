#!/bin/bash
set -e

echo "=== FBAuto PM2 Deployment ==="

# Install Bun if not present
if ! command -v bun &> /dev/null; then
  echo "[1/5] Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.bashrc
  echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.bashrc
else
  echo "[1/5] Bun already installed"
fi

# Install PM2 globally if not present
if ! command -v pm2 &> /dev/null; then
  echo "[2/5] Installing PM2..."
  npm install -g pm2
else
  echo "[2/5] PM2 already installed"
fi

# Install dependencies
echo "[3/5] Installing dependencies..."
cd /opt/fbauto
bun install --production

# Stop existing instance if running
echo "[4/5] Starting with PM2..."
pm2 delete fbauto 2>/dev/null || true
pm2 start ecosystem.config.cjs

# Save PM2 process list and set up startup on reboot
echo "[5/5] Setting up auto-start on reboot..."
pm2 save
pm2 startup 2>/dev/null || true

echo ""
echo "=== Deployment Complete ==="
pm2 status
echo ""
echo "Commands:"
echo "  pm2 logs fbauto      - View live logs"
echo "  pm2 restart fbauto   - Restart"
echo "  pm2 stop fbauto      - Stop"
echo "  pm2 status           - Check status"
echo "  pm2 monit            - Monitor dashboard"
