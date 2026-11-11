#!/usr/bin/env bash
# Brings the Shinro EC2 up. First boot runs it from UserData; safe to re-run
# (bin/update.sh does, after a bundle change).
set -euo pipefail
cd "$(dirname "$0")/.."
log() { echo "[$(date -Is)] $*"; }

COMPOSE_VERSION=v2.32.4
COMPOSE_SHA256=ed1917fb54db184192ea9d0717bcd59e3662ea79db48bff36d3475516c480a6b
PLUGINS=/usr/libexec/docker/cli-plugins

log "packages"
dnf install -y -q docker amazon-cloudwatch-agent unzip
mkdir -p "$PLUGINS"
if ! echo "$COMPOSE_SHA256  $PLUGINS/docker-compose" | sha256sum -c --quiet - 2>/dev/null; then
  curl -fsSL "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-x86_64" -o "$PLUGINS/docker-compose.tmp"
  echo "$COMPOSE_SHA256  $PLUGINS/docker-compose.tmp" | sha256sum -c --quiet -
  chmod +x "$PLUGINS/docker-compose.tmp" && mv "$PLUGINS/docker-compose.tmp" "$PLUGINS/docker-compose"
fi
systemctl enable --now docker

log "cloudwatch agent (memory and disk metrics)"
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s -c "file:$PWD/cloudwatch-agent.json"

# Daily certificate renewal; certbot only renews within 30 days of expiry.
cat > /etc/systemd/system/shinro-certs.service <<UNIT
[Unit]
Description=Renew the *.shinro.ai certificate
[Service]
Type=oneshot
ExecStart=$PWD/bin/certs.sh
UNIT
cat > /etc/systemd/system/shinro-certs.timer <<UNIT
[Unit]
Description=Daily certificate renewal
[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now shinro-certs.timer

# Container health every 5 minutes, for the UnhealthyContainers alarm (step 8).
cat > /etc/systemd/system/shinro-health.service <<UNIT
[Unit]
Description=Report unhealthy containers to CloudWatch
[Service]
Type=oneshot
ExecStart=$PWD/bin/health.sh
UNIT
cat > /etc/systemd/system/shinro-health.timer <<UNIT
[Unit]
Description=Container health every 5 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now shinro-health.timer

log "release"
exec bin/roll.sh
