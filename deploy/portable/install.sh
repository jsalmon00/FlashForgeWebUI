#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo ./deploy/portable/install.sh [OPTIONS]

Install or restore the FlashForgeWebUI + PrintGuard + SimplyPrint sync stack.

Options:
  --user <USER>         System user that owns FlashForgeWebUI & PrintGuard
  --printer-ip <IP>     Printer LAN IP to pass to flashforge-stack setup
  --serial <SERIAL>     Printer serial number to pass to setup
  --check-code <CODE>   Printer LAN Access Code / CheckCode to pass to setup
  --yes                 Non-interactive mode (accept discovered/saved defaults)
  --skip-setup          Install files and systemd units without running setup
  -h, --help            Show this help message
EOF
}

STACK_USER=""
PRINTER_IP=""
PRINTER_SERIAL=""
CHECK_CODE=""
YES_FLAG=0
SKIP_SETUP=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --user)
      STACK_USER="${2:?Missing value for --user}"
      shift 2
      ;;
    --printer-ip)
      PRINTER_IP="${2:?Missing value for --printer-ip}"
      shift 2
      ;;
    --serial)
      PRINTER_SERIAL="${2:?Missing value for --serial}"
      shift 2
      ;;
    --check-code)
      CHECK_CODE="${2:?Missing value for --check-code}"
      shift 2
      ;;
    --yes)
      YES_FLAG=1
      shift
      ;;
    --skip-setup)
      SKIP_SETUP=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: install.sh must run as root (use sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ -z "$STACK_USER" ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
    STACK_USER="$SUDO_USER"
  elif id "jo" >/dev/null 2>&1; then
    STACK_USER="jo"
  else
    echo "Error: could not infer target non-root user. Re-run with --user <username>." >&2
    exit 1
  fi
fi

if ! id "$STACK_USER" >/dev/null 2>&1; then
  echo "Error: user '$STACK_USER' does not exist on this system." >&2
  exit 1
fi

STACK_GROUP="$(id -gn "$STACK_USER")"
STACK_HOME="$(getent passwd "$STACK_USER" | cut -d: -f6)"
DATA_DIR="$STACK_HOME/.config/FlashForgeUI"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

echo "[install] Bundle root : $BUNDLE_ROOT"
echo "[install] Target user : $STACK_USER:$STACK_GROUP (home=$STACK_HOME)"
echo "[install] Data dir    : $DATA_DIR"

ARCH="$(uname -m)"
if [ "$ARCH" != "x86_64" ]; then
  echo "[install] WARNING: Host architecture is '$ARCH'; bundled binaries are linux-x86_64." >&2
fi

install -d -m 0755 /opt/flashforge-stack/systemd
install -m 0755 "$SCRIPT_DIR/flashforge-stack" /usr/local/bin/flashforge-stack
install -m 0755 "$SCRIPT_DIR/install.sh" /opt/flashforge-stack/install.sh
if [ -f "$SCRIPT_DIR/README.md" ]; then
  install -m 0644 "$SCRIPT_DIR/README.md" /opt/flashforge-stack/README.md
fi
cp "$SCRIPT_DIR"/systemd/*.in /opt/flashforge-stack/systemd/

WEBUI_BIN_SRC=""
if [ -f "$BUNDLE_ROOT/binaries/flashforge-webui" ]; then
  WEBUI_BIN_SRC="$BUNDLE_ROOT/binaries/flashforge-webui"
elif [ -f "$BUNDLE_ROOT/dist/flashforge-webui-linux-x64" ]; then
  WEBUI_BIN_SRC="$BUNDLE_ROOT/dist/flashforge-webui-linux-x64"
fi

if [ -n "$WEBUI_BIN_SRC" ]; then
  if [ -f /usr/local/bin/flashforge-webui ]; then
    cp -f /usr/local/bin/flashforge-webui "/usr/local/bin/flashforge-webui.bak.$STAMP"
  fi
  install -m 0755 "$WEBUI_BIN_SRC" /usr/local/bin/flashforge-webui
  echo "[install] Installed /usr/local/bin/flashforge-webui"
elif [ ! -x /usr/local/bin/flashforge-webui ]; then
  echo "[install] WARNING: /usr/local/bin/flashforge-webui not found in bundle or system." >&2
fi

if [ -d "$BUNDLE_ROOT/opt/printguard" ]; then
  if [ -d /opt/printguard ]; then
    mv /opt/printguard "/opt/printguard.bak.$STAMP"
  fi
  cp -a "$BUNDLE_ROOT/opt/printguard" /opt/printguard

  PY_BIN_DIR="$(find /opt/printguard/python -maxdepth 3 -type d -name bin 2>/dev/null | head -n 1 || true)"
  if [ -n "$PY_BIN_DIR" ] && [ -f /opt/printguard/.venv/pyvenv.cfg ]; then
    sed -i "s|^home = .*|home = $PY_BIN_DIR|" /opt/printguard/.venv/pyvenv.cfg
    chmod +x "$PY_BIN_DIR"/python* 2>/dev/null || true
  fi
  chmod +x /opt/printguard/.venv/bin/python* 2>/dev/null || true
  [ -f /opt/printguard/bin/mediamtx ] && chmod +x /opt/printguard/bin/mediamtx
  chown -R "$STACK_USER:$STACK_GROUP" /opt/printguard
  echo "[install] Installed /opt/printguard"
fi

install -d -m 0700 -o "$STACK_USER" -g "$STACK_GROUP" "$DATA_DIR"
if [ -d "$BUNDLE_ROOT/configs/FlashForgeUI" ]; then
  for item in config.json printer_details.json; do
    if [ -f "$BUNDLE_ROOT/configs/FlashForgeUI/$item" ]; then
      install -m 0664 -o "$STACK_USER" -g "$STACK_GROUP" \
        "$BUNDLE_ROOT/configs/FlashForgeUI/$item" "$DATA_DIR/$item"
    fi
  done
  if [ -d "$BUNDLE_ROOT/configs/FlashForgeUI/calibration" ]; then
    rm -rf "$DATA_DIR/calibration"
    cp -a "$BUNDLE_ROOT/configs/FlashForgeUI/calibration" "$DATA_DIR/calibration"
    chown -R "$STACK_USER:$STACK_GROUP" "$DATA_DIR/calibration"
  fi
  echo "[install] Restored FlashForgeWebUI config files"
fi

if [ -d /opt/printguard ] || [ -f "$BUNDLE_ROOT/configs/printguard/state.json" ]; then
  install -d -m 0755 -o "$STACK_USER" -g "$STACK_GROUP" /var/lib/printguard
  if [ -f "$BUNDLE_ROOT/configs/printguard/state.json" ]; then
    install -m 0600 -o "$STACK_USER" -g "$STACK_GROUP" \
      "$BUNDLE_ROOT/configs/printguard/state.json" /var/lib/printguard/state.json
    echo "[install] Restored PrintGuard state.json"
  fi
fi

if [ -d "$BUNDLE_ROOT/configs/simplyprint" ]; then
  install -d -m 0755 /root/.local/share/SimplyPrint
  install -d -m 0755 /root/.config/SimplyPrint
  if [ -f "$BUNDLE_ROOT/configs/simplyprint/state.db" ]; then
    install -m 0644 "$BUNDLE_ROOT/configs/simplyprint/state.db" /root/.local/share/SimplyPrint/state.db
  fi
  if [ -f "$BUNDLE_ROOT/configs/simplyprint/instance" ]; then
    install -m 0600 "$BUNDLE_ROOT/configs/simplyprint/instance" /root/.local/share/SimplyPrint/instance
  fi
  if [ -f "$BUNDLE_ROOT/configs/simplyprint/runtime.json" ]; then
    install -m 0600 "$BUNDLE_ROOT/configs/simplyprint/runtime.json" /root/.config/SimplyPrint/runtime.json
  fi
  echo "[install] Restored SimplyPrint pairing state"
fi

render_unit() {
  local src="$1"
  local dst="$2"
  sed \
    -e "s|__STACK_USER__|$STACK_USER|g" \
    -e "s|__STACK_GROUP__|$STACK_GROUP|g" \
    -e "s|__STACK_HOME__|$STACK_HOME|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    "$src" > "$dst"
  chmod 0644 "$dst"
}

render_unit "$SCRIPT_DIR/systemd/flashforgeui.service.in" /etc/systemd/system/flashforgeui.service
render_unit "$SCRIPT_DIR/systemd/ff-printer-sync.service.in" /etc/systemd/system/ff-printer-sync.service
render_unit "$SCRIPT_DIR/systemd/ff-printer-sync.path.in" /etc/systemd/system/ff-printer-sync.path

HAS_PRINTGUARD=0
if [ -d /opt/printguard ]; then
  HAS_PRINTGUARD=1
  render_unit "$SCRIPT_DIR/systemd/printguard.service.in" /etc/systemd/system/printguard.service
fi

systemctl daemon-reload
systemctl enable ff-printer-sync.path ff-printer-sync.service flashforgeui.service
systemctl start ff-printer-sync.path
systemctl restart flashforgeui.service

if [ "$HAS_PRINTGUARD" -eq 1 ]; then
  systemctl enable printguard.service
  systemctl restart printguard.service
fi

if [ ! -d /opt/simplyprint ]; then
  echo ""
  echo "[install] Note: SimplyPrint Client is not installed on this machine."
  echo "[install] To install it later (your paired state was restored if present), run:"
  echo "  curl -sSL https://download.simplyprint.io/client/install-linux.sh | sudo bash"
fi

if [ "$SKIP_SETUP" -eq 0 ]; then
  SETUP_ARGS=()
  [ -n "$PRINTER_IP" ] && SETUP_ARGS+=(--printer-ip "$PRINTER_IP")
  [ -n "$PRINTER_SERIAL" ] && SETUP_ARGS+=(--serial "$PRINTER_SERIAL")
  [ -n "$CHECK_CODE" ] && SETUP_ARGS+=(--check-code "$CHECK_CODE")
  [ "$YES_FLAG" -eq 1 ] && SETUP_ARGS+=(--yes)

  echo ""
  STACK_USER="$STACK_USER" DATA_DIR="$DATA_DIR" /usr/local/bin/flashforge-stack setup "${SETUP_ARGS[@]}"
else
  echo "[install] Skipped setup (--skip-setup). Run 'sudo flashforge-stack setup' when ready."
fi
