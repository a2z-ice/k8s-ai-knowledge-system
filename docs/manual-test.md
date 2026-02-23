# Manual Test Guide — Kubernetes AI Knowledge System

**Version:** 1.3
**Date:** 2026-02-22
**Environment:** macOS · Docker Desktop · kind v0.24+ · n8n 2.6.4

Complete step-by-step verification of the Kubernetes AI Knowledge System — from infrastructure health through to live CDC event observation and AI query validation in the n8n browser UI. Every command and browser step has been verified against the live running environment.

> **Generate screenshots first:** Run `npm run screenshots` from the project root once before following this guide. This auto-captures all UI screenshots referenced throughout.

---

## Table of Contents

1. [Credentials & Endpoints](#1-credentials--endpoints)
2. [Prerequisites Checklist](#2-prerequisites-checklist)
3. [Section A — Infrastructure Health](#section-a--infrastructure-health)
4. [Section B — Kafka & CDC Pipeline (Terminal)](#section-b--kafka--cdc-pipeline-terminal)
5. [Section C — n8n Sign-In (UI)](#section-c--n8n-sign-in-ui)
6. [Section D — Workflow Dashboard & Active Status (UI)](#section-d--workflow-dashboard--active-status-ui)
7. [Section E — CDC Workflow Canvas (UI)](#section-e--cdc-workflow-canvas-ui)
8. [Section F — Trigger CDC and Watch Execution (UI)](#section-f--trigger-cdc-and-watch-execution-ui)
9. [Section G — AI Workflow Canvas (UI)](#section-g--ai-workflow-canvas-ui)
10. [Section H — AI Chat Interface (UI, no login required)](#section-h--ai-chat-interface-ui-no-login-required)
11. [Section I — AI Pipeline Verification (Terminal)](#section-i--ai-pipeline-verification-terminal)
12. [Section J — Automated E2E Test Suite](#section-j--automated-e2e-test-suite)
13. [Section K — Persistence Verification](#section-k--persistence-verification)
14. [Section L — Reset REST Endpoint](#section-l--reset-rest-endpoint)
15. [Pass Criteria Summary](#pass-criteria-summary)
16. [Troubleshooting](#troubleshooting)

---

## 1. Credentials & Endpoints

| Service | URL | Auth |
|---------|-----|------|
| n8n Sign-In | http://localhost:5678/signin | Email: *(owner email set at first run)* · Password: *(owner password set at first run)* |
| n8n Public Chat (no login) | http://localhost:5678/webhook/k8s-ai-chat/chat | None — publicly accessible |
| n8n Reset Webhook | http://localhost:5678/webhook/k8s-reset | None — POST only |
| k8s-watcher Health | http://localhost:8085/healthz | None |
| Qdrant REST API | http://localhost:6333 | None |
| Kafka | localhost:9092 | None |
| Ollama (host machine) | http://localhost:11434 | None |

---

## 2. Prerequisites Checklist

### 2.1 Docker Desktop Running

```bash
docker info --format '{{.ServerVersion}}'
```

Expected: a version string such as `27.x.x`. If blank, launch Docker Desktop and wait until it reaches the Running state.

### 2.2 kind Cluster Present

```bash
kind get clusters
```

Expected output:
```
k8s-ai
```

If absent, create it: `kind create cluster --name k8s-ai`

### 2.3 Ollama Models Available on Host

```bash
ollama list
```

Both of the following must be present:

| Model | Purpose |
|-------|---------|
| `nomic-embed-text:latest` | 768-dim text embeddings |
| `qwen3:8b` | Chat / reasoning LLM |

If either is missing: `ollama pull nomic-embed-text && ollama pull qwen3:8b`

### 2.4 All 5 Containers Running

```bash
docker compose -f docker-compose.yml ps
```

Expected — all 5 in `Up` state:

```
kind_vector_n8n-debezium-1      Up   0.0.0.0:8083->8083/tcp
kind_vector_n8n-k8s-watcher-1   Up
kind_vector_n8n-kafka-1         Up   0.0.0.0:9092->9092/tcp
kind_vector_n8n-n8n-1           Up   0.0.0.0:5678->5678/tcp
kind_vector_n8n-qdrant-1        Up   0.0.0.0:6333->6333/tcp
```

If any container is missing: `docker compose -f docker-compose.yml up -d` (wait 20 s for Kafka KRaft init).

---

## Section A — Infrastructure Health

### A1. Qdrant

```bash
curl -s http://localhost:6333/healthz
```

Expected: `healthz check passed`

```bash
curl -s http://localhost:6333/collections/k8s | python3 -m json.tool
```

Key fields to confirm:

| Field | Expected |
|-------|----------|
| `result.status` | `"green"` |
| `result.config.params.vectors.size` | `768` |
| `result.config.params.vectors.distance` | `"Cosine"` |
| `result.points_count` | `≥ 25` |

### A2. Ollama

```bash
curl -s http://localhost:11434/api/tags | python3 -c "
import sys, json
for m in json.load(sys.stdin).get('models', []):
    print(m['name'])
"
```

Expected: `nomic-embed-text:latest` and `qwen3:8b` both appear.

### A3. n8n

```bash
python3 -c "
import urllib.request
r = urllib.request.urlopen('http://localhost:5678/healthz')
print(r.status, r.read().decode())
"
```

Expected: `200 OK`

### A4. Kafka Broker

```bash
docker exec kind_vector_n8n-kafka-1 \
  kafka-broker-api-versions --bootstrap-server localhost:9092 2>/dev/null | head -2
```

Expected: a broker version line (non-empty output).

---

## Section B — Kafka & CDC Pipeline (Terminal)

### B1. Verify Kafka Topic

```bash
docker exec kind_vector_n8n-kafka-1 \
  kafka-topics --bootstrap-server localhost:9092 --list
```

Expected: `k8s-resources` appears in the list.

### B2. Check Message Count

```bash
docker exec kind_vector_n8n-kafka-1 \
  kafka-get-offsets --bootstrap-server localhost:9092 --topic k8s-resources
```

Expected: `k8s-resources:0:<N>` where N ≥ 35 (initial cluster snapshot published by k8s-watcher on startup).

### B3. Verify Kafka Consumer Group (n8n CDC listener)

```bash
docker exec kind_vector_n8n-kafka-1 \
  kafka-consumer-groups --bootstrap-server localhost:9092 --list
```

Expected: `n8n-cdc-consumer` is listed — confirming the CDC_K8s_Flow Kafka Trigger is actively listening.

### B4. Live CDC Event Test (Two Terminals)

**Terminal 1** — Watch for new Kafka messages:

```bash
docker exec kind_vector_n8n-kafka-1 \
  kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic k8s-resources \
  --from-beginning \
  --property print.timestamp=true 2>/dev/null | tail -f
```

**Terminal 2** — Create a test namespace:

```bash
kubectl --context kind-k8s-ai create namespace b-live-test
```

**Expected in Terminal 1** within 2–3 seconds — a JSON event appears containing:
```json
{"event_type": "ADDED", "kind": "Namespace", "name": "b-live-test", ...}
```

**Cleanup:**
```bash
kubectl --context kind-k8s-ai delete namespace b-live-test --ignore-not-found
```

---

## Section C — n8n Sign-In (UI)

Open your browser and navigate to:

```
http://localhost:5678/signin
```

The n8n sign-in page loads directly — no HTTP Basic Auth prompt is required to reach the sign-in page.

![n8n sign-in page with email and password fields](screenshots/01-signin-page.png)

Enter the owner account credentials:

| Field | Value |
|-------|-------|
| Email | *(the email you registered during n8n first-run setup)* |
| Password | *(the password you set during n8n first-run setup)* |

![Sign-in form with credentials entered](screenshots/02-signin-credentials-filled.png)

Click **Sign in** or press `Enter` on the password field. You are redirected to the workflow dashboard.

---

## Section D — Workflow Dashboard & Active Status (UI)

After signing in, the workflow list is displayed.

![n8n workflow dashboard showing both workflows](screenshots/03-workflow-dashboard.png)

**What to verify:**

Both workflows must show a green **Active** badge on the right side of their row.

![Close-up of active badges on both workflows](screenshots/04-workflow-list-active-badges.png)

| Workflow | Expected Status |
|----------|----------------|
| `CDC_K8s_Flow` | Active (green) |
| `AI_K8s_Flow` | Active (green) |

If either workflow shows as inactive, refer to the [Troubleshooting](#troubleshooting) section.

Verify active status from the terminal as well:

```bash
docker logs kind_vector_n8n-n8n-1 2>&1 | grep "Activated workflow"
```

Expected:
```
Activated workflow "CDC_K8s_Flow" (ID: sLFyTfSNzFIiVC9t)
Activated workflow "AI_K8s_Flow" (ID: 5cf0evFgopkFXM7q)
```

---

## Section E — CDC Workflow Canvas (UI)

Click on **CDC_K8s_Flow** in the workflow list to open the editor.

![CDC workflow canvas — 7-node pipeline](screenshots/05-cdc-workflow-canvas.png)

**Expected nodes on the canvas (left to right):**

| # | Node | Type | Role |
|---|------|------|------|
| 1 | Kafka Trigger | Kafka Trigger | Listens on topic `k8s-resources`, group `n8n-cdc-consumer` |
| 2 | Parse Message | Code | Parses Kafka JSON, builds natural-language `embed_text` |
| 3 | Delete Existing Vector | HTTP Request | Removes old Qdrant point by `resource_uid` (idempotent) |
| 4 | Is Delete Event? | If | Routes `DELETED` events to stop; all others continue |
| 5 | Generate Embedding | HTTP Request | Calls Ollama `nomic-embed-text` → 768-dim vector |
| 6 | Build Qdrant Point | Code | Assembles point payload with `resource_uid` as ID |
| 7 | Insert Vector | HTTP Request | `PUT /collections/k8s/points` — stores in Qdrant |

> The **Is Delete Event?** `true` branch (DELETED events) terminates after deletion — no re-insert. The `false` branch (ADDED/MODIFIED) continues to embedding and upsert.

### E1. Inspect the Kafka Trigger Node

Double-click the **Kafka Trigger** node. Confirm:

| Setting | Value |
|---------|-------|
| Topic | `k8s-resources` |
| Group ID | `n8n-cdc-consumer` |
| Credential | Kafka Local (kafka:9092) |
| Auto Offset Reset | `earliest` |

### E2. View CDC Execution History

Click **Executions** in the left sidebar, or navigate to:

```
http://localhost:5678/workflow/sLFyTfSNzFIiVC9t/executions
```

![CDC execution history — one row per Kafka message processed](screenshots/06-cdc-executions-list.png)

Each row represents one Kafka message processed end-to-end. Status should be green for all successful runs.

### E3. Inspect an Execution

Click any row to open the execution detail.

![CDC execution detail — data flowing through all nodes](screenshots/07-cdc-execution-detail.png)

**What to verify in the detail panel:**

| Node | Expected Output |
|------|----------------|
| Kafka Trigger | Raw JSON with `event_type`, `kind`, `name`, `namespace`, `resource_uid` |
| Parse Message | `embed_text` = `"Kubernetes {kind} named {name} in namespace {ns}. Labels: ..."` |
| Delete Existing Vector | `{"status": "acknowledged"}` |
| Is Delete Event? | Routes to `false` branch (for ADDED/MODIFIED events) |
| Generate Embedding | `{"embeddings": [[...768 floats...]]}` |
| Build Qdrant Point | `{"points": [{"id": "<uid>", "vector": [...], "payload": {...}}]}` |
| Insert Vector | `{"status": "acknowledged"}` |

---

## Section F — Trigger CDC and Watch Execution (UI)

This section performs a live end-to-end CDC cycle observable in the n8n execution list.

### F1. Keep the CDC Execution List Open

Navigate to:

```
http://localhost:5678/workflow/sLFyTfSNzFIiVC9t/executions
```

### F2. Create a Kubernetes Namespace

In a terminal:

```bash
kubectl --context kind-k8s-ai create namespace f-ui-cdc-test
```

### F3. Observe the New Execution (within 5 seconds)

Refresh the execution history page. A new row appears at the top for the `ADDED` event.

Click the new row. Verify the data flowing through each node:

1. **Kafka Trigger → Output:** `"event_type": "ADDED"`, `"kind": "Namespace"`, `"name": "f-ui-cdc-test"`
2. **Parse Message → Output:** `embed_text` contains `"Kubernetes Namespace named f-ui-cdc-test cluster-scoped"`
3. **Delete Existing Vector → Output:** acknowledged (removes any prior duplicate)
4. **Is Delete Event? → Output:** routes to `false` branch
5. **Generate Embedding → Output:** 768-element float array
6. **Insert Vector → Output:** `{"status": "acknowledged"}`

### F4. Confirm Point in Qdrant

```bash
# Get the namespace UID
UID=$(kubectl --context kind-k8s-ai get namespace f-ui-cdc-test -o jsonpath='{.metadata.uid}')

# Query Qdrant
python3 - << EOF
import urllib.request, json
req = urllib.request.Request(
    f'http://localhost:6333/collections/k8s/points/{UID}',
    headers={'Content-Type': 'application/json'}
)
with urllib.request.urlopen(req) as r:
    d = json.load(r)
    p = d['result']['payload']
    print(f"kind={p['kind']}  name={p['name']}  uid={p['resource_uid']}")
EOF
```

Expected: `kind=Namespace  name=f-ui-cdc-test  uid=<uuid>`

### F5. Delete Event Test

```bash
kubectl --context kind-k8s-ai delete namespace f-ui-cdc-test
```

Watch the execution list — a new row appears for the `DELETED` event. In the detail view, the **Is Delete Event?** node routes to the `true` branch and the pipeline ends without re-inserting (the Delete Existing Vector node already removed the point). The point is now absent from Qdrant.

---

## Section G — AI Workflow Canvas (UI)

Navigate back to the workflow list and click **AI_K8s_Flow**, or go directly to:

```
http://localhost:5678/workflow/5cf0evFgopkFXM7q
```

![AI workflow canvas — 6-node query pipeline](screenshots/08-ai-workflow-canvas.png)

**Expected nodes on the canvas (left to right):**

| # | Node | Role |
|---|------|------|
| 1 | Chat Trigger | Receives user query via public webhook `/webhook/k8s-ai-chat/chat` |
| 2 | Generate Embedding | Embeds query via Ollama `nomic-embed-text` (768-dim) |
| 3 | Qdrant Search | Vector similarity search, cosine ≥ 0.3, top 30 results |
| 4 | Build Prompt | Formats retrieved docs + spec snippets into LLM messages |
| 5 | LLM Chat | Calls Ollama `qwen3:8b`, temperature 0.1 |
| 6 | Format Response | Extracts `message.content` and returns as `output` |

### G1. Verify AI Workflow Active Status

The workflow header shows an **Active** indicator (green). Confirm in terminal:

```bash
docker logs kind_vector_n8n-n8n-1 2>&1 | grep "AI_K8s_Flow"
```

Expected: `Activated workflow "AI_K8s_Flow" (ID: 5cf0evFgopkFXM7q)`

---

## Section H — AI Chat Interface (UI, no login required)

The AI chat interface is publicly accessible without n8n authentication. Open a new browser tab (or use an incognito window) and navigate to:

```
http://localhost:5678/webhook/k8s-ai-chat/chat
```

![AI chat public interface — n8n-rendered chat widget](screenshots/09-ai-chat-public.png)

A chat widget renders with an input field at the bottom. This page does not require the n8n owner login — it is accessible to anyone who can reach port 5678.

### H1. Test Query 1 — Deployment List with Replica Counts

In the chat input field, type and press `Enter`:

```
Show me all deployments and their replica counts
```

![Chat query typed in the input field](screenshots/10-ai-chat-query-typed.png)

**Expected response** (within 15–30 seconds):

![AI chat response showing deployment table](screenshots/11-ai-chat-response.png)

A markdown table listing both deployments with their replica counts:

| Deployment Name | Namespace | Replica Count |
|-----------------|-----------|---------------|
| local-path-provisioner | local-path-storage | 1 |
| coredns | kube-system | 2 |

### H2. Test Query 2 — Namespace Listing

```
List all namespaces in the Kubernetes cluster
```

**Expected:** A markdown table with the 5 cluster namespaces: `default`, `kube-system`, `kube-public`, `kube-node-lease`, `local-path-storage`.

### H3. Test Query 3 — Pod Count by Namespace

```
How many pods are running in kube-system?
```

**Expected:** A table listing pods in `kube-system` — approximately 8 pods including `coredns`, `etcd-k8s-ai-control-plane`, `kube-apiserver-k8s-ai-control-plane`, `kube-controller-manager-k8s-ai-control-plane`, `kube-proxy`, `kube-scheduler-k8s-ai-control-plane`, and `kindnet`.

### H4. Test Query 4 — Hallucination Guard (Negative Test)

```
Is there a Redis deployment in the cluster?
```

**Expected:** The system must report that no Redis resources exist. An acceptable response:

> *"No indexed Kubernetes resources found in vector database that match Redis."*

The response must **not** describe any Redis deployment, service, or workload. If it does, the system is hallucinating and the RAG pipeline has a configuration issue.

### H5. Verify AI Execution in n8n (In-Browser)

After sending any query via the public chat, switch to the n8n UI and navigate to the AI execution list:

```
http://localhost:5678/workflow/5cf0evFgopkFXM7q/executions
```

![AI execution list showing chat queries processed](screenshots/12-ai-executions-list.png)

Each chat query generates one execution. Click the latest row to inspect the data flow — every node must show a green status indicator.

---

## Section I — AI Pipeline Verification (Terminal)

### I1. Full Three-Stage Pipeline Script

```bash
python3 - << 'EOF'
import urllib.request, json

QUERY  = "Show me all deployments and their replica counts"
OLLAMA = "http://localhost:11434"
QDRANT = "http://localhost:6333"

def post(url, data):
    req = urllib.request.Request(url, data=json.dumps(data).encode(),
                                  headers={"Content-Type": "application/json"}, method='POST')
    with urllib.request.urlopen(req) as r:
        return json.load(r)

print("Step 1: Embedding query...")
vector = post(f"{OLLAMA}/api/embed", {"model": "nomic-embed-text", "input": QUERY})['embeddings'][0]
print(f"  -> {len(vector)}-dim vector")

print("Step 2: Qdrant search (threshold 0.3)...")
results = post(f"{QDRANT}/collections/k8s/points/search",
               {"vector": vector, "limit": 30, "with_payload": True, "score_threshold": 0.3})['result']
deployments = [r for r in results if r['payload'].get('kind') == 'Deployment']
print(f"  -> {len(results)} total results, {len(deployments)} Deployment(s)")
for d in deployments:
    spec = json.loads(d['payload'].get('raw_spec_json', '{}'))
    print(f"     {d['payload']['name']} — replicas={spec.get('replicas', '?')}  score={d['score']:.3f}")

print("Step 3: LLM response...")
system = "You are an expert Kubernetes AI assistant. Answer ONLY from the retrieved context. Use markdown tables."
ctx = "\n".join(
    f"[{i+1}] kind={r['payload'].get('kind')}  name={r['payload'].get('name')}  "
    f"ns={r['payload'].get('namespace') or '(cluster)'}  "
    f"spec={r['payload'].get('raw_spec_json','{}')[:200]}"
    for i, r in enumerate(results)
)
resp = post(f"{OLLAMA}/api/chat", {
    "model": "qwen3:8b",
    "messages": [{"role": "system", "content": system},
                 {"role": "user", "content": f"Retrieved resources:\n\n{ctx}\n\nQuestion: {QUERY}"}],
    "stream": False, "think": False, "options": {"temperature": 0.1}
})
print("\n--- LLM Response ---")
print(resp['message']['content'])
EOF
```

**Expected:** Step 2 must show 2 Deployment entries. The LLM response must be a markdown table listing `coredns` (2 replicas) and `local-path-provisioner` (1 replica).

---

## Section J — Automated E2E Test Suite

### J1. Install Dependencies

```bash
npm install
```

### J2. Run the Full Suite

```bash
npm test
```

Expected output:

```
Running 4 tests using 1 worker

  ✓  1 [api] › CDC: create namespace → Kafka event published + Qdrant insertion (2.4s)
  ✓  2 [api] › CDC: update deployment → old vector replaced (dedup by resource_uid) (1.9s)
  ✓  3 [api] › CDC: delete resource → point removed from Qdrant vector store (26ms)
  ✓  4 [api] › AI: namespace count query → structured markdown table response (2.3s)

  4 passed (7.1s)
```

All 4 tests must pass. Total runtime is typically under 15 seconds.

### J3. Run a Single Test

```bash
npm run test:single "create namespace"
npm run test:single "namespace count"
```

---

## Section K — Persistence Verification

### K1. Record Baseline

```bash
python3 -c "
import urllib.request, json
r = urllib.request.urlopen('http://localhost:6333/collections/k8s')
d = json.load(r)
print('Qdrant points:', d['result']['points_count'])
"

docker exec kind_vector_n8n-kafka-1 \
  kafka-get-offsets --bootstrap-server localhost:9092 --topic k8s-resources
```

### K2. Destroy and Recreate All Containers

```bash
docker compose -f docker-compose.yml down
docker compose -f docker-compose.yml up -d
```

Wait 20 seconds.

### K3. Confirm Data Persisted

```bash
# Qdrant — point count unchanged
python3 -c "
import urllib.request, json
r = urllib.request.urlopen('http://localhost:6333/collections/k8s')
d = json.load(r)
print('Qdrant points:', d['result']['points_count'])
"

# Kafka — offset unchanged
docker exec kind_vector_n8n-kafka-1 \
  kafka-get-offsets --bootstrap-server localhost:9092 --topic k8s-resources

# n8n — both workflows reactivate on startup
docker logs kind_vector_n8n-n8n-1 2>&1 | grep "Activated workflow"
```

Expected:
- Qdrant: same point count
- Kafka: same offset
- n8n logs:
  ```
  Activated workflow "CDC_K8s_Flow" (ID: sLFyTfSNzFIiVC9t)
  Activated workflow "AI_K8s_Flow" (ID: 5cf0evFgopkFXM7q)
  Activated workflow "Reset_K8s_Flow" (ID: JItVx5wVu0WTIvkA)
  ```

---

## Section L — Reset REST Endpoint

The Reset REST endpoint provides a single HTTP call that wipes the entire Qdrant vector database and triggers a full resync from the live Kubernetes cluster via k8s-watcher.

> **Screenshot:** `docs/screenshots/15-reset-workflow-canvas.png`

### L1. Verify k8s-watcher health endpoint

```bash
curl -s http://localhost:8085/healthz
```

Expected:
```json
{"status":"ok"}
```

### L2. Check the current Qdrant point count (before reset)

```bash
python3 -c "
import urllib.request, json
d = json.load(urllib.request.urlopen('http://localhost:6333/collections/k8s'))
print('Points before reset:', d['result']['points_count'])
"
```

Expected: ≥ 25 points.

### L3. Trigger the reset via the REST endpoint

```bash
curl -s -X POST http://localhost:5678/webhook/k8s-reset \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Expected response (within ~5 s):
```json
{
  "status": "ok",
  "message": "Qdrant collection cleared and k8s-watcher resync triggered. Vector database will repopulate within ~30 seconds.",
  "reset_at": "2026-02-23T04:53:31.845Z"
}
```

### L4. Verify Qdrant is empty immediately after reset

```bash
python3 -c "
import urllib.request, json
d = json.load(urllib.request.urlopen('http://localhost:6333/collections/k8s'))
print('Points immediately after reset:', d['result']['points_count'])
print('Status:', d['result']['status'])
"
```

Expected: `Points immediately after reset: 0`

### L5. Wait for CDC resync to repopulate Qdrant (~30–60 seconds)

```bash
python3 - << 'EOF'
import urllib.request, json, time

print("Waiting for Qdrant to repopulate...")
for i in range(20):
    time.sleep(5)
    d = json.load(urllib.request.urlopen('http://localhost:6333/collections/k8s'))
    count = d['result']['points_count']
    print(f"  t+{(i+1)*5}s: {count} points")
    if count >= 10:
        print(f"\nRepopulated! {count} resources indexed.")
        break
EOF
```

Expected: ≥ 25 points after 30–60 seconds (varies by cluster size).

### L6. Verify Reset Workflow execution in n8n UI

1. Navigate to **http://localhost:5678** and sign in.
2. Click **Workflows** in the left sidebar.
3. Confirm **Reset_K8s_Flow** is shown with a green **Active** badge.
4. Click **Reset_K8s_Flow** to open the canvas.

> **Screenshot:** `docs/screenshots/15-reset-workflow-canvas.png`

5. Click **Executions** (top right of the editor or left sidebar).
6. Confirm the most recent execution shows status **Success**.

> **Screenshot:** `docs/screenshots/16-reset-workflow-executions.png`

### L7. Verify Qdrant is fully repopulated

After waiting ~60 s from the reset, run the same AI query as Section H1:

```bash
curl -s -X POST http://localhost:5678/webhook/k8s-ai-chat/chat \
  -H 'Content-Type: application/json' \
  -d '{"chatInput": "Show me all deployments and their replica counts"}'
```

Expected: JSON response with a markdown table listing your Kubernetes deployments — same result as before the reset.

---

## Pass Criteria Summary

| # | Check | Command / Action | Expected |
|---|-------|-----------------|----------|
| 1 | All 5 containers running | `docker compose -f docker-compose.yml ps` | All `Up` |
| 2 | Qdrant green, ≥ 25 points | `curl localhost:6333/collections/k8s` | `status: green` |
| 3 | Ollama models present | `ollama list` | `nomic-embed-text`, `qwen3:8b` |
| 4 | CDC workflow active | n8n logs / dashboard | Green badge |
| 5 | AI workflow active | n8n logs / dashboard | Green badge |
| 6 | Kafka CDC consumer registered | `kafka-consumer-groups --list` | `n8n-cdc-consumer` |
| 7 | Live Kafka event on namespace create | Section B4 | JSON in consumer within 3 s |
| 8 | CDC execution visible in n8n | Section F3 | New green row in execution list |
| 9 | CDC data in Qdrant | Section F4 | Point found by resource UID |
| 10 | Deployment query returns table | Section H1 / I1 | 2-row table with replica counts |
| 11 | Namespace query returns table | Section H2 | 5-row table |
| 12 | Hallucination guard passes | Section H4 | No Redis resources described |
| 13 | AI execution appears in n8n | Section H5 | New row per chat query |
| 14 | k8s-watcher healthz responds | `curl localhost:8085/healthz` | `{"status":"ok"}` |
| 15 | Reset clears Qdrant | Section L3–L4 | 0 points immediately after reset |
| 16 | CDC resync repopulates | Section L5 | ≥ 25 points after ~60 s |
| 17 | Reset workflow active in n8n | Section L6 | Green badge + success execution |
| 18 | Automated suite passes | `npm test` | `5 passed` |
| 19 | Data survives container wipe | Section K | Point count and offset unchanged |

---

## Troubleshooting

### Workflows show as inactive after restart

Reactivate via CLI (the n8n 2.6.4 body-parser bug prevents REST API activation when basic auth is enabled):

```bash
docker exec kind_vector_n8n-n8n-1 n8n publish:workflow --id=sLFyTfSNzFIiVC9t
docker exec kind_vector_n8n-n8n-1 n8n publish:workflow --id=5cf0evFgopkFXM7q
docker exec kind_vector_n8n-n8n-1 n8n publish:workflow --id=JItVx5wVu0WTIvkA
docker restart kind_vector_n8n-n8n-1
```

### Qdrant returns 0 results

Restart k8s-watcher to re-publish the initial cluster snapshot:

```bash
docker restart kind_vector_n8n-k8s-watcher-1
```

Wait 15 s for the initial batch of ADDED events to be published and processed by the CDC flow.

### Public chat returns 404 or blank page

Confirm the AI workflow is active and its webhook is registered:

```bash
python3 -c "
import urllib.request
r = urllib.request.urlopen('http://localhost:5678/webhook/k8s-ai-chat/chat')
print('Status:', r.status, '— chat UI accessible')
"
```

If 404: re-import and republish the AI workflow:

```bash
docker cp workflows/n8n_ai_k8s_flow.json kind_vector_n8n-n8n-1:/tmp/
docker exec kind_vector_n8n-n8n-1 n8n import:workflow --input=/tmp/n8n_ai_k8s_flow.json
docker exec kind_vector_n8n-n8n-1 n8n publish:workflow --id=5cf0evFgopkFXM7q
docker restart kind_vector_n8n-n8n-1
```

### AI chat returns "No indexed Kubernetes resources found"

The Qdrant collection may be empty or the threshold too high. Verify directly:

```bash
python3 - << 'EOF'
import urllib.request, json

vector = json.load(urllib.request.urlopen(
    urllib.request.Request("http://localhost:11434/api/embed",
        data=json.dumps({"model":"nomic-embed-text","input":"deployments"}).encode(),
        headers={"Content-Type":"application/json"}, method="POST")
))['embeddings'][0]

results = json.load(urllib.request.urlopen(
    urllib.request.Request("http://localhost:6333/collections/k8s/points/search",
        data=json.dumps({"vector":vector,"limit":5,"with_payload":True,"score_threshold":0.3}).encode(),
        headers={"Content-Type":"application/json"}, method="POST")
))['result']

print(f"Results: {len(results)}")
for r in results:
    print(f"  score={r['score']:.3f}  kind={r['payload'].get('kind')}  name={r['payload'].get('name')}")
EOF
```

### kind cluster API server port has changed

The port changes if the cluster is recreated. Update `docker-compose.yml`:

```bash
# Find new port
kubectl --context kind-k8s-ai cluster-info | grep "control plane"
# Update K8S_SERVER in docker-compose.yml then:
docker compose -f docker-compose.yml up -d k8s-watcher
```

### LLM returns empty response

Confirm Ollama is running on the host:

```bash
python3 -c "
import urllib.request, json
r = urllib.request.urlopen('http://localhost:11434/api/tags')
models = [m['name'] for m in json.load(r)['models']]
print('Models:', models)
"
```

If Ollama is not running: `ollama serve &`
