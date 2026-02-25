# k8s-ai-knowledge-system

A self-hosted Kubernetes AI Knowledge System that continuously indexes a live `kind` cluster into a Qdrant vector database via Change Data Capture (CDC), and exposes a natural-language query interface through n8n and Ollama — entirely local, no cloud APIs required.

## Architecture

```
kind cluster (K8s API)
  └─ k8s-watcher (Python pod)   watches 9 resource types
       └─ Kafka (k8s-resources)  CDC event stream
            └─ n8n CDC Flow      embed → delete-by-uid → insert into Qdrant

User query (browser / curl)
  └─ n8n AI Flow                embed query → Qdrant search → Ollama LLM → response

POST /webhook/k8s-reset
  └─ n8n Reset Flow             DROP + RECREATE Qdrant collection → trigger full resync
```

**Stack:** kind · n8n · Qdrant · Kafka (KRaft) · Ollama · Kubernetes · Playwright

All services run as pods inside the `k8s-classic-ai` namespace of a local kind cluster.

---

## Quick Start

### Prerequisites

| Tool | Version |
|------|---------|
| Docker Desktop | 4.x+ |
| kind | 0.24+ |
| kubectl | any |
| Ollama | any (runs on host machine, not in a pod) |
| Node.js | 18+ (for tests and screenshots) |
| python3 | 3.8+ |

### 1. Pull Ollama models (host machine, one-time)

```bash
ollama pull nomic-embed-text   # 768-dim embedding model (~274 MB)
ollama pull qwen3:8b           # chat / reasoning model (~5.2 GB)
```

### 2. Run the setup script

```bash
./scripts/setup.sh
```

This single command handles everything end-to-end:

1. Verifies prerequisites
2. Creates the kind cluster (`k8s-ai-classic`) with `infra/kind-config.yaml` (NodePort mappings + data mounts)
3. Deploys all 4 pods: Kafka, Qdrant, k8s-watcher, n8n
4. Builds and loads the `k8s-watcher-classic:latest` image into kind
5. Creates the Qdrant `k8s` collection (768-dim Cosine)
6. Injects the Kafka credential into the n8n SQLite database
7. Imports and activates all 3 workflows
8. Triggers an initial resync and waits for Qdrant to populate (≥ 10 points)
9. Runs `npm test` — all 8 E2E tests must pass

Expected completion time: ~4 minutes on a fast machine.

```
━━━ Running E2E test suite ━━━
  ✓  1  AI: namespace count query → structured markdown table response          (10.7s)
  ✓  2  AI: secrets query → returns Secret metadata without exposing values     (1.1s)
  ✓  3  CDC: create namespace → Kafka event published + Qdrant insertion        (2.5s)
  ✓  4  CDC: update deployment → old vector replaced (dedup by resource_uid)    (1.9s)
  ✓  5  CDC: delete resource → point removed from Qdrant vector store           (31ms)
  ✓  6  CDC: create secret → Kafka event + Qdrant insertion (safe metadata only)(2.6s)
  ✓  7  Reset: POST /webhook/k8s-reset clears Qdrant and CDC resync repopulates (3.4s)
  ✓  8  Reset: Manual Trigger (REST API) → mode=manual, Qdrant repopulated      (4.3s)

  8 passed (27.0s)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Setup complete!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  n8n dashboard      : http://localhost:31000
  AI chat            : http://localhost:31000/webhook/k8s-ai-chat/chat
  Qdrant             : http://localhost:31001
  k8s-watcher health : http://localhost:31002/healthz

  Workflow IDs (static — embedded in JSON):
    CDC   = k8sCDCflow00001
    AI    = k8sAIflow000001
    Reset = k8sRSTflow00001
```

### Setup options

```bash
./scripts/setup.sh                      # full from-scratch setup
./scripts/setup.sh --keep-cluster       # reuse existing cluster; reimport workflows + run tests
./scripts/setup.sh --no-test            # skip the final npm test run
./scripts/cleanup.sh                    # delete cluster + watcher image (keeps ./data-classic/)
./scripts/cleanup.sh --wipe-data --yes  # full clean slate
```

---

## Usage

### AI Chat (public, no login required)

Open: **http://localhost:31000/webhook/k8s-ai-chat/chat**

Or via curl:
```bash
curl -X POST http://localhost:31000/webhook/k8s-ai-chat/chat \
  -H 'Content-Type: application/json' \
  -d '{"chatInput": "Show me all deployments and their replica counts"}'
```

### n8n Dashboard

**http://localhost:31000** — sign in with `assaduzzaman.ict@gmail.com` / `admin@123Normal`

### Reset & Resync Vector Database

Via webhook (external HTTP POST):
```bash
curl -X POST http://localhost:31000/webhook/k8s-reset \
  -H 'Content-Type: application/json' -d '{}'
# Qdrant repopulates in ~30–45 s
```

Via Manual Trigger node (n8n editor UI or REST API — same pipeline):
```bash
# Open http://localhost:31000/workflow/k8sRSTflow00001 and click "Execute Workflow"
# — or use the REST API directly (as done by Test 8):
curl -s -X POST http://localhost:31000/rest/login \
  -H 'Content-Type: application/json' -u admin:admin \
  -d '{"emailOrLdapLoginId":"assaduzzaman.ict@gmail.com","password":"admin@123Normal"}' -c /tmp/n8n-cookies.txt
curl -s http://localhost:31000/rest/workflows/k8sRSTflow00001 -u admin:admin -b /tmp/n8n-cookies.txt \
  | python3 -c "import sys,json; wf=json.load(sys.stdin)['data']; print(json.dumps(wf))" > /tmp/wf.json
curl -s -X POST http://localhost:31000/rest/workflows/k8sRSTflow00001/run -u admin:admin \
  -b /tmp/n8n-cookies.txt -H 'Content-Type: application/json' \
  -d "{\"workflowData\":$(cat /tmp/wf.json),\"startNodes\":[],\"triggerToStartFrom\":{\"name\":\"Manual Trigger\"}}"
```

### k8s-watcher Health Check

```bash
curl http://localhost:31002/healthz
# {"status":"ok"}
```

---

## n8n Workflows

| Workflow | ID | Purpose |
|----------|----|---------|
| classic_CDC_K8s_Flow | `k8sCDCflow00001` | Kafka → embed → Qdrant upsert |
| classic_AI_K8s_Flow | `k8sAIflow000001` | Chat → embed → Qdrant search → LLM |
| classic_Reset_K8s_Flow | `k8sRSTflow00001` | Clear Qdrant + trigger k8s-watcher resync |

Workflow IDs are **static** — embedded in the JSON files. n8n 1.x+ uses the `id` field from the JSON on import. The `setup.sh` script handles deduplication by deleting existing rows (by name and ID) before re-importing.

---

## Running Tests

```bash
npm test                                # all 8 E2E tests
npm run test:single "create namespace"  # single test by name
npm run test:single "Reset: Manual"     # Test 8 only
```

Capture UI screenshots:
```bash
N8N_EMAIL=assaduzzaman.ict@gmail.com N8N_PASS=admin@123Normal npm run screenshots
```

---

## Project Structure

```
├── scripts/
│   ├── setup.sh        # full bootstrap: cluster + pods + workflows + tests
│   └── cleanup.sh      # tear down cluster and images (optionally wipes ./data-classic/)
├── workflows/          # n8n workflow JSON files (with static id fields)
├── k8s-watcher/        # Python K8s API watcher → Kafka
├── infra/
│   ├── kind-config.yaml          # kind cluster config (NodePorts + data mounts)
│   ├── k8s/                      # Kubernetes manifests
│   └── schemas/                  # Qdrant collection schema
├── tests/e2e/          # Playwright E2E test suite (8 tests, API mode)
├── prompts/            # LLM system prompt
└── docs/
    ├── manual-test.md  # Step-by-step manual test guide
    ├── medium-article.md
    ├── screenshots/    # Auto-generated UI screenshots
    └── plans/          # Implementation plans
```

---

## Key Design Decisions

- **k8s-watcher over Debezium** — watches the K8s API directly (`config.load_incluster_config()`). The Debezium etcd connector approach is incorrect (etcd is not MongoDB).
- **Qdrant score threshold 0.3** — `nomic-embed-text` on k8s metadata produces scores in 0.38–0.70. Threshold 0.3 ensures all resource types are returned; higher values silently exclude Deployments (~0.43).
- **Natural-language embed text** — `"Kubernetes Deployment named coredns in namespace kube-system. Labels: ..."` gives significantly better cosine similarity than terse `kind:X name:Y` format.
- **Kafka KRaft mode** — no ZooKeeper dependency.
- **Ollama on host** — never inside a pod. Pods reach it via `host.docker.internal:11434` (mapped to `192.168.1.154` via `hostAliases`).
- **autoOffsetReset: latest** — CDC Kafka Trigger consumes only messages published after the workflow starts. `earliest` would replay the full topic history on every n8n restart, breaking the Reset E2E test.
- **n8n SQLite safety** — direct sqlite3 writes only when n8n is scaled to 0 replicas. Concurrent writes cause `SQLITE_CORRUPT`.

---

## Slash Commands (Claude Code)

When using [Claude Code](https://claude.ai/code) in this repo, these project-specific commands are available:

| Command | Purpose |
|---------|---------|
| `/resume` | Session-start brief — system health + what's built + next steps |
| `/status` | Full health check across all components |
| `/start-services` | Apply k8s manifests and verify all components are healthy |
| `/reset-db` | Wipe Qdrant + trigger CDC resync |
| `/reimport-workflows` | Reimport + reactivate all 3 n8n workflows |
| `/test` | Run all 8 E2E tests with diagnostic output |
| `/screenshots` | Capture all UI screenshots |
| `/remember` | Save current session state to persistent memory |
