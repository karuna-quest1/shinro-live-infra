#!/usr/bin/env bash
# Every 5 minutes (systemd timer): how many Compose services are not running,
# or running but unhealthy. Sent as UnhealthyContainers; the alarm also fires
# when the metric stops arriving (host down or this timer broken).
set -uo pipefail
cd "$(dirname "$0")/.."
token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
meta() { curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"; }
instance=$(meta instance-id); region=$(meta placement/region)

expected=$(docker compose -f docker-compose.yaml config --services 2>/dev/null | sort)
bad=0
for svc in $expected; do
  state=$(docker compose -f docker-compose.yaml ps --all --format '{{.State}} {{.Health}}' "$svc" 2>/dev/null | head -1)
  case "$state" in
    "running unhealthy"*|"") bad=$((bad + 1)); echo "unhealthy: $svc (${state:-missing})" ;;
    running*) ;;
    *) bad=$((bad + 1)); echo "down: $svc ($state)" ;;
  esac
done
aws cloudwatch put-metric-data --region "$region" --namespace ShinroLive/Camunda --metric-name UnhealthyContainers \
  --dimensions InstanceId="$instance" --value "$bad" --unit Count
echo "$bad unhealthy of $(echo "$expected" | wc -w)"
