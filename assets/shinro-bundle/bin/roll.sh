#!/usr/bin/env bash
# Releases what /shinro/live/release says, recreating only the named services
# (all when none are named). CI calls this over SSM (PLAN 3.6):
#   /opt/shinro-live/bin/roll.sh shinro-api tool-exec
# Running sessions on EKS are never touched: new images reach new sessions only.
set -euo pipefail
cd "$(dirname "$0")/.."
log() { echo "[$(date -Is)] $*"; }
compose() { docker compose -f docker-compose.yaml -f run/compose.streams.yaml --env-file run/images.env "$@"; }

# The CI workflow names services after its images; map them to Compose names.
services=()
for s in "$@"; do
  case "$s" in
    api) services+=(shinro-api) ;;
    *) services+=("$s") ;;
  esac
done

log "rendering configuration"
python3 bin/render.py

log "certificate"
bin/certs.sh

token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
region=$(curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/region)
account=$(aws sts get-caller-identity --query Account --output text)
aws ecr get-login-password --region "$region" \
  | docker login --username AWS --password-stdin "$account.dkr.ecr.$region.amazonaws.com" >/dev/null

log "pulling ${services[*]:-all services}"
compose pull --quiet "${services[@]}"
log "starting"
compose up -d --remove-orphans "${services[@]}"
# Configuration may have changed even when nginx itself didn't.
compose exec -T nginx nginx -t && compose exec -T nginx nginx -s reload
compose ps
log "done"
