#!/usr/bin/env bash
# Fetches the bundle CDK last published and re-runs bootstrap. Used after a
# `cdk deploy` that changed assets/camunda-bundle. The instance is not replaced.
set -euo pipefail
token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
export AWS_DEFAULT_REGION=$(curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/region)
url=$(aws ssm get-parameter --name /shinro/live/camunda/bundle-s3-url --query Parameter.Value --output text)
tmp=$(mktemp -d)
aws s3 cp "$url" "$tmp/bundle.zip"
unzip -oq "$tmp/bundle.zip" -d /opt/camunda
rm -rf "$tmp"
chmod +x /opt/camunda/bin/*.sh
exec /opt/camunda/bin/bootstrap.sh
