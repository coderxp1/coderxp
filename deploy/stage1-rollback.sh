#!/usr/bin/env bash
# ==============================================================================
# CoderXP Dedicated Server - Stage 1 Rollback Script
# Reverses all Stage 1 system changes and restores backed-up files.
# Run as ROOT from the server console.
# ==============================================================================

set -euo pipefail
IFS=$'\n\t'

echo "=================================================================="
echo "  CODERXP STAGE 1 REVERSAL / ROLLBACK"
echo "  Started at: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "=================================================================="

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[FATAL] Must be run as root." >&2
  exit 1
fi

LATEST_BACKUP="$(ls -td /var/backups/coderxp-preflight/*/ 2>/dev/null | head -n 1 || true)"

# 1. Stop and Disable Services
echo "[1/9] Stopping CoderXP services and persistence hooks..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop coderxp-app.service coderxp-broker.service coderxp-preview.service coderxp-docker-control.service coderxp-firewall-docker.service 2>/dev/null || true
  systemctl disable coderxp-app.service coderxp-broker.service coderxp-preview.service coderxp-docker-control.service coderxp-firewall-docker.service 2>/dev/null || true
fi

rm -f /etc/systemd/system/coderxp-*.service
rm -f /etc/systemd/system/docker.service.d/coderxp-firewall.conf
rm -f /etc/systemd/system/ufw.service.d/coderxp-firewall.conf
rm -f /etc/ufw/after.init
rm -rf /run/coderxp

# 2. Remove CODERXP-ISOLATION Iptables Rules
echo "[2/9] Removing CODERXP-ISOLATION firewall chains..."
iptables -D DOCKER-USER -j CODERXP-ISOLATION 2>/dev/null || true
iptables -D INPUT -j CODERXP-INPUT-ISOLATION 2>/dev/null || true
iptables -F CODERXP-ISOLATION 2>/dev/null || true
iptables -X CODERXP-ISOLATION 2>/dev/null || true
iptables -F CODERXP-INPUT-ISOLATION 2>/dev/null || true
iptables -X CODERXP-INPUT-ISOLATION 2>/dev/null || true

ip6tables -D DOCKER-USER -j CODERXP-ISOLATION 2>/dev/null || true
ip6tables -F CODERXP-ISOLATION 2>/dev/null || true
ip6tables -X CODERXP-ISOLATION 2>/dev/null || true

# 3. Remove Sudoers & Control Wrapper
echo "[3/9] Removing deployment sudoers and control wrappers..."
rm -f /etc/sudoers.d/coderxp-deploy
rm -f /usr/local/bin/coderxp-control
rm -f /usr/local/bin/coderxp-firewall-docker-rules

# 4. Remove Docker Network
if docker network inspect coderxp-net &>/dev/null; then
  echo "[4/9] Removing isolated Docker network coderxp-net..."
  docker network rm coderxp-net || true
fi

# 5. Clean up Staging Directory
echo "[5/9] Cleaning up staging directory..."
rm -rf /opt/coderxp/staging/*

# 6. Restore Backed-Up Configuration Files
if [[ -n "$LATEST_BACKUP" && -d "$LATEST_BACKUP" ]]; then
  echo "[6/9] Restoring backed-up configurations from $LATEST_BACKUP..."
  [[ -f "$LATEST_BACKUP/daemon.json" ]] && cp -a "$LATEST_BACKUP/daemon.json" /etc/docker/daemon.json
  [[ -f "$LATEST_BACKUP/subuid" ]] && cp -a "$LATEST_BACKUP/subuid" /etc/subuid
  [[ -f "$LATEST_BACKUP/subgid" ]] && cp -a "$LATEST_BACKUP/subgid" /etc/subgid
  [[ -f "$LATEST_BACKUP/00-security.conf" ]] && cp -a "$LATEST_BACKUP/00-security.conf" /etc/nginx/conf.d/00-security.conf
fi

# 7. Reset Nginx Sites
echo "[7/9] Resetting Nginx sites..."
rm -f /etc/nginx/sites-enabled/coderxp*.conf
rm -f /etc/nginx/sites-available/coderxp*.conf

# 8. Reload Daemons
echo "[8/9] Reloading systemd, docker, and nginx..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl restart docker 2>/dev/null || true
  systemctl reload nginx 2>/dev/null || true
fi

# 9. Reset UFW to Baseline
echo "[9/9] Resetting UFW to baseline..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw --force enable

echo "=================================================================="
echo "  ROLLBACK COMPLETE: SYSTEM RESTORED TO PRE-STAGE-1 BASELINE"
echo "=================================================================="
