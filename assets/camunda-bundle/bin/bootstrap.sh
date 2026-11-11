#!/usr/bin/env bash
# Brings the shared demo Camunda up on this instance. Safe to re-run: first
# boot runs it from UserData, and a bundle update runs it again over SSM:
#
#   aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
#     --parameters 'commands=["/opt/camunda/bin/update.sh"]'
set -euo pipefail
cd "$(dirname "$0")/.."

log() { echo "[$(date -Is)] $*"; }

COMPOSE_VERSION=v2.32.4
COMPOSE_SHA256=ed1917fb54db184192ea9d0717bcd59e3662ea79db48bff36d3475516c480a6b
BUILDX_VERSION=v0.20.1
BUILDX_SHA256=8c38f60308a895fa570f1410e453c5de11aafd65a99fa99965d96d24b6225a78
PLUGINS=/usr/libexec/docker/cli-plugins

install_plugin() { # <name> <url> <sha256>
  local dest="$PLUGINS/$1"
  if [ -x "$dest" ] && echo "$3  $dest" | sha256sum -c --quiet - 2>/dev/null; then return; fi
  log "installing $1"
  curl -fsSL "$2" -o "$dest.tmp"
  echo "$3  $dest.tmp" | sha256sum -c --quiet -
  chmod +x "$dest.tmp" && mv "$dest.tmp" "$dest"
}

log "packages"
dnf install -y -q docker git amazon-cloudwatch-agent unzip
mkdir -p "$PLUGINS"
install_plugin docker-compose \
  "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-x86_64" "$COMPOSE_SHA256"
# Compose builds the OMS app from its git repo, which needs buildx.
install_plugin docker-buildx \
  "https://github.com/docker/buildx/releases/download/$BUILDX_VERSION/buildx-$BUILDX_VERSION.linux-amd64" "$BUILDX_SHA256"

# Elasticsearch refuses to start below this.
echo 'vm.max_map_count=262144' > /etc/sysctl.d/99-elasticsearch.conf
sysctl -q --system

systemctl enable --now docker

log "cloudwatch agent (memory and disk metrics)"
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s -c "file:$PWD/cloudwatch-agent.json"

# Container health every 5 minutes, for the UnhealthyContainers alarm (step 8).
cat > /etc/systemd/system/camunda-health.service <<UNIT
[Unit]
Description=Report unhealthy containers to CloudWatch
[Service]
Type=oneshot
ExecStart=$PWD/bin/health.sh
UNIT
cat > /etc/systemd/system/camunda-health.timer <<UNIT
[Unit]
Description=Container health every 5 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now camunda-health.timer

log "rendering .env"
bin/render-env.sh

log "starting Camunda (first boot builds the OMS app; allow ~10 minutes)"
docker compose up -d --build --remove-orphans
docker compose ps
log "done"
