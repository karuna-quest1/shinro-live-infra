#!/usr/bin/env bash
# Builds the Shinro live images from the app repo and pushes them to ECR,
# tagged with the commit SHA. A manual stand-in for the parked CI pipeline
# (.github/workflows/live-release-main.yml in the app repo does the same).
#
#   AWS_PROFILE=cdk-dev scripts/push-images.sh [branch] [app-repo-dir]
#
# Builds from a clean, temporary copy of the branch, so local edits and
# untracked files in the app repo never end up in an image.
set -euo pipefail

BRANCH=${1:-camunda-temporal-deployment-main}
APP_REPO=${2:-$HOME/shinro}
REGION=us-east-1
ACCOUNT=425106880357
REG=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com
TEMPORAL_VERSION=1.10.0
BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/shinro-build.XXXXXX")

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

cleanup() {
  git -C "$APP_REPO" worktree remove --force "$BUILD_DIR" >/dev/null 2>&1 || rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

log "Checks"
docker info >/dev/null 2>&1 || { echo "Docker isn't running. Start Docker Desktop and try again."; exit 1; }
aws sts get-caller-identity --query Arn --output text
[ -d "$APP_REPO/.git" ] || { echo "No git repo at $APP_REPO"; exit 1; }

log "Clean copy of origin/$BRANCH"
git -C "$APP_REPO" fetch --quiet origin "$BRANCH"
rmdir "$BUILD_DIR"
git -C "$APP_REPO" worktree add --quiet --detach "$BUILD_DIR" "origin/$BRANCH"
SHA=$(git -C "$BUILD_DIR" rev-parse HEAD)
echo "commit $SHA"
cd "$BUILD_DIR"

log "ECR login"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REG"

exists() { aws ecr describe-images --region "$REGION" --repository-name "$1" --image-ids imageTag="$2" >/dev/null 2>&1; }

build() { # <name> <dockerfile> <context>
  local repo=shinro-live-$1
  if exists "$repo" "$SHA"; then echo "$repo:$SHA already in ECR, skipping"; return; fi
  log "Build and push $repo (linux/amd64; slow on an Apple Silicon Mac)"
  docker buildx build --platform linux/amd64 --provenance=false -f "$2" -t "$REG/$repo:$SHA" --push "$3"
}

build api       apps/api/Dockerfile                apps/api
build tool-exec tools/tool_execution/Dockerfile    .
build terminal  docker/demo-terminal/Dockerfile    .

if exists shinro-live-temporal "$TEMPORAL_VERSION"; then
  echo "shinro-live-temporal:$TEMPORAL_VERSION already in ECR, skipping"
else
  log "Copy temporalio/temporal:$TEMPORAL_VERSION"
  docker pull --platform linux/amd64 "temporalio/temporal:$TEMPORAL_VERSION"
  docker tag "temporalio/temporal:$TEMPORAL_VERSION" "$REG/shinro-live-temporal:$TEMPORAL_VERSION"
  docker push "$REG/shinro-live-temporal:$TEMPORAL_VERSION"
fi

log "Done. Commit $SHA"
for r in api tool-exec terminal; do echo "  $REG/shinro-live-$r:$SHA"; done
echo "  $REG/shinro-live-temporal:$TEMPORAL_VERSION"
