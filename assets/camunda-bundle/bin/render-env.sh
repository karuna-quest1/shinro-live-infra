#!/usr/bin/env bash
# Writes .env (mode 600) from camunda.env plus values resolved by name at boot:
# the public host from SSM, every secret from Secrets Manager. Nothing secret
# is ever in the bundle or the image (docs/CAMUNDA-DEPLOYMENT.md section 4.3).
set -euo pipefail
cd "$(dirname "$0")/.."

token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
region=$(curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/region)
export AWS_DEFAULT_REGION=$region

param()  { aws ssm get-parameter --name "/shinro/live/camunda/$1" --query Parameter.Value --output text; }
secret() { aws secretsmanager get-secret-value --secret-id "shinro-live/camunda/$1" --query SecretString --output text; }

umask 077
{
  cat camunda.env
  echo
  echo "# Rendered $(date -Is) by bin/render-env.sh"
  echo "AWS_REGION=$region"
  echo "HOST=$(param public-host)"
  echo "KEYCLOAK_ADMIN_PASSWORD=$(secret keycloak-admin-password)"
  echo "POSTGRES_PASSWORD=$(secret postgres-password)"
  echo "ORCHESTRATION_CLIENT_SECRET=$(secret orchestration-client-secret)"
  echo "IDENTITY_CLIENT_SECRET=$(secret identity-client-secret)"
  echo "OMS_APP_CLIENT_SECRET=$(secret oms-app-client-secret)"
  echo "SHINRO_ASSESSMENT_CLIENT_SECRET=$(secret shinro-assessment-client-secret)"
} > .env.tmp
mv .env.tmp .env
