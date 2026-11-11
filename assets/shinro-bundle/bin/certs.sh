#!/usr/bin/env bash
# Makes sure nginx has a certificate for the two consoles (decision 4.5).
#
# With a Cloudflare API token in Secrets Manager (shinro-live/cloudflare/dns-api-token,
# scope Zone > DNS > Edit on shinro.ai only), certbot gets a free wildcard
# *.shinro.ai from Let's Encrypt through a DNS-01 challenge and renews it.
# Without one, a self-signed certificate stands in so nginx can start;
# browsers will warn until the token is added.
set -euo pipefail
cd "$(dirname "$0")/.."
log() { echo "[$(date -Is)] certs: $*"; }

domain=$(python3 -c 'import json,subprocess;print(json.loads(subprocess.run(["aws","ssm","get-parameter","--name","/shinro/live/shinro/config","--query","Parameter.Value","--output","text"],capture_output=True,text=True,check=True).stdout)["domain"])')
live=/etc/letsencrypt/live/$domain
certbot_image=$(grep '^CERTBOT_IMAGE=' run/images.env | cut -d= -f2-)

reload_nginx() { docker exec nginx nginx -s reload 2>/dev/null || true; }

token=$(aws secretsmanager get-secret-value --secret-id shinro-live/cloudflare/dns-api-token \
          --query SecretString --output text 2>/dev/null || true)

if [ -n "$token" ]; then
  install -d -m 700 /root/.secrets
  umask 077
  printf 'dns_cloudflare_api_token = %s\n' "$token" > /root/.secrets/cloudflare.ini
  # A self-signed stand-in blocks certbot from creating its own live/ folder.
  [ -f "/etc/letsencrypt/renewal/$domain.conf" ] || rm -rf "$live"
  docker run --rm \
    -v /etc/letsencrypt:/etc/letsencrypt \
    -v /root/.secrets/cloudflare.ini:/cloudflare.ini:ro \
    "$certbot_image" certonly --dns-cloudflare --dns-cloudflare-credentials /cloudflare.ini \
      --dns-cloudflare-propagation-seconds 30 \
      -d "$domain" -d "*.$domain" --cert-name "$domain" \
      --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring
  log "certificate from Let's Encrypt"
elif [ ! -f "$live/fullchain.pem" ]; then
  log "no Cloudflare token yet; using a self-signed stand-in (browsers will warn)"
  mkdir -p "$live"
  openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj "/CN=*.$domain" \
    -addext "subjectAltName=DNS:$domain,DNS:*.$domain" \
    -keyout "$live/privkey.pem" -out "$live/fullchain.pem" 2>/dev/null
fi
reload_nginx

# Days left, for the expiry alarm (step 8).
expires=$(openssl x509 -enddate -noout -in "$live/fullchain.pem" | cut -d= -f2)
days=$(( ( $(date -d "$expires" +%s) - $(date +%s) ) / 86400 ))
aws cloudwatch put-metric-data --namespace ShinroLive/Shinro --metric-name CertificateDaysToExpiry \
  --value "$days" --unit Count >/dev/null 2>&1 || true
log "$days days left"
