#!/bin/bash
set -e

echo "=== 1. Testing in-container git config credential helper ==="
docker run --rm coderxp-devbox:latest git config -l | grep credential

echo "=== 2. Testing broker deleteDevbox automatic devbox.lifecycle emission ==="
curl -s -X DELETE http://127.0.0.1:3100/api/devbox \
  -H "Content-Type: application/json" \
  -d '{"projectId":"pilot-auto-lifecycle-test","action":"soft-delete"}'
echo ""
curl -s "http://127.0.0.1:3100/api/devbox/events?projectId=pilot-auto-lifecycle-test"
echo ""

echo "=== 3. Testing timeline events query ==="
curl -s "http://127.0.0.1:3100/api/devbox/events?projectId=default-project"
echo ""
