#!/usr/bin/env bash
# n8n-setup.sh — imports Kafka credential + CDC workflow into n8n, then activates it.
# Run AFTER docker compose is up.
set -euo pipefail

N8N_URL="http://localhost:5678"
N8N_USER="admin"
N8N_PASS="admin"
AUTH="-u ${N8N_USER}:${N8N_PASS}"
DIR="$(cd "$(dirname "$0")" && pwd)"

# ── wait for n8n ────────────────────────────────────────────────────────────
echo "Waiting for n8n at ${N8N_URL}..."
for i in $(seq 1 30); do
  if curl -sf "${AUTH}" "${N8N_URL}/healthz" -o /dev/null 2>/dev/null \
  || curl -sf "${AUTH}" "${N8N_URL}/api/v1/workflows" -o /dev/null 2>/dev/null; then
    echo "n8n is ready."
    break
  fi
  echo "  attempt ${i}/30..."
  sleep 3
done

# ── obtain an API key ────────────────────────────────────────────────────────
# n8n 1.x requires an API key for the REST API.
# We create one via the owner login flow.
echo "Creating n8n API key..."
API_KEY=$(curl -sf -X POST "${N8N_URL}/api/v1/auth/api-key" \
  ${AUTH} \
  -H "Content-Type: application/json" \
  -d '{"label":"setup-key"}' 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['apiKey'])" 2>/dev/null || true)

if [ -z "${API_KEY}" ]; then
  echo "Note: Could not auto-create API key (n8n version may differ)."
  echo "Please create an API key in n8n Settings > API, set N8N_API_KEY, and re-run."
  echo ""
  echo "Manual import alternative:"
  echo "  docker exec kind_vector_n8n-n8n-1 n8n import:workflow --input=/home/node/.n8n/cdc_flow.json"
  exit 0
fi

AUTH_HEADER="-H \"X-N8N-API-KEY: ${API_KEY}\""

# ── create Kafka credential ──────────────────────────────────────────────────
echo "Creating Kafka credential..."
CRED_PAYLOAD='{
  "name": "Kafka Local",
  "type": "kafka",
  "data": {
    "clientId": "n8n-cdc-consumer",
    "brokers": "kafka:9092",
    "ssl": false
  }
}'

CRED_ID=$(curl -sf -X POST "${N8N_URL}/api/v1/credentials" \
  -H "X-N8N-API-KEY: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${CRED_PAYLOAD}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")

echo "  Kafka credential id=${CRED_ID}"

# Patch the workflow JSON with the actual credential id
FLOW_TMP=$(mktemp /tmp/cdc_flow_XXXX.json)
python3 -c "
import json, sys
with open('${DIR}/../workflows/n8n_cdc_k8s_flow.json') as f:
    wf = json.load(f)
for n in wf['nodes']:
    if n.get('type') == 'n8n-nodes-base.kafkaTrigger':
        n.setdefault('credentials', {})['kafka'] = {'id': '${CRED_ID}', 'name': 'Kafka Local'}
print(json.dumps(wf))
" > "${FLOW_TMP}"

# ── import workflow ──────────────────────────────────────────────────────────
echo "Importing CDC workflow..."
WF_ID=$(curl -sf -X POST "${N8N_URL}/api/v1/workflows" \
  -H "X-N8N-API-KEY: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "@${FLOW_TMP}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")

echo "  Workflow id=${WF_ID}"
rm -f "${FLOW_TMP}"

# ── activate workflow ────────────────────────────────────────────────────────
echo "Activating CDC workflow..."
curl -sf -X PATCH "${N8N_URL}/api/v1/workflows/${WF_ID}" \
  -H "X-N8N-API-KEY: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"active": true}' | python3 -c "
import sys,json
d = json.load(sys.stdin)
active = d.get('data',{}).get('active', d.get('active','?'))
print(f'  active={active}')
"

echo ""
echo "Done. CDC workflow is active and listening on kafka:9092 topic k8s-resources."
