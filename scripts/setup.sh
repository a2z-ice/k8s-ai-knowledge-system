#!/usr/bin/env bash
#
# setup.sh — Bootstrap the Kubernetes AI Knowledge System from scratch
#
# Usage:
#   ./scripts/setup.sh [OPTIONS]
#
# Options:
#   --keep-cluster   Reuse existing kind cluster; skip kind delete/create
#   --no-test        Skip the final npm test run
#   -h, --help       Show this help text

set -euo pipefail

# ── colours ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GREEN}[$(date +%H:%M:%S)] ✓${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date +%H:%M:%S)] ⚠${NC} $*"; }
die()  { echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC} $*" >&2; exit 1; }
step() { echo -e "\n${BOLD}${CYAN}━━━ $* ━━━${NC}"; }

# ── constants ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLUSTER_NAME="k8s-ai"
CONTEXT="kind-k8s-ai"
NAMESPACE="k8s-ai"
KEEP_CLUSTER=false
RUN_TESTS=true

# ── parse args ───────────────────────────────────────────────────────────────
for arg in "$@"; do
  case $arg in
    --keep-cluster) KEEP_CLUSTER=true ;;
    --no-test)      RUN_TESTS=false ;;
    -h|--help)
      sed -n '3,11p' "$0"; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

cd "${PROJECT_ROOT}"

# ── helpers ──────────────────────────────────────────────────────────────────
require_cmd() {
  command -v "$1" &>/dev/null || die "Required command not found: $1 — install it first"
}

wait_for_rollout() {
  local kind="$1" name="$2" timeout="${3:-120}"
  log "Waiting for ${kind}/${name} …"
  kubectl --context "${CONTEXT}" -n "${NAMESPACE}" rollout status \
    "${kind}/${name}" --timeout="${timeout}s"
}

get_n8n_pod() {
  kubectl --context "${CONTEXT}" -n "${NAMESPACE}" get pod \
    -l app=n8n -o jsonpath='{.items[0].metadata.name}' 2>/dev/null
}

n8n_exec() {
  local pod
  pod="$(get_n8n_pod)"
  kubectl --context "${CONTEXT}" -n "${NAMESPACE}" exec "${pod}" -- "$@"
}

qdrant_points() {
  curl -sf "http://localhost:30001/collections/k8s" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['points_count'])" \
    2>/dev/null || echo "0"
}

# Detect sqlite3 — prefer the host-installed one if it's recent
SQLITE3_BIN="$(command -v sqlite3 2>/dev/null || true)"
if [[ -z "${SQLITE3_BIN}" ]]; then
  SQLITE3_BIN="/Volumes/Other/opt/miniconda3/envs/ml/bin/sqlite3"
fi
if [[ ! -x "${SQLITE3_BIN}" ]]; then
  warn "sqlite3 not found — workflow deduplication will be skipped"
  SQLITE3_BIN=""
fi

# ── step 1: prerequisites ────────────────────────────────────────────────────
step "Checking prerequisites"

require_cmd docker
require_cmd kind
require_cmd kubectl
require_cmd ollama
require_cmd npm
require_cmd node
require_cmd python3
ok "All required commands present"

# Ollama models
log "Checking Ollama models …"
OLLAMA_MODELS=$(ollama list 2>/dev/null || true)
for model in "nomic-embed-text" "qwen3:8b"; do
  if echo "${OLLAMA_MODELS}" | grep -q "${model}"; then
    ok "  ${model} ✓"
  else
    warn "  ${model} not found — pulling (this may take several minutes)"
    ollama pull "${model}"
    ok "  ${model} pulled"
  fi
done

# npm dependencies
if [[ ! -d "${PROJECT_ROOT}/node_modules" ]]; then
  log "Installing npm dependencies …"
  npm install --prefix "${PROJECT_ROOT}" --silent
  ok "npm install complete"
else
  ok "node_modules already present"
fi

# ── step 2: delete old cluster (if recreating) ───────────────────────────────
# Done BEFORE the port-conflict check so the cluster's NodePorts are freed
# and do not appear as conflicts when we probe with lsof below.
if [[ "${KEEP_CLUSTER}" == "false" ]]; then
  if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    step "Deleting existing cluster"
    warn "Deleting existing cluster '${CLUSTER_NAME}' …"
    kind delete cluster --name "${CLUSTER_NAME}"
    ok "Cluster deleted"
    # Brief pause for OS to release the port bindings
    sleep 3
  fi
fi

# ── step 2b: check for port conflicts ────────────────────────────────────────
# Skip port check when reusing existing cluster — the ports are already held by kind
if [[ "${KEEP_CLUSTER}" == "false" ]]; then
  step "Checking port availability (30000–30004)"

  CONFLICTING=()
  for port in 30000 30001 30002 30003 30004; do
    if lsof -iTCP:"${port}" -sTCP:LISTEN -t &>/dev/null 2>&1; then
      CONFLICTING+=("localhost:${port}")
    fi
  done

  if [[ ${#CONFLICTING[@]} -gt 0 ]]; then
    warn "Ports in use: ${CONFLICTING[*]}"
    warn "Another process is listening on one of the required ports (30000–30004)."
    warn "Identify and stop it, then re-run this script."
    warn "  Example: lsof -iTCP:30000 -sTCP:LISTEN"
    die  "Port conflict — cannot bind kind NodePorts"
  fi
  ok "Ports 30000–30004 are free"
else
  step "Checking port availability (30000–30004)"
  ok "Skipped — reusing existing cluster (--keep-cluster)"
fi

# ── step 3: data directories ─────────────────────────────────────────────────
# NEVER wipe data/n8n/ — it contains the encryption key (config) and credentials.
# Duplicate workflows are handled by deleting workflow_entity rows via sqlite3
# (with n8n stopped) in step 10 before re-importing.
step "Data directories"

for dir in data/n8n data/qdrant data/kafka data/postgres; do
  mkdir -p "${PROJECT_ROOT}/${dir}"
  ok "  ${dir}"
done

# ── step 4: kind cluster ─────────────────────────────────────────────────────
step "kind cluster"

if [[ "${KEEP_CLUSTER}" == "true" ]]; then
  if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    ok "Reusing existing cluster '${CLUSTER_NAME}' (--keep-cluster)"
  else
    die "--keep-cluster specified but cluster '${CLUSTER_NAME}' does not exist"
  fi
else
  # Cluster was already deleted in step 2 (before port-conflict check).
  # Just create it here.
  log "Creating cluster '${CLUSTER_NAME}' with infra/kind-config.yaml …"
  kind create cluster --config "${PROJECT_ROOT}/infra/kind-config.yaml"
  ok "Cluster created"
fi

# Verify node ready
log "Waiting for cluster node to become Ready …"
kubectl --context "${CONTEXT}" wait node \
  --for=condition=Ready --all --timeout=60s
ok "Node is Ready"

# Verify NodePort mappings are present
log "Verifying NodePort mappings …"
PORTBINDINGS=$(docker inspect "${CLUSTER_NAME}-control-plane" \
  --format '{{json .HostConfig.PortBindings}}' 2>/dev/null)
for port in 30000 30001 30002 30003 30004; do
  echo "${PORTBINDINGS}" | grep -q "\"${port}/tcp\"" \
    || die "Port ${port} not mapped in kind node — recreate cluster without --keep-cluster"
done
ok "NodePort mappings confirmed: 30000/30001/30002/30003/30004"

# ── step 5: kubernetes manifests ────────────────────────────────────────────
step "Applying Kubernetes manifests"

log "Namespace + PersistentVolumes …"
kubectl --context "${CONTEXT}" apply -f "${PROJECT_ROOT}/infra/k8s/00-namespace.yaml"
kubectl --context "${CONTEXT}" apply -f "${PROJECT_ROOT}/infra/k8s/01-pvs.yaml"
ok "Namespace and PVs applied"

log "Kafka …"
kubectl --context "${CONTEXT}" apply -f "${PROJECT_ROOT}/infra/k8s/kafka/"
wait_for_rollout statefulset kafka 180
ok "Kafka is Running"

log "Qdrant …"
kubectl --context "${CONTEXT}" apply -f "${PROJECT_ROOT}/infra/k8s/qdrant/"
wait_for_rollout deployment qdrant 60
ok "Qdrant is Running"

log "PostgreSQL …"
kubectl --context "${CONTEXT}" apply -f "${PROJECT_ROOT}/infra/k8s/postgres/"
wait_for_rollout deployment postgres 120
log "Waiting for postgres pod readiness probe …"
kubectl --context "${CONTEXT}" -n "${NAMESPACE}" wait \
  --for=condition=ready pod -l app=postgres --timeout=120s
ok "PostgreSQL is Ready"

log "pgAdmin …"
kubectl --context "${CONTEXT}" apply -f "${PROJECT_ROOT}/infra/k8s/pgadmin/"
ok "pgAdmin manifests applied (starting in background)"

# ── step 6: build + load k8s-watcher ────────────────────────────────────────
step "Building k8s-watcher image"

log "docker build …"
docker build -t k8s-watcher:latest "${PROJECT_ROOT}/k8s-watcher/" --quiet
ok "Image built: k8s-watcher:latest"

log "Loading image into kind cluster …"
kind load docker-image k8s-watcher:latest --name "${CLUSTER_NAME}"
ok "Image loaded into cluster"

log "Deploying k8s-watcher …"
kubectl --context "${CONTEXT}" apply -f "${PROJECT_ROOT}/infra/k8s/k8s-watcher/"
wait_for_rollout deployment k8s-watcher 90
ok "k8s-watcher is Running"

# ── step 7: n8n ──────────────────────────────────────────────────────────────
step "Deploying n8n"

kubectl --context "${CONTEXT}" apply -f "${PROJECT_ROOT}/infra/k8s/n8n/"
wait_for_rollout deployment n8n 180
ok "n8n is Running"

# ── step 8: verify all pods ──────────────────────────────────────────────────
step "All pods status"
kubectl --context "${CONTEXT}" -n "${NAMESPACE}" get pods
echo

# ── step 9: qdrant collection ────────────────────────────────────────────────
step "Qdrant collection"

log "Checking if collection 'k8s' exists …"
COLLECTION_STATUS=$(curl -sf "http://localhost:30001/collections/k8s" 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','error'))" \
  2>/dev/null || echo "error")

if [[ "${COLLECTION_STATUS}" == "ok" ]]; then
  ok "Collection 'k8s' already exists — skipping creation"
else
  log "Creating Qdrant collection 'k8s' (768-dim Cosine) …"
  RESULT=$(curl -sf -X PUT "http://localhost:30001/collections/k8s" \
    -H "Content-Type: application/json" \
    -d @"${PROJECT_ROOT}/infra/schemas/qdrant_k8s_collection_schema.json")
  echo "${RESULT}" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('result')==True, d" \
    || die "Qdrant collection creation failed: ${RESULT}"
  ok "Collection 'k8s' created"
fi

# ── step 10: n8n workflows ───────────────────────────────────────────────────
# Safe DB modification protocol:
#   1. Scale n8n to 0 (stop) → safe to run sqlite3
#   2. Delete existing workflow rows (prevents duplicates on re-run)
#   3. Create Kafka credential if missing (OpenSSL-AES encrypted with n8n's key)
#   4. Scale n8n to 1 (start) → import + publish via n8n CLI
#   5. Rollout restart so published state takes effect
# ─────────────────────────────────────────────────────────────────────────────
step "n8n workflows"

N8N_DB="${PROJECT_ROOT}/data/n8n/database.sqlite"

# 10a. Stop n8n to safely modify its SQLite DB
log "Stopping n8n for safe DB setup …"
kubectl --context "${CONTEXT}" -n "${NAMESPACE}" scale deployment/n8n --replicas=0
# Wait for pod to terminate
for _i in $(seq 1 30); do
  RUNNING=$(kubectl --context "${CONTEXT}" -n "${NAMESPACE}" get pods -l app=n8n \
    --no-headers 2>/dev/null | wc -l | tr -d ' ')
  [[ "${RUNNING}" == "0" ]] && break
  sleep 2
done
ok "n8n stopped"

# 10b. Delete existing workflow rows to avoid duplicates (sqlite3 is safe now).
#      We delete both by name and by the known static IDs embedded in the JSON files
#      so that a re-run after a partial failure also cleans up correctly.
if [[ -n "${SQLITE3_BIN}" && -f "${N8N_DB}" ]]; then
  log "Removing existing workflow rows (credentials and encryption key preserved) …"
  "${SQLITE3_BIN}" "${N8N_DB}" \
    "DELETE FROM workflow_entity WHERE name IN ('CDC_K8s_Flow','AI_K8s_Flow','Reset_K8s_Flow','Memory_Clear_Flow')
        OR id IN ('k8sCDCflow00001','k8sAIflow000001','k8sRSTflow00001','k8sMEMclear001');" \
    2>/dev/null || true
  # Clean up orphaned shared_workflow rows
  "${SQLITE3_BIN}" "${N8N_DB}" \
    "DELETE FROM shared_workflow WHERE workflowId NOT IN (SELECT id FROM workflow_entity);" \
    2>/dev/null || true
  ok "Existing workflow rows removed"
fi

# 10c. Ensure the Kafka credential exists in the n8n DB.
#      n8n uses OpenSSL-compatible AES-256-CBC (EVP_BytesToKey/MD5) encryption.
#      The encryption key is stored in data/n8n/config; it persists across DB recreations.
log "Ensuring Kafka credential exists in n8n DB …"
python3 - "${N8N_DB}" << 'PYEOF'
import hashlib, os, json, base64, sqlite3, sys
from datetime import datetime, timezone

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives import padding as _pad
    from cryptography.hazmat.backends import default_backend
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

DB_PATH = sys.argv[1]
if not os.path.exists(DB_PATH):
    print("DB not found — n8n will create it on first start; credential will be added after", file=sys.stderr)
    sys.exit(0)

if not HAS_CRYPTO:
    print("WARNING: 'cryptography' library not available — credential not created", file=sys.stderr)
    sys.exit(0)

SALTED = bytes.fromhex('53616c7465645f5f')  # "Salted__" — OpenSSL salt prefix

def get_key():
    cfg = os.path.join(os.path.dirname(DB_PATH), 'config')
    if os.path.exists(cfg):
        with open(cfg) as f:
            return json.load(f).get('encryptionKey', '')
    return ''

def n8n_encrypt(data, enc_key):
    """OpenSSL EVP_BytesToKey / AES-256-CBC — exactly as used by n8n-core Cipher."""
    salt = os.urandom(8)
    pwd  = enc_key.encode('latin-1') + salt
    h1 = hashlib.md5(pwd).digest()
    h2 = hashlib.md5(h1 + pwd).digest()
    iv = hashlib.md5(h2 + pwd).digest()
    k  = h1 + h2
    pt = json.dumps(data).encode('utf-8')
    padder = _pad.PKCS7(128).padder()
    padded = padder.update(pt) + padder.finalize()
    cipher = Cipher(algorithms.AES(k), modes.CBC(iv), backend=default_backend())
    enc = cipher.encryptor()
    ct = enc.update(padded) + enc.finalize()
    return base64.b64encode(SALTED + salt + ct).decode('utf-8')

enc_key = get_key()
if not enc_key:
    print("WARNING: encryption key not found in data/n8n/config — credential not created", file=sys.stderr)
    sys.exit(0)

conn = sqlite3.connect(DB_PATH)
cur  = conn.cursor()

cur.execute("SELECT id FROM credentials_entity WHERE name='Kafka Local'")
if cur.fetchone():
    print("Kafka Local credential already exists")
else:
    cur.execute("SELECT id FROM project LIMIT 1")
    row = cur.fetchone()
    project_id = row[0] if row else None

    encrypted = n8n_encrypt(
        {"clientId": "n8n-cdc-consumer", "brokers": "kafka:9092", "ssl": False},
        enc_key,
    )
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S.000')
    cur.execute(
        "INSERT INTO credentials_entity (id, name, data, type, createdAt, updatedAt) VALUES (?,?,?,?,?,?)",
        ('kafka-local', 'Kafka Local', encrypted, 'kafka', now, now),
    )
    if project_id:
        cur.execute(
            "INSERT INTO shared_credentials (credentialsId, projectId, role, createdAt, updatedAt) VALUES (?,?,?,?,?)",
            ('kafka-local', project_id, 'credential:owner', now, now),
        )
    conn.commit()
    print("Kafka Local credential created")

conn.close()
PYEOF
ok "Kafka credential ready"

# 10c-2. Ensure the Ollama + Qdrant credentials exist in the n8n DB.
log "Ensuring Ollama + Qdrant credentials exist in n8n DB …"
python3 - "${N8N_DB}" << 'PYEOF'
import hashlib, os, json, base64, sqlite3, sys
from datetime import datetime, timezone

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives import padding as _pad
    from cryptography.hazmat.backends import default_backend
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

DB_PATH = sys.argv[1]
if not os.path.exists(DB_PATH):
    print("DB not found — credentials will be added after n8n first start", file=sys.stderr)
    sys.exit(0)

if not HAS_CRYPTO:
    print("WARNING: 'cryptography' library not available — credentials not created", file=sys.stderr)
    sys.exit(0)

SALTED = bytes.fromhex('53616c7465645f5f')  # "Salted__"

def get_key():
    cfg = os.path.join(os.path.dirname(DB_PATH), 'config')
    if os.path.exists(cfg):
        with open(cfg) as f:
            return json.load(f).get('encryptionKey', '')
    return ''

def n8n_encrypt(data, enc_key):
    salt = os.urandom(8)
    pwd  = enc_key.encode('latin-1') + salt
    h1 = hashlib.md5(pwd).digest()
    h2 = hashlib.md5(h1 + pwd).digest()
    iv = hashlib.md5(h2 + pwd).digest()
    k  = h1 + h2
    pt = json.dumps(data).encode('utf-8')
    padder = _pad.PKCS7(128).padder()
    padded = padder.update(pt) + padder.finalize()
    cipher = Cipher(algorithms.AES(k), modes.CBC(iv), backend=default_backend())
    enc = cipher.encryptor()
    ct = enc.update(padded) + enc.finalize()
    return base64.b64encode(SALTED + salt + ct).decode('utf-8')

enc_key = get_key()
if not enc_key:
    print("WARNING: encryption key not found in data/n8n/config — credentials not created", file=sys.stderr)
    sys.exit(0)

conn = sqlite3.connect(DB_PATH)
cur  = conn.cursor()

cur.execute("SELECT id FROM project LIMIT 1")
row = cur.fetchone()
project_id = row[0] if row else None
now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S.000')

CREDENTIALS = [
    ('ollama-local', 'Ollama Local', 'ollamaApi',  {'baseUrl': 'http://host.docker.internal:11434'}),
    ('qdrant-local', 'Qdrant Local', 'qdrantApi',  {'qdrantUrl': 'http://qdrant:6333', 'apiKey': ''}),
    ('postgres-local', 'Postgres Local', 'postgres', {'host': 'postgres', 'database': 'n8n_memory', 'user': 'n8n', 'password': 'n8n_memory', 'port': 5432, 'ssl': 'disable'}),
]

for cred_id, cred_name, cred_type, cred_data in CREDENTIALS:
    cur.execute("SELECT id FROM credentials_entity WHERE id=? OR name=?", (cred_id, cred_name))
    if cur.fetchone():
        print(f"{cred_name} credential already exists")
        continue
    encrypted = n8n_encrypt(cred_data, enc_key)
    cur.execute(
        "INSERT INTO credentials_entity (id, name, data, type, createdAt, updatedAt) VALUES (?,?,?,?,?,?)",
        (cred_id, cred_name, encrypted, cred_type, now, now),
    )
    if project_id:
        cur.execute(
            "INSERT INTO shared_credentials (credentialsId, projectId, role, createdAt, updatedAt) VALUES (?,?,?,?,?)",
            (cred_id, project_id, 'credential:owner', now, now),
        )
    conn.commit()
    print(f"{cred_name} credential created")

conn.close()
PYEOF
ok "Ollama + Qdrant credentials ready"

# 10d. Start n8n (now with correct DB state)
log "Starting n8n …"
kubectl --context "${CONTEXT}" -n "${NAMESPACE}" scale deployment/n8n --replicas=1
wait_for_rollout deployment n8n 180

N8N_POD="$(get_n8n_pod)"
log "n8n pod: ${N8N_POD}"

# 10e. Copy workflow files and import (n8n must be running for CLI)
log "Copying workflow JSON files into pod …"
for wf in n8n_cdc_k8s_flow.json n8n_ai_k8s_flow.json n8n_reset_k8s_flow.json n8n_memory_clear_flow.json; do
  kubectl --context "${CONTEXT}" -n "${NAMESPACE}" \
    cp "${PROJECT_ROOT}/workflows/${wf}" "${N8N_POD}:/tmp/${wf}"
done
ok "Workflow files copied"

log "Importing workflows …"
n8n_exec n8n import:workflow --input=/tmp/n8n_cdc_k8s_flow.json
n8n_exec n8n import:workflow --input=/tmp/n8n_ai_k8s_flow.json
n8n_exec n8n import:workflow --input=/tmp/n8n_reset_k8s_flow.json
n8n_exec n8n import:workflow --input=/tmp/n8n_memory_clear_flow.json
ok "Workflows imported"

# 10f. Workflow IDs — these are the static IDs embedded in the workflow JSON files.
#      n8n import:workflow uses the 'id' field from the JSON (required since n8n 1.x).
CDC_ID="k8sCDCflow00001"
AI_ID="k8sAIflow000001"
RESET_ID="k8sRSTflow00001"
MEMORY_ID="k8sMEMclear001"

# Verify the IDs are actually present in the DB after import
log "Verifying imported workflow IDs …"
EXPORT_TMP="/tmp/k8s-ai-n8n-export-$$.json"
n8n_exec sh -c "n8n export:workflow --all --output=/tmp/n8n-all-workflows.json 2>/dev/null; true"
kubectl --context "${CONTEXT}" -n "${NAMESPACE}" \
  cp "${N8N_POD}:/tmp/n8n-all-workflows.json" "${EXPORT_TMP}" 2>/dev/null
python3 - "${EXPORT_TMP}" << 'PYEOF'
import json, sys
path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
    items = data if isinstance(data, list) else [data]
    for wf in items:
        print(f"  {wf.get('name','?')} → {wf.get('id','?')}")
except Exception as e:
    print(f"  (could not parse export: {e})", file=sys.stderr)
PYEOF
rm -f "${EXPORT_TMP}"

ok "CDC workflow ID:    ${CDC_ID}"
ok "AI workflow ID:     ${AI_ID}"
ok "Reset workflow ID:  ${RESET_ID}"
ok "Memory workflow ID: ${MEMORY_ID}"

# 10g. Publish (activate) all four workflows
log "Publishing (activating) all four workflows …"
n8n_exec n8n publish:workflow --id="${CDC_ID}"
n8n_exec n8n publish:workflow --id="${AI_ID}"
n8n_exec n8n publish:workflow --id="${RESET_ID}"
n8n_exec n8n publish:workflow --id="${MEMORY_ID}"
ok "All workflows published"

# 10h. Rollout restart so the published state takes effect
log "Rolling out n8n to activate published workflows …"
kubectl --context "${CONTEXT}" -n "${NAMESPACE}" rollout restart deployment/n8n
wait_for_rollout deployment n8n 120
ok "n8n restarted and Ready"

# 10i. Wait for CDC Kafka consumer group to become active before triggering resync.
#      The Kafka Trigger uses autoOffsetReset=latest — it only processes messages
#      published AFTER the consumer subscribes. Calling the reset webhook before
#      the consumer is active causes all resync messages to be missed, leaving
#      Qdrant empty. We poll the Kafka consumer-groups CLI until the group appears.
log "Waiting for CDC consumer group 'n8n-cdc-consumer' to become active …"
KAFKA_POD=$(kubectl --context "${CONTEXT}" -n "${NAMESPACE}" \
  get pod -l app=kafka -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
CONSUMER_ACTIVE=false
DEADLINE=$((SECONDS + 120))
while [[ ${SECONDS} -lt ${DEADLINE} ]]; do
  if kubectl --context "${CONTEXT}" -n "${NAMESPACE}" \
       exec "${KAFKA_POD}" -- \
       kafka-consumer-groups --bootstrap-server localhost:9092 \
       --describe --group n8n-cdc-consumer 2>/dev/null \
     | grep -q "n8n-cdc-consumer"; then
    CONSUMER_ACTIVE=true
    break
  fi
  echo -n "."
  sleep 5
done
echo
if [[ "${CONSUMER_ACTIVE}" == "true" ]]; then
  ok "CDC consumer group active"
  # Brief extra buffer so all partition assignments stabilise
  sleep 5
else
  warn "CDC consumer group did not appear within 120s — resync may not populate Qdrant"
fi

# ── step 11: wait for qdrant repopulation ────────────────────────────────────
step "Waiting for Qdrant to be populated by k8s-watcher"

# Trigger the reset/resync to publish all existing cluster resources to Kafka.
# The CDC workflow (autoOffsetReset=latest) only processes NEW messages, so it
# won't replay historical Kafka messages on restart.
log "Triggering /webhook/k8s-reset to seed Qdrant …"
RESET_ATTEMPTS=0
RESET_RESP=""
while [[ ${RESET_ATTEMPTS} -lt 5 ]]; do
  RESET_HTTP=$(curl -s -o /tmp/reset_resp_$$.json -w "%{http_code}" \
    -X POST "http://localhost:30000/webhook/k8s-reset" \
    -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo "000")
  RESET_RESP=$(cat /tmp/reset_resp_$$.json 2>/dev/null || echo '{}')
  rm -f /tmp/reset_resp_$$.json
  if [[ "${RESET_HTTP}" == "200" ]]; then
    ok "Reset webhook responded HTTP 200"
    break
  fi
  RESET_ATTEMPTS=$((RESET_ATTEMPTS + 1))
  warn "Reset webhook returned HTTP ${RESET_HTTP} (attempt ${RESET_ATTEMPTS}/5) — retrying in 10s …"
  sleep 10
done
if [[ "${RESET_HTTP}" != "200" ]]; then
  warn "Reset webhook still not returning 200 — workflows may not be active"
  warn "Run /reimport-workflows to recover"
fi
echo "${RESET_RESP}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  status:', d.get('status','?'), '| reset_at:', d.get('reset_at','?')[:19])" 2>/dev/null || true

log "Polling Qdrant points_count (target ≥ 10, timeout 120s) …"
DEADLINE=$((SECONDS + 120))
POINTS=0
while [[ ${SECONDS} -lt ${DEADLINE} ]]; do
  POINTS=$(qdrant_points)
  if [[ "${POINTS}" -ge 10 ]]; then
    break
  fi
  echo -n "  points=${POINTS} … "
  sleep 5
done

if [[ "${POINTS}" -ge 10 ]]; then
  ok "Qdrant populated: ${POINTS} points"
else
  warn "Qdrant has only ${POINTS} points after 120s"
  warn "k8s-watcher may still be indexing. Check:"
  warn "  kubectl -n k8s-ai logs deployment/k8s-watcher --tail 30"
fi

# ── step 12: smoke-test endpoints ────────────────────────────────────────────
step "Smoke-testing endpoints"

check_endpoint() {
  local label="$1" url="$2" expected_http="${3:-200}"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "${url}" 2>/dev/null || echo "000")
  if [[ "${code}" == "${expected_http}" ]]; then
    ok "  ${label}: HTTP ${code}"
  else
    warn "  ${label}: HTTP ${code} (expected ${expected_http}) — ${url}"
  fi
}

check_endpoint "n8n healthz"         "http://localhost:30000/healthz"
check_endpoint "Qdrant healthz"      "http://localhost:30001/healthz"
check_endpoint "k8s-watcher healthz" "http://localhost:30002/healthz"
check_endpoint "pgAdmin"             "http://localhost:30003/misc/ping"

CHAT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "http://localhost:30000/webhook/k8s-ai-chat/chat" \
  -H "Content-Type: application/json" \
  -d '{"chatInput":"ping"}' 2>/dev/null || echo "000")
if [[ "${CHAT_CODE}" == "200" ]]; then
  ok "  AI chat webhook POST: HTTP 200 ✓"
else
  warn "  AI chat webhook POST: HTTP ${CHAT_CODE} — workflows may not be active yet"
fi
# Note: reset webhook is NOT called here — calling it clears Qdrant.
# It is exercised by E2E test 5 instead.

# ── step 13: e2e tests ───────────────────────────────────────────────────────
if [[ "${RUN_TESTS}" == "true" ]]; then
  step "Running E2E test suite"
  log "Ensuring Qdrant has ≥ 10 points before tests …"
  POINTS=$(qdrant_points)
  if [[ "${POINTS}" -lt 10 ]]; then
    warn "Only ${POINTS} points — triggering reset and polling …"
    curl -s -X POST "http://localhost:30000/webhook/k8s-reset" \
      -H "Content-Type: application/json" -d '{}' >/dev/null 2>&1 || true
    PRE_TEST_DEADLINE=$((SECONDS + 90))
    while [[ ${SECONDS} -lt ${PRE_TEST_DEADLINE} ]]; do
      POINTS=$(qdrant_points)
      [[ "${POINTS}" -ge 10 ]] && break
      echo -n "  points=${POINTS} … "
      sleep 5
    done
    echo
    POINTS=$(qdrant_points)
  fi
  log "Qdrant points: ${POINTS}"
  npm test --prefix "${PROJECT_ROOT}"
  ok "E2E tests complete"
else
  log "Skipping E2E tests (--no-test)"
fi

# ── done ─────────────────────────────────────────────────────────────────────
echo
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}  Setup complete!${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
echo -e "  n8n dashboard      : ${CYAN}http://localhost:30000${NC}"
echo -e "  n8n (domain)       : ${CYAN}http://n8n.genai.prod:30000${NC}  ← requires /etc/hosts"
echo -e "  AI chat            : ${CYAN}http://localhost:30000/webhook/k8s-ai-chat/chat${NC}"
echo -e "  Qdrant             : ${CYAN}http://localhost:30001${NC}"
echo -e "  k8s-watcher health : ${CYAN}http://localhost:30002/healthz${NC}"
echo -e "  pgAdmin            : ${CYAN}http://localhost:30003${NC}  (admin@example.com / admin)"
echo -e "  Postgres (direct)  : ${CYAN}psql -h localhost -p 30004 -U n8n -d n8n_memory${NC}"
echo
echo -e "  Workflow IDs (save these):"
echo -e "    CDC    = ${BOLD}${CDC_ID}${NC}"
echo -e "    AI     = ${BOLD}${AI_ID}${NC}"
echo -e "    Reset  = ${BOLD}${RESET_ID}${NC}"
echo -e "    Memory = ${BOLD}${MEMORY_ID}${NC}"
echo
if ! grep -q "n8n.genai.prod" /etc/hosts 2>/dev/null; then
  echo -e "  ${YELLOW}⚠ /etc/hosts: add the following line for domain access:${NC}"
  echo -e "    ${BOLD}192.168.1.154 n8n.genai.prod${NC}"
  echo -e "    (run: sudo sh -c 'echo \"192.168.1.154 n8n.genai.prod\" >> /etc/hosts')"
  echo
fi
echo -e "  Run tests any time: ${BOLD}npm test${NC}"
echo -e "  Clean everything:   ${BOLD}./scripts/cleanup.sh${NC}"
echo
