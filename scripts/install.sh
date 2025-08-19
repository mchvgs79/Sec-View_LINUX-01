#!/usr/bin/env bash
set -euo pipefail

# usage: install.sh <git-repo-url> [branch]
REPO_URL="${1:-}"
BRANCH="${2:-main}"
DEST="/opt/sec-viewer-agent"
APT_PKGS="chromium xserver-xorg xinit openbox unclutter xdotool fonts-liberation \
x11-utils xdg-utils git curl nodejs npm xvfb"

if [ -z "$REPO_URL" ]; then
  echo "Usage: $0 <git-repo-url> [branch]"
  exit 2
fi

echo "Installing system packages..."
sudo apt update
sudo apt install -y $APT_PKGS

echo "Cloning repo to $DEST..."
sudo rm -rf "$DEST"
sudo git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$DEST"
sudo chown -R "$USER":"$USER" "$DEST"

echo "Installing node dependencies (production)..."
if [ -f "$DEST/package-lock.json" ]; then
  npm ci --prefix "$DEST" --production
else
  npm install --prefix "$DEST" --production
fi

# simple systemd unit that runs 'npm start' in the repo
sudo tee /etc/systemd/system/sec-viewer-agent.service > /dev/null <<'EOF'
[Unit]
Description=Sec Viewer Linux Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/sec-viewer-agent
ExecStart=/usr/bin/npm start --prefix /opt/sec-viewer-agent
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now sec-viewer-agent.service || true

echo "Install complete."
EOF