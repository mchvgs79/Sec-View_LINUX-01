#!/usr/bin/env bash
set -euo pipefail

# Robust CentOS installer for Sec-Viewer agent
# Usage: sudo ./install-centos.sh <git-repo-url> [branch]
REPO_URL="${1:-}"
BRANCH="${2:-main}"
#!/usr/bin/env bash
set -euo pipefail

# Safer CentOS installer for Sec-Viewer agent
# - Prefers distro nodejs where available
# - Avoids enabling N|Solid repo
# - Makes kiosk/gui packages optional (--kiosk)
# - Uses tolerant per-package installs
# Usage: sudo ./install-centos.sh <git-repo-url> [branch] [--kiosk]

REPO_URL="${1:-}"
BRANCH="${2:-main}"
OPT_KIOSK=0
if [ "${3:-}" = "--kiosk" ]; then
  OPT_KIOSK=1
fi
DEST="/opt/sec-viewer-agent"

if [ -z "$REPO_URL" ]; then
  echo "Usage: $0 <git-repo-url> [branch] [--kiosk]"
  exit 2
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO=sudo
  else
    echo "This script requires root privileges (run as root or install sudo)." >&2
    exit 1
  fi
fi

PKG_MGR="yum"
HAS_DNF=0
if command -v dnf >/dev/null 2>&1; then
  PKG_MGR="dnf"
  HAS_DNF=1
fi

echo "Using package manager: $PKG_MGR"

# Enable EPEL if available
echo "Ensuring EPEL repository (if available)..."
$SUDO $PKG_MGR install -y epel-release >/dev/null 2>&1 || true

if [ "$HAS_DNF" -eq 1 ]; then
  # Enable CRB if present (some packages need it)
  echo "Attempting to enable CodeReady Builder (CRB)..."
  $SUDO $PKG_MGR install -y dnf-plugins-core >/dev/null 2>&1 || true
  $SUDO $PKG_MGR config-manager --set-enabled crb >/dev/null 2>&1 || true
fi

# Basic packages (always)
BASE_PKGS=(git curl)

# Node packages: prefer distro nodejs. We'll try distro install first.
NODE_WANTED=1

# Kiosk packages (optional)
KIOSK_PKGS=(chromium xorg-x11-server-Xorg xorg-x11-xinit openbox xdotool liberation-fonts xorg-x11-utils xdg-utils xorg-x11-server-Xvfb)

echo "Installing base packages..."
for pkg in "${BASE_PKGS[@]}"; do
  echo "Installing: $pkg"
  if ! $SUDO $PKG_MGR install -y "$pkg"; then
    echo "warning: package $pkg failed to install, continuing" >&2
  fi
done

if [ "$OPT_KIOSK" -eq 1 ]; then
  echo "Installing kiosk packages (optional)..."
  for pkg in "${KIOSK_PKGS[@]}"; do
    echo "Installing: $pkg"
    if ! $SUDO $PKG_MGR install -y "$pkg"; then
      echo "warning: kiosk package $pkg failed to install, continuing" >&2
    fi
  done
  # create a non-login kiosk user to run the browser
  if ! id -u kiosk >/dev/null 2>&1; then
    echo "Creating kiosk user..."
    $SUDO useradd --system --no-create-home --shell /sbin/nologin kiosk || true
  fi
fi

echo "Attempting to install distro nodejs (preferred)..."
if [ "$HAS_DNF" -eq 1 ]; then
  # Try to use distro module if available (CentOS/RHEL AppStream)
  if $SUDO $PKG_MGR module list nodejs >/dev/null 2>&1; then
    # Try installing the default module stream
    $SUDO $PKG_MGR module install -y nodejs || true
  fi
  # Fallback: try simple install
  $SUDO $PKG_MGR install -y nodejs >/dev/null 2>&1 || true
else
  $SUDO $PKG_MGR install -y nodejs >/dev/null 2>&1 || true
fi

if command -v node >/dev/null 2>&1; then
  echo "Node present: $(node -v)"
else
  echo "Distro nodejs not available or insufficient; attempting NodeSource (safe mode)..."
  # Use NodeSource setup but ensure we don't enable N|Solid repo
  curl -fsSL https://rpm.nodesource.com/setup_18.x | $SUDO bash - || true
  # Disable N|Solid repo if it was added
  if [ "$HAS_DNF" -eq 1 ]; then
    $SUDO $PKG_MGR config-manager --set-disabled nodesource-nsolid >/dev/null 2>&1 || true
  fi
  # Install nodejs from nodesource repo
  if ! $SUDO $PKG_MGR install -y nodejs; then
    echo "warning: nodejs install failed; continuing without node. You may need to install node manually." >&2
  fi
fi

echo "Node.js version: $(node -v 2>/dev/null || echo '(not installed)')"
echo "npm version: $(npm -v 2>/dev/null || echo '(not installed)')"

echo "Cloning repository to $DEST"
$SUDO rm -rf "$DEST"
if ! $SUDO git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$DEST"; then
  echo "git clone failed; aborting." >&2
  exit 1
fi
$SUDO chown -R "${SUDO_USER:-root}" "$DEST" 2>/dev/null || true

echo "Installing node dependencies (production)..."
if [ -f "$DEST/package-lock.json" ]; then
  if ! $SUDO npm ci --prefix "$DEST" --production; then
    echo "npm ci failed, trying npm install" >&2
    $SUDO npm install --prefix "$DEST" --production || true
  fi
else
  $SUDO npm install --prefix "$DEST" --production || true
fi

echo "Writing systemd unit for sec-viewer-agent"
$SUDO tee /etc/systemd/system/sec-viewer-agent.service > /dev/null <<EOF
[Unit]
Description=Sec Viewer Linux Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${DEST}
ExecStart=/usr/bin/npm start --prefix ${DEST}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now sec-viewer-agent.service || true

if [ "$OPT_KIOSK" -eq 1 ]; then
  echo "Installing kiosk systemd units..."

  # chromium kiosk using Xvfb :99 and running as 'kiosk'
  $SUDO tee /etc/systemd/system/chromium-kiosk.service > /dev/null <<'EOF'
[Unit]
Description=Chromium Kiosk Renderer (Xvfb)
After=network.target

[Service]
Type=simple
User=kiosk
Environment=DISPLAY=:99
ExecStart=/bin/sh -c 'Xvfb :99 -screen 0 1920x1080x24 & sleep 1; DISPLAY=:99 /usr/bin/chromium --no-first-run --kiosk --incognito http://localhost:8080'
Restart=always
RestartSec=5

[Install]
WantedBy=graphical.target
EOF

  # layout-agent service (runs the agent from the installed DEST)
  $SUDO tee /etc/systemd/system/layout-agent.service > /dev/null <<EOF
[Unit]
Description=Layout Client Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${DEST}
ExecStart=/usr/bin/node ${DEST}/src/agent.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now chromium-kiosk.service || true
  $SUDO systemctl enable --now layout-agent.service || true
fi

echo "Install complete. To re-run install steps manually, inspect the script and logs."