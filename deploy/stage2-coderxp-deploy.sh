#!/usr/bin/env bash
# ==============================================================================
# CoderXP Dedicated Server - Stage 2: Application Deployment
# Target Server: 87.106.134.211
# Role: Dedicated CoderXP Production Host
# Author: CoderXP Engineering / Paul's Team
# Execution: Run as coderxp-deploy (NON-ROOT).
# Usage: ./stage2-coderxp-deploy.sh <40-character-commit-sha>
# Idempotent: Can be executed repeatedly for verified immutable releases.
# ==============================================================================

set -euo pipefail
IFS=$'\n\t'

# 1. Strict Argument Validation (No Default Commit)
if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <40-character-commit-sha>" >&2
  exit 64
fi

EXPECTED_COMMIT="$1"
if [[ ! "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[FATAL] Commit SHA must be exactly 40 lowercase hexadecimal characters." >&2
  exit 64
fi

REPO_URL="https://github.com/phartmann80/coderxp.git"
SOURCE_DIR="/opt/coderxp/source"
CANONICAL_LOCKFILE_SHA="81d1ba80e090f1ba3bb8260e4f24a7ff97c01aee0c57927f9993579601a56351"

echo "=================================================================="
echo "  CODERXP STAGE 2 APPLICATION DEPLOYMENT"
echo "  Target Release Commit: ${EXPECTED_COMMIT}"
echo "  Started at: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "=================================================================="

# 2. Verify Non-Root Execution
if [[ "$(id -u)" -eq 0 ]]; then
  echo "[FATAL] Stage 2 deployment must be run as 'coderxp-deploy', NOT root." >&2
  exit 1
fi

# 3. Clone or Update Verified Git Repository
if [[ ! -d "${SOURCE_DIR}/.git" ]]; then
  echo "[1/8] Cloning clean repository from GitHub..."
  git clone "${REPO_URL}" "${SOURCE_DIR}"
fi

cd "${SOURCE_DIR}"
echo "[2/8] Fetching and checking out release commit ${EXPECTED_COMMIT}..."
git fetch origin
git checkout "${EXPECTED_COMMIT}"

# Assert exact commit match
CURRENT_COMMIT="$(git rev-parse HEAD)"
if [[ "${CURRENT_COMMIT}" != "${EXPECTED_COMMIT}" ]]; then
  echo "[FATAL] Repository commit mismatch! Expected ${EXPECTED_COMMIT}, got ${CURRENT_COMMIT}" >&2
  exit 1
fi

# Assert clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "[FATAL] Working tree is dirty. Deployment halted." >&2
  exit 1
fi

# 4. Lockfile Integrity Verification (Canonical Linux LF hash only)
echo "[3/8] Verifying package-lock.json integrity..."
ACTUAL_LOCKFILE_SHA="$(sha256sum package-lock.json | awk '{print $1}')"
if [[ "$ACTUAL_LOCKFILE_SHA" != "$CANONICAL_LOCKFILE_SHA" ]]; then
  echo "[FATAL] package-lock.json SHA-256 mismatch!" >&2
  echo "Expected (Linux canonical LF): $CANONICAL_LOCKFILE_SHA" >&2
  echo "Actual:                       $ACTUAL_LOCKFILE_SHA" >&2
  exit 1
fi
echo "[PASS] Lockfile SHA-256 verified: ${ACTUAL_LOCKFILE_SHA}"

# 5. Pre-deployment Build & Tests in User Space
echo "[4/8] Installing production dependencies with --ignore-scripts..."
npm ci --ignore-scripts

echo "[4/8] Building vetted native module: node-pty..."
npm rebuild node-pty

# Verify native module load
node -e "require('node-pty'); console.log('[PASS] node-pty native binary verified.');"

echo "[5/8] Building Next.js production bundle..."
npm run build

echo "[6/8] Running complete test suite and isolation regression before service startup..."
npm test

# 6. Install Release to Root Immutable Storage via Control Wrapper
echo "[7/8] Installing release to root-owned immutable directory via control wrapper..."
sudo /usr/local/bin/coderxp-control install-release "${EXPECTED_COMMIT}"

echo "[8/8] Building devbox container image from immutable release via control wrapper..."
sudo /usr/local/bin/coderxp-control build-devbox "${EXPECTED_COMMIT}"

echo "Restarting CoderXP services..."
sudo /usr/local/bin/coderxp-control restart-services

# 7. Post-deployment Status & Health Verification
echo "Verifying local service health and status..."
sudo /usr/local/bin/coderxp-control status

# Query local app endpoints
curl -fsS http://127.0.0.1:3100/ > /dev/null
echo "[PASS] Application health check (http://127.0.0.1:3100/) responded OK."

echo "=================================================================="
echo "  STAGE 2 APPLICATION DEPLOYMENT COMPLETE: SUCCESS"
echo "  Deployed Commit: ${EXPECTED_COMMIT}"
echo "=================================================================="
