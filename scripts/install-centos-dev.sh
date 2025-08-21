#!/usr/bin/env bash
set -euo pipefail

# Development installer for CentOS dev VMs.
# This wraps the main install-centos.sh and adds development helpers such as
# x11vnc for viewing the Xvfb display. Nothing in this script is enabled by
# default for production images; run it explicitly on development VMs only.
#
# Usage:
#   sudo ./install-centos-dev.sh <git-repo-url> [branch] [--kiosk] [CONTROLLER_URL]
#
# Optional environment variables:
#   VNC_PASS  - if set, this password will be used for x11vnc (stored at /etc/x11vnc.pass)
#
SCRIPTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPTDIR/install-centos.sh"

# If the installer in this repo copy isn't executable, try common fallback locations
TRIED_INSTALLERS=("$INSTALLER")
if [ ! -x "$INSTALLER" ]; then
  # common fallback when users copy the repo to /tmp for VM provisioning
  FALLBACK1="/tmp/Sec-View_LINUX-01/scripts/install-centos.sh"
  FALLBACK2="/tmp/$(basename "${PWD}")/scripts/install-centos.sh"
  TRIED_INSTALLERS+=("$FALLBACK1" "$FALLBACK2")
  if [ -x "$FALLBACK1" ]; then
    INSTALLER="$FALLBACK1"
  elif [ -x "$FALLBACK2" ]; then
    INSTALLER="$FALLBACK2"
  else
    echo "Warning: none of the installer candidates are executable. Tried:" >&2
    for p in "${TRIED_INSTALLERS[@]}"; do echo "  - $p" >&2; done
    echo "Make sure you run this from the cloned repo's scripts/ directory or place the repo under /tmp as expected for some VM workflows." >&2
  fi
fi

# Run the normal installer first (pass-through args)
if [ -x "$INSTALLER" ]; then
  echo "Running base installer..."
  # allow the base installer to fail non-fatally in dev mode
  if ! sudo "$INSTALLER" "$@"; then
    echo "Base installer returned non-zero, continuing in dev mode." >&2
  fi
else
  echo "Skipping base installer because $INSTALLER is not available." >&2
fi

# Ensure we have a package manager reference
PKG_MGR="yum"
if command -v dnf >/dev/null 2>&1; then
  PKG_MGR="dnf"
fi

echo "Installing development packages (x11vnc, dbus-x11, font utilities)..."
sudo $PKG_MGR install -y epel-release >/dev/null 2>&1 || true
sudo $PKG_MGR install -y x11vnc dbus-x11 fontconfig >/dev/null 2>&1 || true

# Ensure kiosk home exists and permissions are sane
sudo mkdir -p /var/lib/kiosk
sudo chown -R kiosk:kiosk /var/lib/kiosk || true

# Start Xvfb if it's not running (some setups start it from the service/unit).
if ! pgrep -f "Xvfb :99" >/dev/null 2>&1; then
  echo "Starting Xvfb :99 (development helper)..."
  sudo nohup Xvfb :99 -screen 0 1280x720x24 -ac > /var/log/Xvfb-:99.log 2>&1 &
  sleep 1
fi

# Create a safe x11vnc systemd unit for development (explicit opt-in by running this script)
UNIT_PATH="/etc/systemd/system/x11vnc-dev.service"

sudo tee "$UNIT_PATH" > /dev/null <<'EOF'
[Unit]
Description=Dev x11vnc attached to Xvfb :99
After=graphical.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/x11vnc -display :99 -rfbport 5900 -nopw -forever -shared -o /var/log/x11vnc-:99.log
Restart=on-failure

[Install]
WantedBy=graphical.target
EOF

# If a password is provided in VNC_PASS, store it and update the unit to use it
if [ -n "${VNC_PASS:-}" ]; then
  echo "Creating x11vnc password file (/etc/x11vnc.pass)"
  echo "$VNC_PASS" | sudo /usr/bin/x11vnc -storepasswd /etc/x11vnc.pass >/dev/null 2>&1
  sudo chmod 0600 /etc/x11vnc.pass
  sudo sed -i 's/-nopw/-rfbauth \/etc\/x11vnc.pass/' "$UNIT_PATH"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now x11vnc-dev.service || true

cat <<EOF

Dev install finished.
- x11vnc service: x11vnc-dev.service (listening on TCP port 5900)
- Use an SSH tunnel when connecting from your host:
  ssh -p <ssh-port> -L 5900:localhost:5900 root@<vm-ip>

Security:
- This service is intended for development only. Do NOT enable or leave running on production images.
- Prefer tunneling (SSH) rather than opening firewall ports. If you must expose the port locally, set VNC_PASS before running this script.

EOF

# If base installer failed to clone the repo, try cloning here (from /tmp) so dev tools can use it
if [ ! -d /opt/sec-viewer-agent ]; then
  echo "Base installer did not create /opt/sec-viewer-agent; attempting to clone for dev testing..."
  rm -rf /opt/sec-viewer-agent || true
  if ! (cd /tmp && sudo git clone --depth 1 --branch ${2:-main} ${1:-https://github.com/mchvgs79/Sec-View_LINUX-01} /opt/sec-viewer-agent); then
    echo "Dev-time clone also failed; continue using manual steps." >&2
  else
    sudo chown -R root:root /opt/sec-viewer-agent || true
  fi
fi

# Rebuild font caches if fc-cache is available
if command -v fc-cache >/dev/null 2>&1; then
  sudo fc-cache -f -v || true
  sudo -u kiosk fc-cache -f -v || true
fi
