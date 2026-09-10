#!/usr/bin/env bash
# ==============================================================================
# CoderXP Dedicated Server - Stage 1: Root System Bootstrap (Ubuntu 24.04 LTS)
# Target Server: 87.106.134.211
# Role: Dedicated CoderXP Production Host
# Author: CoderXP Engineering / Paul's Team
# Execution: Run as ROOT from the server console.
# Idempotent: Can be executed multiple times safely without side effects.
# ==============================================================================

set -euo pipefail
IFS=$'\n\t'

LOGFILE="/var/log/coderxp-bootstrap.log"
BACKUP_DIR="/var/backups/coderxp-preflight/$(date -u +%Y%m%d_%H%M%S)"

log() {
  local msg="[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*"
  echo "$msg"
  echo "$msg" >> "$LOGFILE"
}

fatal() {
  log "[FATAL] $*" >&2
  exit 1
}

backup_file() {
  local src="$1"
  if [[ -f "$src" ]]; then
    mkdir -p "$BACKUP_DIR"
    cp -a "$src" "$BACKUP_DIR/"
    log "[BACKUP] Preserved $src in $BACKUP_DIR/"
  fi
}

mkdir -p "$(dirname "$LOGFILE")"

log "=================================================================="
log "  CODERXP DEDICATED HOST STAGE 1 BOOTSTRAP (87.106.134.211)"
log "=================================================================="

# ------------------------------------------------------------------------------
# 1. Root Execution & Environment Assertions
# ------------------------------------------------------------------------------
if [[ "$(id -u)" -ne 0 ]]; then
  fatal "Stage 1 bootstrap must be run as root."
fi

# ------------------------------------------------------------------------------
# 2. Strict CineDrama Absence Pre-Condition Assertion
# ------------------------------------------------------------------------------
log "[1/13] Verifying zero CineDrama pre-condition..."
if id "cinedrama" &>/dev/null; then
  fatal "Found 'cinedrama' user on host. Halting immediately."
fi
if getent group "cinedrama" &>/dev/null; then
  fatal "Found 'cinedrama' group on host. Halting immediately."
fi
if find /home /opt /srv /var/www -maxdepth 4 \( -iname '*cinedrama*' -o -iname '*cine-drama*' \) 2>/dev/null | grep -q .; then
  fatal "Found CineDrama directory or file reference on host. Halting immediately."
fi
log "[PASS] Zero CineDrama assertion verified."

# ------------------------------------------------------------------------------
# 3. Base OS Updates & Safe Reboot-Required Gate
# ------------------------------------------------------------------------------
log "[2/13] Updating base OS packages and checking reboot status..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get dist-upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"

if [[ -f /var/run/reboot-required ]]; then
  log "=================================================================="
  log "[STOP] Kernel or base library upgrade requires a system reboot."
  log "[STOP] Path: /var/run/reboot-required detected."
  log "[ACTION REQUIRED] Please reboot the host from the console now:"
  log "       reboot"
  log "[ACTION REQUIRED] After reboot, re-run this script to continue cleanly."
  log "=================================================================="
  exit 100
fi
log "[PASS] Base OS packages up to date, no reboot pending."

# ------------------------------------------------------------------------------
# 4. UTC Timezone & NTP Time Synchronization
# ------------------------------------------------------------------------------
log "[3/13] Configuring UTC timezone and systemd-timesyncd..."
timedatectl set-timezone UTC
systemctl enable --now systemd-timesyncd

# ------------------------------------------------------------------------------
# 5. Baseline UFW Firewall Configuration (Executed EARLY before Docker rules)
# ------------------------------------------------------------------------------
log "[4/13] Establishing baseline UFW firewall before container network setup..."
apt-get install -y --no-install-recommends ufw
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable
log "[PASS] Baseline UFW active and allowing ports 22, 80, 443."

# ------------------------------------------------------------------------------
# 6. Core Platform Packages
# ------------------------------------------------------------------------------
log "[5/13] Installing core platform packages..."
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  git \
  jq \
  fail2ban \
  socat \
  logrotate \
  apparmor \
  apparmor-utils \
  iproute2 \
  iptables

# ------------------------------------------------------------------------------
# 7. Docker Engine with User Namespace Remapping & Verified GPG Fingerprint
# ------------------------------------------------------------------------------
log "[6/13] Installing Docker Engine with User Namespace Remapping..."
install -m 0755 -d /etc/apt/keyrings
DOCKER_KEY="/etc/apt/keyrings/docker.asc"
EXPECTED_DOCKER_FPT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

if [[ ! -f "$DOCKER_KEY" ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$DOCKER_KEY"
  chmod a+r "$DOCKER_KEY"
fi

ACTUAL_DOCKER_FPT=$(gpg --dry-run --quiet --import --import-options import-show "$DOCKER_KEY" 2>/dev/null | grep -E '^[[:space:]]+[0-9A-F]{40}$' | tr -d ' ' || true)
if [[ "$ACTUAL_DOCKER_FPT" != "$EXPECTED_DOCKER_FPT" ]]; then
  rm -f "$DOCKER_KEY"
  fatal "Docker GPG fingerprint verification failed! Expected $EXPECTED_DOCKER_FPT, got '$ACTUAL_DOCKER_FPT'"
fi
log "[PASS] Docker GPG fingerprint verified: $ACTUAL_DOCKER_FPT"

UBUNTU_CODENAME="$(grep VERSION_CODENAME /etc/os-release | cut -d= -f2)"
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=${DOCKER_KEY}] https://download.docker.com/linux/ubuntu \
  ${UBUNTU_CODENAME} stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -y
apt-get install -y --no-install-recommends \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

# Configure subordinate UID/GID for dockremap
backup_file "/etc/subuid"
backup_file "/etc/subgid"

if ! grep -q "^dockremap:" /etc/subuid 2>/dev/null; then
  echo "dockremap:100000:65536" >> /etc/subuid
fi
if ! grep -q "^dockremap:" /etc/subgid 2>/dev/null; then
  echo "dockremap:100000:65536" >> /etc/subgid
fi

backup_file "/etc/docker/daemon.json"
mkdir -p /etc/docker
cat << 'EOF' > /etc/docker/daemon.json
{
  "userns-remap": "default",
  "icc": false,
  "live-restore": true,
  "userland-proxy": false,
  "no-new-privileges": true,
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "3"
  }
}
EOF

# Restart Docker daemon and verify live userns-remap
systemctl daemon-reload
systemctl restart docker.service
systemctl enable docker.service

log "Verifying live userns-remap in Docker daemon..."
LIVE_SEC_OPTS=$(docker info --format '{{json .SecurityOptions}}')
if [[ "$LIVE_SEC_OPTS" != *"name=userns"* ]]; then
  fatal "Docker userns-remap failed to activate! Live security options: $LIVE_SEC_OPTS"
fi
log "[PASS] Docker live userns-remap verified active: $LIVE_SEC_OPTS"

# ------------------------------------------------------------------------------
# 8. Rigorous Network Property Validation for coderxp-net
# ------------------------------------------------------------------------------
log "[7/13] Validating isolated Docker bridge network 'coderxp-net'..."
RECREATE_NET=false

if docker network inspect coderxp-net &>/dev/null; then
  NET_DRIVER=$(docker network inspect coderxp-net -f '{{.Driver}}' 2>/dev/null || true)
  NET_SUBNET=$(docker network inspect coderxp-net -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)
  NET_GATEWAY=$(docker network inspect coderxp-net -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)
  NET_ICC=$(docker network inspect coderxp-net -f '{{index .Options "com.docker.network.bridge.enable_icc"}}' 2>/dev/null || true)

  if [[ "$NET_DRIVER" != "bridge" || "$NET_SUBNET" != "172.28.0.0/16" || "$NET_GATEWAY" != "172.28.0.1" || "$NET_ICC" != "false" ]]; then
    log "[WARN] Existing coderxp-net has mismatched properties (Driver=$NET_DRIVER, Subnet=$NET_SUBNET, GW=$NET_GATEWAY, ICC=$NET_ICC). Recreating..."
    docker network rm coderxp-net
    RECREATE_NET=true
  else
    log "[PASS] Existing coderxp-net verified: Driver=bridge, Subnet=172.28.0.0/16, GW=172.28.0.1, ICC=false."
  fi
else
  RECREATE_NET=true
fi

if [[ "$RECREATE_NET" == "true" ]]; then
  log "Creating isolated bridge network 'coderxp-net'..."
  docker network create \
    --driver bridge \
    --subnet 172.28.0.0/16 \
    --gateway 172.28.0.1 \
    --opt "com.docker.network.bridge.enable_icc=false" \
    coderxp-net
fi

# Assert all 4 properties post-creation
FINAL_DRIVER=$(docker network inspect coderxp-net -f '{{.Driver}}')
FINAL_SUBNET=$(docker network inspect coderxp-net -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
FINAL_GATEWAY=$(docker network inspect coderxp-net -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
FINAL_ICC=$(docker network inspect coderxp-net -f '{{index .Options "com.docker.network.bridge.enable_icc"}}')

[[ "$FINAL_DRIVER" == "bridge" ]] || fatal "coderxp-net Driver is not bridge: $FINAL_DRIVER"
[[ "$FINAL_SUBNET" == "172.28.0.0/16" ]] || fatal "coderxp-net Subnet is not 172.28.0.0/16: $FINAL_SUBNET"
[[ "$FINAL_GATEWAY" == "172.28.0.1" ]] || fatal "coderxp-net Gateway is not 172.28.0.1: $FINAL_GATEWAY"
[[ "$FINAL_ICC" == "false" ]] || fatal "coderxp-net enable_icc is not false: $FINAL_ICC"
log "[PASS] Strict coderxp-net properties verified."

# ------------------------------------------------------------------------------
# 9. Persistent Container Isolation Rules & Native UFW / Docker Hooks
# ------------------------------------------------------------------------------
log "[8/13] Installing persistent container isolation firewall rules and persistence hooks..."
cat << 'EOF' > /usr/local/bin/coderxp-firewall-docker-rules
#!/usr/bin/env bash
set -euo pipefail

# --- IPv4 Isolation Rules ---
iptables -N CODERXP-ISOLATION 2>/dev/null || iptables -F CODERXP-ISOLATION

# Allow established/related connections
iptables -A CODERXP-ISOLATION -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

# Cross-devbox inter-container traffic drop on coderxp-net subnet
iptables -A CODERXP-ISOLATION -s 172.28.0.0/16 -d 172.28.0.0/16 -j DROP

# Block IPv4 link-local & cloud metadata (169.254.169.254 / 169.254.0.0/16)
iptables -A CODERXP-ISOLATION -d 169.254.169.254 -j DROP
iptables -A CODERXP-ISOLATION -d 169.254.0.0/16 -j DROP

# Block IPv4 loopback (127.0.0.0/8)
iptables -A CODERXP-ISOLATION -d 127.0.0.0/8 -j DROP

# Block devbox access to RFC1918 private networks
iptables -A CODERXP-ISOLATION -s 172.28.0.0/16 -d 10.0.0.0/8 -j DROP
iptables -A CODERXP-ISOLATION -s 172.28.0.0/16 -d 192.168.0.0/16 -j DROP
iptables -A CODERXP-ISOLATION -s 172.28.0.0/16 -d 172.16.0.0/12 -j DROP

# Allow DNS to host gateway (UDP and TCP port 53)
iptables -A CODERXP-ISOLATION -s 172.28.0.0/16 -d 172.28.0.1 -p udp --dport 53 -j ACCEPT
iptables -A CODERXP-ISOLATION -s 172.28.0.0/16 -d 172.28.0.1 -p tcp --dport 53 -j ACCEPT

# Block all other access from containers to host gateway
iptables -A CODERXP-ISOLATION -s 172.28.0.0/16 -d 172.28.0.1 -j DROP

iptables -A CODERXP-ISOLATION -j RETURN

# Ensure single managed jump from DOCKER-USER chain to CODERXP-ISOLATION
iptables -C DOCKER-USER -j CODERXP-ISOLATION 2>/dev/null || iptables -I DOCKER-USER 1 -j CODERXP-ISOLATION

# Protect host INPUT: prevent devboxes from reaching host services (Next.js 3100, Broker 3200, Preview 3400, SSH 22)
iptables -N CODERXP-INPUT-ISOLATION 2>/dev/null || iptables -F CODERXP-INPUT-ISOLATION
iptables -A CODERXP-INPUT-ISOLATION -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
iptables -A CODERXP-INPUT-ISOLATION -s 172.28.0.0/16 -p udp --dport 53 -j ACCEPT
iptables -A CODERXP-INPUT-ISOLATION -s 172.28.0.0/16 -p tcp --dport 53 -j ACCEPT
iptables -A CODERXP-INPUT-ISOLATION -s 172.28.0.0/16 -j DROP
iptables -A CODERXP-INPUT-ISOLATION -j RETURN

iptables -C INPUT -j CODERXP-INPUT-ISOLATION 2>/dev/null || iptables -I INPUT 1 -j CODERXP-INPUT-ISOLATION

# --- IPv6 Isolation Rules (Strictly scoped to CoderXP container traffic) ---
ip6tables -N CODERXP-ISOLATION 2>/dev/null || ip6tables -F CODERXP-ISOLATION
ip6tables -A CODERXP-ISOLATION -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
ip6tables -A CODERXP-ISOLATION -d ::1/128 -j DROP
ip6tables -A CODERXP-ISOLATION -d fe80::/10 -j DROP
ip6tables -A CODERXP-ISOLATION -d fc00::/7 -j DROP
ip6tables -A CODERXP-ISOLATION -j RETURN

ip6tables -C DOCKER-USER -j CODERXP-ISOLATION 2>/dev/null || ip6tables -I DOCKER-USER 1 -j CODERXP-ISOLATION
EOF

chmod 0755 /usr/local/bin/coderxp-firewall-docker-rules
/usr/local/bin/coderxp-firewall-docker-rules

# Install native UFW hook (/etc/ufw/after.init) for automatic reload persistence
cat << 'EOF' > /etc/ufw/after.init
#!/bin/sh
# CoderXP Native UFW hook: invoked by UFW on start, stop, and reload
case "$1" in
  start|restart)
    /usr/local/bin/coderxp-firewall-docker-rules || true
    ;;
  stop)
    ;;
  *)
    /usr/local/bin/coderxp-firewall-docker-rules || true
    ;;
esac
EOF
chmod 0755 /etc/ufw/after.init

# Install systemd service for firewall persistence across system boot
cat << 'EOF' > /etc/systemd/system/coderxp-firewall-docker.service
[Unit]
Description=CoderXP Container Isolation & Firewall Persistence
After=network.target docker.service ufw.service
PartOf=docker.service ufw.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/coderxp-firewall-docker-rules
ExecReload=/usr/local/bin/coderxp-firewall-docker-rules

[Install]
WantedBy=multi-user.target docker.service ufw.service
EOF

# Ensure Docker daemon restart automatically re-applies isolation rules
mkdir -p /etc/systemd/system/docker.service.d
cat << 'EOF' > /etc/systemd/system/docker.service.d/coderxp-firewall.conf
[Service]
ExecStartPost=/usr/local/bin/coderxp-firewall-docker-rules
EOF

# Ensure UFW systemd restart automatically re-applies isolation rules
mkdir -p /etc/systemd/system/ufw.service.d
cat << 'EOF' > /etc/systemd/system/ufw.service.d/coderxp-firewall.conf
[Service]
ExecStartPost=/usr/local/bin/coderxp-firewall-docker-rules
EOF

systemctl daemon-reload
systemctl enable --now coderxp-firewall-docker.service
log "[PASS] Persistent firewall service, native UFW hook, and daemon drop-ins installed."

# ------------------------------------------------------------------------------
# 10. Node.js 24.x LTS Installation via Verified NodeSource Repo
# ------------------------------------------------------------------------------
log "[9/13] Installing Node.js 24.x LTS (declared engines: 24.x)..."
NODESOURCE_KEY="/etc/apt/keyrings/nodesource.asc"
EXPECTED_NODESOURCE_FPT="6F7458ACF016B34DAA500F9C7D40713735FE0CD2"

if [[ ! -f "$NODESOURCE_KEY" ]]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$NODESOURCE_KEY"
  chmod a+r "$NODESOURCE_KEY"
fi

ACTUAL_NODESOURCE_FPT=$(gpg --dry-run --quiet --import --import-options import-show "$NODESOURCE_KEY" 2>/dev/null | grep -E '^[[:space:]]+[0-9A-F]{40}$' | tr -d ' ' || true)
if [[ "$ACTUAL_NODESOURCE_FPT" != "$EXPECTED_NODESOURCE_FPT" ]]; then
  rm -f "$NODESOURCE_KEY"
  fatal "NodeSource GPG fingerprint verification failed! Expected $EXPECTED_NODESOURCE_FPT, got '$ACTUAL_NODESOURCE_FPT'"
fi
log "[PASS] NodeSource GPG fingerprint verified: $ACTUAL_NODESOURCE_FPT"

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=${NODESOURCE_KEY}] https://deb.nodesource.com/node_24.x nodistro main" | \
  tee /etc/apt/sources.list.d/nodesource.list > /dev/null

apt-get update -y
apt-get install -y --no-install-recommends nodejs build-essential python3

NODE_VER="$(node -v)"
if [[ "${NODE_VER}" != v24* ]]; then
  fatal "Node.js 24 verification failed! Installed version is ${NODE_VER}"
fi
log "[PASS] Verified Node.js version: ${NODE_VER}, npm: $(npm -v)"

# ------------------------------------------------------------------------------
# 11. Nginx Base Installation & Security Baseline (Pre-TLS Configuration)
# ------------------------------------------------------------------------------
log "[10/13] Installing and hardening Nginx base configuration..."
apt-get install -y nginx
rm -f /etc/nginx/sites-enabled/default

backup_file "/etc/nginx/conf.d/00-security.conf"
cat << 'EOF' > /etc/nginx/conf.d/00-security.conf
server_tokens off;
client_max_body_size 10M;
EOF

nginx -t
systemctl reload nginx

# ------------------------------------------------------------------------------
# 12. Service Accounts & Immutable Directory Hierarchy (Docker Group Removal)
# ------------------------------------------------------------------------------
log "[11/13] Establishing identities, IPC groups, and immutable directories..."

# 0. Create dedicated IPC group for unprivileged services to communicate with docker-control
if ! getent group coderxp-ipc &>/dev/null; then
  groupadd -r coderxp-ipc
fi

# 1. coderxp-app service account
if ! id "coderxp-app" &>/dev/null; then
  useradd -r -s /usr/sbin/nologin -d /opt/coderxp -G coderxp-ipc -c "CoderXP Application Service Account" coderxp-app
else
  usermod -aG coderxp-ipc coderxp-app
fi

# 2. coderxp-preview service account (STRICTLY REMOVED from docker group)
if ! id "coderxp-preview" &>/dev/null; then
  useradd -r -s /usr/sbin/nologin -d /opt/coderxp -G coderxp-ipc -c "CoderXP Preview Service Account" coderxp-preview
else
  usermod -aG coderxp-ipc coderxp-preview
  gpasswd -d coderxp-preview docker 2>/dev/null || true
fi

# 3. coderxp-broker service account (STRICTLY REMOVED from docker group)
if ! id "coderxp-broker" &>/dev/null; then
  useradd -r -s /usr/sbin/nologin -d /opt/coderxp -G coderxp-ipc -c "CoderXP Broker Service Account" coderxp-broker
else
  usermod -aG coderxp-ipc coderxp-broker
  gpasswd -d coderxp-broker docker 2>/dev/null || true
fi

# 4. coderxp-deploy user (dynamically allocated, never assumes host UID 1000 is available)
if ! id "coderxp-deploy" &>/dev/null; then
  if ! id -u 1000 &>/dev/null; then
    useradd -m -u 1000 -s /bin/bash -c "CoderXP Deployment User" coderxp-deploy
  else
    useradd -m -s /bin/bash -c "CoderXP Deployment User" coderxp-deploy
  fi
fi
DEPLOY_UID="$(id -u coderxp-deploy)"
chmod 0750 /home/coderxp-deploy
log "[IDENTITY] coderxp-deploy verified as UID: ${DEPLOY_UID}"
log "[PASS] Verified coderxp-broker and coderxp-preview are removed from docker group and joined to coderxp-ipc."

# Immutable Directory Layout:
# /opt/coderxp/source   - Writable by coderxp-deploy (build & test workspace only)
# /opt/coderxp/staging  - Owned strictly by root:root 0700 (private root build staging)
# /opt/coderxp/releases - Owned strictly by root:root 0755 (immutable releases)
# /opt/coderxp/current  - Managed symlink pointing to /opt/coderxp/releases/<sha>
# /opt/coderxp/config   - Owned root:coderxp-app 0750
# /opt/coderxp/data     - Owned coderxp-app:coderxp-app 0750
# /opt/coderxp/logs     - Owned coderxp-app:coderxp-app 0750
# /run/coderxp          - Owned root:coderxp-ipc 0775 (Unix domain sockets)
mkdir -p /opt/coderxp/source
mkdir -p /opt/coderxp/staging
mkdir -p /opt/coderxp/releases
mkdir -p /opt/coderxp/config
mkdir -p /opt/coderxp/data
mkdir -p /opt/coderxp/logs
mkdir -p /run/coderxp
mkdir -p /etc/coderxp
mkdir -p /etc/ssl/coderxp

chown -R coderxp-deploy:coderxp-deploy /opt/coderxp/source
chown -R root:root /opt/coderxp/staging
chown -R root:root /opt/coderxp/releases
chown -R root:coderxp-app /opt/coderxp/config
chown -R coderxp-app:coderxp-app /opt/coderxp/data /opt/coderxp/logs
chown -R root:coderxp-ipc /run/coderxp
chown -R root:root /etc/coderxp /etc/ssl/coderxp

chmod 0750 /opt/coderxp/source
chmod 0700 /opt/coderxp/staging
chmod 0755 /opt/coderxp/releases
chmod 0750 /opt/coderxp/config
chmod 0750 /opt/coderxp/data /opt/coderxp/logs
chmod 0775 /run/coderxp
chmod 0755 /etc/coderxp
chmod 0755 /etc/ssl/coderxp

# ------------------------------------------------------------------------------
# 13. Root-Owned Deployment Control Wrapper (/usr/local/bin/coderxp-control)
# ------------------------------------------------------------------------------
log "[12/13] Installing root-owned deployment control wrapper..."
cat << 'EOF' > /usr/local/bin/coderxp-control
#!/usr/bin/env bash
# ==============================================================================
# CoderXP Deployment Control Wrapper (Root-Owned)
# Validates release against /etc/coderxp/approved-release before privileged actions.
# NO shell evaluation - parses strictly formatted key-value data.
# Reject duplicate keys, enforce mode 0644, single canonical lockfile hash.
# ==============================================================================
set -euo pipefail
IFS=$'\n\t'

MANIFEST="/etc/coderxp/approved-release"
DEPLOY_LOG="/var/log/coderxp-deploy.log"
CANONICAL_LOCKFILE_SHA="81d1ba80e090f1ba3bb8260e4f24a7ff97c01aee0c57927f9993579601a56351"

log_action() {
  local user="${SUDO_USER:-$(whoami)}"
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] [USER:${user}] $*" >> "$DEPLOY_LOG"
}

verify_and_load_manifest() {
  local target_sha="$1"

  # 1. Strict File Attributes Verification
  if [[ ! -f "$MANIFEST" || -L "$MANIFEST" ]]; then
    echo "[ERROR] Manifest $MANIFEST does not exist or is a symlink." >&2
    exit 1
  fi

  local file_owner file_mode
  file_owner="$(stat -c '%u:%g' "$MANIFEST")"
  if [[ "$file_owner" != "0:0" ]]; then
    echo "[ERROR] Manifest $MANIFEST is not owned by root:root (got $file_owner)." >&2
    exit 1
  fi

  file_mode="$(stat -c '%a' "$MANIFEST")"
  if [[ "$file_mode" != "644" ]]; then
    echo "[ERROR] Manifest $MANIFEST permissions ($file_mode) must be strictly 0644." >&2
    exit 1
  fi

  # 2. Strict Line-by-Line Parsing with Duplicate Key Detection (NO shell evaluation)
  APPROVED_COMMIT=""
  APPROVED_TREE=""
  APPROVED_LOCKFILE_SHA256=""
  declare -A seen_keys=()

  while IFS= read -r line || [[ -n "$line" ]]; do
    # Strip carriage returns and leading/trailing whitespace
    line="$(echo "$line" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    # Skip comments and blank lines
    [[ -z "$line" || "$line" =~ ^# ]] && continue

    # Assert strict key="value" format
    local manifest_line_pattern='^[A-Z0-9_]+="[-0-9a-zA-Z_.:]+"$'
    if [[ ! "$line" =~ $manifest_line_pattern ]]; then
      echo "[ERROR] Malformed line in manifest: $line" >&2
      exit 1
    fi

    local key val
    key="$(echo "$line" | cut -d= -f1)"
    val="$(echo "$line" | cut -d= -f2- | tr -d '"')"

    if [[ -n "${seen_keys[$key]:-}" ]]; then
      echo "[ERROR] Duplicate manifest key detected: $key" >&2
      exit 1
    fi
    seen_keys["$key"]=1

    case "$key" in
      APPROVED_COMMIT) APPROVED_COMMIT="$val" ;;
      APPROVED_TREE) APPROVED_TREE="$val" ;;
      APPROVED_LOCKFILE_SHA256) APPROVED_LOCKFILE_SHA256="$val" ;;
      APPROVED_RELEASE_BY|APPROVED_RELEASE_AT) ;; # allow audited metadata
      *)
        echo "[ERROR] Disallowed key in manifest: $key" >&2
        exit 1
        ;;
    esac
  done < "$MANIFEST"

  # 3. Assert Required Keys
  if [[ ! "$APPROVED_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
    echo "[ERROR] Invalid or missing APPROVED_COMMIT in manifest." >&2
    exit 1
  fi
  if [[ ! "$APPROVED_TREE" =~ ^[0-9a-f]{40}$ ]]; then
    echo "[ERROR] Invalid or missing APPROVED_TREE in manifest." >&2
    exit 1
  fi
  if [[ "$APPROVED_LOCKFILE_SHA256" != "$CANONICAL_LOCKFILE_SHA" ]]; then
    echo "[ERROR] APPROVED_LOCKFILE_SHA256 in manifest must be canonical: $CANONICAL_LOCKFILE_SHA (got $APPROVED_LOCKFILE_SHA256)" >&2
    exit 1
  fi

  # 4. Check target SHA matches manifest
  if [[ "$APPROVED_COMMIT" != "$target_sha" ]]; then
    echo "[ERROR] Requested release SHA ($target_sha) does not match approved manifest SHA ($APPROVED_COMMIT)." >&2
    exit 1
  fi

  # 5. Verify /opt/coderxp/source integrity
  local src_dir="/opt/coderxp/source"
  if [[ ! -d "$src_dir/.git" ]]; then
    echo "[ERROR] $src_dir is not a git repository." >&2
    exit 1
  fi

  local current_sha
  current_sha="$(git -C "$src_dir" rev-parse HEAD)"
  if [[ "$current_sha" != "$target_sha" ]]; then
    echo "[ERROR] Source HEAD ($current_sha) does not match requested SHA ($target_sha)." >&2
    exit 1
  fi

  local current_tree
  current_tree="$(git -C "$src_dir" rev-parse HEAD^{tree})"
  if [[ "$current_tree" != "$APPROVED_TREE" ]]; then
    echo "[ERROR] Source tree hash ($current_tree) does not match approved tree ($APPROVED_TREE)." >&2
    exit 1
  fi

  local current_lockfile_sha
  current_lockfile_sha="$(sha256sum "$src_dir/package-lock.json" | awk '{print $1}')"
  if [[ "$current_lockfile_sha" != "$CANONICAL_LOCKFILE_SHA" ]]; then
    echo "[ERROR] Lockfile checksum mismatch! Got $current_lockfile_sha, expected canonical $CANONICAL_LOCKFILE_SHA" >&2
    exit 1
  fi

  if [[ -n "$(git -C "$src_dir" status --porcelain)" ]]; then
    echo "[ERROR] Source working tree has uncommitted modifications." >&2
    exit 1
  fi
}

ACTION="${1:-}"
shift || true

case "$ACTION" in
  status)
    log_action "ACTION=status"
    echo "=== Systemd Services Status ==="
    systemctl status coderxp-docker-control.service coderxp-broker.service coderxp-preview.service coderxp-app.service coderxp-firewall-docker.service --no-pager || true
    echo "=== Current Release Link ==="
    ls -l /opt/coderxp/current || echo "No active release symlink."
    echo "=== Docker Security Options ==="
    docker info --format '{{json .SecurityOptions}}'
    echo "=== Nginx Configuration Syntax ==="
    nginx -t
    ;;

  install-release)
    COMMIT_SHA="${1:-}"
    if [[ ! "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
      echo "[ERROR] Commit SHA must be 40 lowercase hexadecimal characters." >&2
      exit 1
    fi
    verify_and_load_manifest "$COMMIT_SHA"
    log_action "ACTION=install-release COMMIT=${COMMIT_SHA}"

    SRC_DIR="/opt/coderxp/source"
    RELEASE_DIR="/opt/coderxp/releases/${COMMIT_SHA}"
    STAGING_DIR="/opt/coderxp/staging/${COMMIT_SHA}-$(date +%s)"

    if [[ -d "$RELEASE_DIR" ]]; then
      echo "Release directory $RELEASE_DIR already exists (immutable). Skipping build and proceeding to transactional activation."
    else
      echo "Extracting verified release tree into private root-controlled staging: $STAGING_DIR"
      mkdir -p "$STAGING_DIR"
      chmod 0700 "$STAGING_DIR"
      chown root:root "$STAGING_DIR"

      # Extract immutable git tree via git archive (independent of coderxp-deploy working tree)
      git -C "$SRC_DIR" archive "$COMMIT_SHA" | tar -x -C "$STAGING_DIR"

      # Verify staging lockfile
      STAGING_LOCK_SHA="$(sha256sum "$STAGING_DIR/package-lock.json" | awk '{print $1}')"
      if [[ "$STAGING_LOCK_SHA" != "$CANONICAL_LOCKFILE_SHA" ]]; then
        rm -rf "$STAGING_DIR"
        echo "[FATAL] Staging lockfile hash mismatch: $STAGING_LOCK_SHA" >&2
        exit 1
      fi

      # Build dependencies inside private root staging
      echo "Building release dependencies inside root staging..."
      (
        cd "$STAGING_DIR"
        npm ci --ignore-scripts
        npm rebuild node-pty
        npm run build
        node -e "require('node-pty'); console.log('[PASS] node-pty verified in staging.');"
      )

      # Move staging into immutable releases directory
      echo "Promoting root staging to immutable release directory: $RELEASE_DIR"
      mv "$STAGING_DIR" "$RELEASE_DIR"
      chown -R root:root "$RELEASE_DIR"
      chmod -R u=rwX,go=rX "$RELEASE_DIR"
    fi

    # --------------------------------------------------------------------------
    # Transactional Activation with Automatic Rollback
    # --------------------------------------------------------------------------
    echo "Performing transactional pre-flight validations..."
    PREV_CURRENT="$(readlink -f /opt/coderxp/current 2>/dev/null || true)"
    BACKUP_UNITS_DIR="/var/backups/coderxp-units-$(date +%s)"
    mkdir -p "$BACKUP_UNITS_DIR"
    cp -a /etc/systemd/system/coderxp-*.service "$BACKUP_UNITS_DIR/" 2>/dev/null || true
    cp -a /etc/nginx/sites-available/coderxp*.conf "$BACKUP_UNITS_DIR/" 2>/dev/null || true

    rollback_activation() {
      echo "[ROLLBACK] Transactional activation failed! Initiating rollback to previous release..." >&2
      if [[ -n "$PREV_CURRENT" && -d "$PREV_CURRENT" ]]; then
        ln -sfn "$PREV_CURRENT" /opt/coderxp/current
        echo "[ROLLBACK] Restored /opt/coderxp/current to $PREV_CURRENT" >&2
      fi
      if ls "$BACKUP_UNITS_DIR"/coderxp-*.service &>/dev/null; then
        cp -a "$BACKUP_UNITS_DIR"/coderxp-*.service /etc/systemd/system/
        systemctl daemon-reload
      fi
      if ls "$BACKUP_UNITS_DIR"/coderxp*.conf &>/dev/null; then
        cp -a "$BACKUP_UNITS_DIR"/coderxp*.conf /etc/nginx/sites-available/
        nginx -t && systemctl reload nginx || true
      fi
      systemctl restart coderxp-docker-control.service coderxp-broker.service coderxp-preview.service coderxp-app.service || true
      echo "[ROLLBACK] System restored to previous state." >&2
      exit 1
    }

    # Pre-validate systemd units BEFORE installation
    echo "Pre-validating unit files with systemd-analyze verify..."
    systemd-analyze verify \
      "$RELEASE_DIR/deploy/systemd/coderxp-docker-control.service" \
      "$RELEASE_DIR/deploy/systemd/coderxp-broker.service" \
      "$RELEASE_DIR/deploy/systemd/coderxp-preview.service" \
      "$RELEASE_DIR/deploy/systemd/coderxp-app.service" \
      /etc/systemd/system/coderxp-firewall-docker.service || rollback_activation

    # Install verified unit files
    install -m 0644 "$RELEASE_DIR/deploy/systemd/coderxp-docker-control.service" /etc/systemd/system/coderxp-docker-control.service
    install -m 0644 "$RELEASE_DIR/deploy/systemd/coderxp-broker.service" /etc/systemd/system/coderxp-broker.service
    install -m 0644 "$RELEASE_DIR/deploy/systemd/coderxp-preview.service" /etc/systemd/system/coderxp-preview.service
    install -m 0644 "$RELEASE_DIR/deploy/systemd/coderxp-app.service" /etc/systemd/system/coderxp-app.service

    # Atomically switch symlink
    ln -sfn "$RELEASE_DIR" /opt/coderxp/current

    # Install and test Nginx configurations
    install -m 0644 "$RELEASE_DIR/deploy/nginx/coderxp.conf" /etc/nginx/sites-available/coderxp.conf
    install -m 0644 "$RELEASE_DIR/deploy/nginx/coderxp-preview.conf" /etc/nginx/sites-available/coderxp-preview.conf
    ln -sf /etc/nginx/sites-available/coderxp.conf /etc/nginx/sites-enabled/coderxp.conf
    ln -sf /etc/nginx/sites-available/coderxp-preview.conf /etc/nginx/sites-enabled/coderxp-preview.conf

    nginx -t || rollback_activation

    # Reload systemd and restart services in strict dependency order
    systemctl daemon-reload
    systemctl restart coderxp-docker-control.service || rollback_activation
    systemctl restart coderxp-broker.service coderxp-preview.service coderxp-app.service || rollback_activation
    systemctl reload nginx || rollback_activation

    # Verify local application health
    sleep 2
    if ! curl -fsS http://127.0.0.1:3100/ > /dev/null; then
      echo "[WARN] Application health check on 3100 did not respond immediately, re-checking..."
      sleep 3
      curl -fsS http://127.0.0.1:3100/ > /dev/null || rollback_activation
    fi

    rm -rf "$BACKUP_UNITS_DIR"
    echo "[PASS] Release ${COMMIT_SHA} installed and activated transactionally."
    ;;

  build-devbox)
    COMMIT_SHA="${1:-}"
    if [[ ! "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
      echo "[ERROR] Commit SHA must be 40 lowercase hexadecimal characters." >&2
      exit 1
    fi
    verify_and_load_manifest "$COMMIT_SHA"
    log_action "ACTION=build-devbox COMMIT=${COMMIT_SHA}"

    RELEASE_DIR="/opt/coderxp/releases/${COMMIT_SHA}"
    if [[ ! -d "$RELEASE_DIR" ]]; then
      echo "[ERROR] Release $RELEASE_DIR not installed. Run install-release first." >&2
      exit 1
    fi

    echo "Building devbox container image from immutable release Dockerfile..."
    docker build \
      -t "coderxp-devbox:${COMMIT_SHA}" \
      -t "coderxp-devbox:latest" \
      -f "$RELEASE_DIR/deploy/devbox/Dockerfile" \
      "$RELEASE_DIR"

    # Verify image runs with unprivileged developer account (UID 1000)
    docker run --rm "coderxp-devbox:${COMMIT_SHA}" bash -c "whoami; id; pwd; ls -la /workspace"

    # Generate complete Software Bill of Materials (SBOM) via dpkg-query
    SBOM_FILE="/opt/coderxp/devbox-sbom-${COMMIT_SHA}.txt"
    echo "Generating SBOM via dpkg-query to $SBOM_FILE..."
    docker run --rm "coderxp-devbox:${COMMIT_SHA}" dpkg-query -W -f='${Package} ${Version} ${Architecture}\n' > "$SBOM_FILE"
    chmod 0644 "$SBOM_FILE"

    # Record and output verified image digest / ID
    IMAGE_ID=$(docker inspect --format='{{.Id}}' "coderxp-devbox:${COMMIT_SHA}")
    echo "[PASS] Devbox image built successfully. Image ID: ${IMAGE_ID}"
    echo "[PASS] Devbox SBOM recorded in: ${SBOM_FILE}"
    ;;

  restart-services)
    log_action "ACTION=restart-services"
    systemctl restart coderxp-docker-control.service coderxp-broker.service coderxp-preview.service coderxp-app.service
    nginx -t
    systemctl reload nginx
    echo "[PASS] Services restarted."
    ;;

  prune-containers)
    log_action "ACTION=prune-containers"
    docker container prune -f --filter "label=app=coderxp"
    ;;

  *)
    echo "Usage: coderxp-control {status|install-release <40-hex-sha>|build-devbox <40-hex-sha>|restart-services|prune-containers}" >&2
    exit 1
    ;;
esac
EOF

chmod 0755 /usr/local/bin/coderxp-control
chown root:root /usr/local/bin/coderxp-control

# ------------------------------------------------------------------------------
# 14. Scoped Sudoers Specification (visudo -cf validated)
# ------------------------------------------------------------------------------
log "[13/13] Installing strictly scoped sudoers rule for coderxp-deploy..."
backup_file "/etc/sudoers.d/coderxp-deploy"
SUDOERS_TMP="/tmp/coderxp-deploy.sudoers"
cat << 'EOF' > "$SUDOERS_TMP"
# Scoped CoderXP Deployment Privileges
# Grants strictly controlled access to coderxp-control wrapper.
# Zero arbitrary Docker CLI access or wildcard permissions.
coderxp-deploy ALL=(root) NOPASSWD: /usr/local/bin/coderxp-control status
coderxp-deploy ALL=(root) NOPASSWD: /usr/local/bin/coderxp-control install-release [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]
coderxp-deploy ALL=(root) NOPASSWD: /usr/local/bin/coderxp-control build-devbox [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]
coderxp-deploy ALL=(root) NOPASSWD: /usr/local/bin/coderxp-control restart-services
coderxp-deploy ALL=(root) NOPASSWD: /usr/local/bin/coderxp-control prune-containers
EOF

visudo -cf "$SUDOERS_TMP"
install -m 0440 "$SUDOERS_TMP" /etc/sudoers.d/coderxp-deploy
rm -f "$SUDOERS_TMP"

log "=================================================================="
log "  STAGE 1 BOOTSTRAP COMPLETE: SUCCESS"
log "  Backups preserved in: $BACKUP_DIR"
log "  Next Step: Paul's team populates and installs /etc/coderxp/approved-release"
log "  before running Stage 2 deployment."
log "=================================================================="
