# Moving House & Portability Guide (`flashforge-stack`)

This server setup is self-healing across router changes, DHCP IP shifts, boot-order races, and full hardware migrations.

---

## Scenario 1: Same Server (`jo-wyse`) + Same Printer on a New Router (Plug & Play)

When you plug in the server and printer on your new router/Wi-Fi:

1. **Reconnect the Adventurer 5M Pro to the new Wi-Fi** (or Ethernet).
   - Ensure **LAN Only** mode stays enabled (`Settings -> Network -> LAN Only` on the printer screen).
2. **`FlashForgeWebUI` heals itself automatically**:
   - Even if the Wyse server boots before the printer joins Wi-Fi, or the printer gets a new DHCP IP on a different subnet (e.g. `192.168.0.x` or `10.0.0.x`), `HeadlessAutoRecoveryService` polls every 30s on disconnect using UDP multicast/broadcast discovery **plus** a `/24` HTTP `/detail` fallback probe if the new router blocks multicast.
   - As soon as it finds serial `SNMOME9902235`, it updates `~/.config/FlashForgeUI/printer_details.json` and reconnects.
3. **Camera Sharing & SimplyPrint follow automatically**:
   - `ff-printer-sync.path` watches `printer_details.json` and immediately runs `sudo flashforge-stack sync`, which:
     - Updates the `iptables` NAT `OUTPUT` camera `REDIRECT` (`8080 -> 3000`) to the printer's new IP without hardcoding the server's own LAN IP.
     - Updates SimplyPrint's `/root/.local/share/SimplyPrint/state.db` and restarts `simplyprint-client.service` only if the IP or CheckCode changed.
4. **PrintGuard needs zero IP reconfiguration**:
   - PrintGuard (`:8001`) connects to `FlashForgeWebUI` over loopback (`http://127.0.0.1:3000`).
5. **Find your server's new LAN IP & check health**:
   ```bash
   flashforge-stack status
   ```
   - Update the server IP in the **FlashForgeUI Android app** if the server's LAN IP changed on the new router (or use its Tailscale IP `100.92.15.107` if Tailscale is signed in).

---

## Scenario 2: Printer CheckCode Changed or Discovery Issues

If you factory-reset network settings, got a new LAN Access Code / CheckCode on the printer screen, or want to point the stack at a printer IP manually:

```bash
sudo flashforge-stack setup
```

Useful diagnostic commands:

```bash
# Scan the LAN (UDP + TCP/HTTP /24 fallback if multicast is blocked)
flashforge-stack discover

# Print full status across systemd units, WebUI, PrintGuard, SimplyPrint, and iptables
sudo flashforge-stack status
```

---

## Scenario 3: Moving to a Brand-New Linux `x86_64` Server

On the old server (`jo-wyse`), package all binaries, PrintGuard `.venv`/models, unit templates, and paired configs:

```bash
sudo flashforge-stack export-portable
```

Or export only configs and scripts (smaller archive):

```bash
sudo flashforge-stack export-portable --config-only
```

Copy the generated `.tar.gz` to the new Debian/Ubuntu/Mint `x86_64` host and run:

```bash
tar -xzf flashforge-portable-*.tar.gz
cd flashforge-portable
sudo ./deploy/portable/install.sh
```

If using SimplyPrint on a brand-new machine, also install the upstream SimplyPrint binary:

```bash
curl -sSL https://download.simplyprint.io/client/install-linux.sh | sudo bash
sudo systemctl restart simplyprint-client.service
```
