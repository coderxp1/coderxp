#!/usr/bin/env bash
# scripts/comfyui-smoke.sh
# End-to-end smoke test for ComfyUI media provider (image + video generation via loopback/tunnel).

set -euo pipefail

COMFYUI_URL="${COMFYUI_URL:-http://127.0.0.1:8188}"
SMOKE_TMP_DIR=$(mktemp -d "${PWD}/.smoke-XXXXXX")
export COMFY_DATA_DIR="${SMOKE_TMP_DIR}"

echo "=========================================================="
echo " ComfyUI Media Provider Smoke Test"
echo " COMFYUI_URL:    ${COMFYUI_URL}"
echo " COMFY_DATA_DIR: ${COMFY_DATA_DIR}"
echo "=========================================================="

cleanup() {
  rm -rf "${SMOKE_TMP_DIR}"
}
trap cleanup EXIT

# 1. Health check
echo -e "\n[1/3] Verifying ComfyUI health & system_stats..."
curl -sSf "${COMFYUI_URL}/system_stats" > /dev/null || {
  echo "ERROR: Failed to connect to ComfyUI at ${COMFYUI_URL}"
  exit 1
}
echo "ComfyUI is responding to system_stats."

# 2. Run provider unit tests
echo -e "\n[2/3] Running provider unit test suite..."
npx tsx scripts/test-provider-comfyui.ts

# 3. Run provider integration test suite (5 live scenarios)
echo -e "\n[3/3] Running live integration scenarios (Image + Video + Cancel + Limits)..."
export COMFYUI_URL="${COMFYUI_URL}"
npx tsx scripts/test-comfyui-integration.ts

echo -e "\n=========================================================="
echo " SMOKE TEST COMPLETE: All tests passed successfully."
echo "=========================================================="
