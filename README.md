# k8s-ai-knowledge-system

A self-hosted Kubernetes AI Knowledge System that continuously indexes a live `kind` cluster into a Qdrant vector database via Change Data Capture (CDC), and exposes a natural-language query interface through n8n and Ollama — entirely local, no cloud APIs required.

## Architecture

```
kind cluster (K8s API)
  └─ k8s-watcher (Python)      watches 9 resource types
       └─ Kafka (k8s-resources) CDC event stream
            └─ n8n CDC Flow     embed → delete-by-uid → insert into Qdrant

User query (browser / curl)
  └─ n8n AI Flow               embed query → Qdrant search → Ollama LLM → response

POST /webhook/k8s-reset
  └─ n8n Reset Flow            DROP + RECREATE Qdrant collection → trigger full resync
```

**Stack:** kind · n8n · Qdrant · Kafka (KRaft) · Ollama · Docker Compose · Playwright

---

## Quick Start

### Prerequisites

| Tool | Version |
|------|---------|
| Docker Desktop | 4.x+ |
| kind | 0.24+ |
| kubectl | any |
| Ollama | any (runs on host, not in Docker) |
| Node.js | 18+ (for tests and screenshots) |

### 1. Create kind cluster

```bash
kind create cluster --name k8s-ai
```

### 2. Pull Ollama models (host machine)

```bash
ollama pull nomic-embed-text   # 768-dim embedding model
ollama pull qwen3:8b           # chat / reasoning model
```

### 3. Start all Docker services

```bash
docker compose -f docker-compose.yml up -d
```

Services started: `n8n`, `qdrant`, `kafka`, `debezium`, `k8s-watcher`

> **Note:** Update `K8S_SERVER` in `docker-compose.yml` to match your kind cluster API port:
> ```bash
> kubectl --context kind-k8s-ai cluster-info | grep "control plane"
> ```

### 4. Create the Qdrant collection

```bash
curl -X PUT http://localhost:6333/collections/k8s \
  -H 'Content-Type: application/json' \
  -d @infra/schemas/qdrant_k8s_collection_schema.json
```

### 5. Import and activate n8n workflows

Complete the n8n first-run owner setup at http://localhost:5678, then:

```bash
docker cp workflows/n8n_cdc_k8s_flow.json   kind_vector_n8n-n8n-1:/tmp/
docker cp workflows/n8n_ai_k8s_flow.json    kind_vector_n8n-n8n-1:/tmp/
docker cp workflows/n8n_reset_k8s_flow.json kind_vector_n8n-n8n-1:/tmp/
docker exec kind_vector_n8n-n8n-1 n8n import:workflow --input=/tmp/n8n_cdc_k8s_flow.json
docker exec kind_vector_n8n-n8n-1 n8n import:workflow --input=/tmp/n8n_ai_k8s_flow.json
docker exec kind_vector_n8n-n8n-1 n8n import:workflow --input=/tmp/n8n_reset_k8s_flow.json
```

Get the assigned IDs, then activate:

```bash
docker exec kind_vector_n8n-n8n-1 n8n list:workflow
docker exec kind_vector_n8n-n8n-1 n8n publish:workflow --id=<CDC_ID>
docker exec kind_vector_n8n-n8n-1 n8n publish:workflow --id=<AI_ID>
docker exec kind_vector_n8n-n8n-1 n8n publish:workflow --id=<RESET_ID>
docker restart kind_vector_n8n-n8n-1
```

> **Known n8n 2.6.4 bug:** `N8N_BASIC_AUTH_ACTIVE=true` blocks all `POST /rest/*` calls. Always activate workflows via the CLI (`n8n publish:workflow`), not the browser UI toggle or REST API.

---

## Usage

### AI Chat (public, no login required)

Open: **http://localhost:5678/webhook/k8s-ai-chat/chat**

Or via curl:
```bash
curl -X POST http://localhost:5678/webhook/k8s-ai-chat/chat \
  -H 'Content-Type: application/json' \
  -d '{"chatInput": "Show me all deployments and their replica counts"}'
```

### Reset & Resync Vector Database

```bash
curl -X POST http://localhost:5678/webhook/k8s-reset
# Qdrant repopulates in ~30–60 s
```

### k8s-watcher Health Check

```bash
curl http://localhost:8085/healthz
```

---

## n8n Workflows

| Workflow | ID | Purpose |
|----------|----|---------|
| CDC_K8s_Flow | *(assigned at import)* | Kafka → embed → Qdrant upsert |
| AI_K8s_Flow | *(assigned at import)* | Chat → embed → Qdrant search → LLM |
| Reset_K8s_Flow | *(assigned at import)* | Clear Qdrant + trigger k8s-watcher resync |

---

## Running Tests

Install dependencies first:
```bash
npm install
npx playwright install chromium
```

Run all 5 E2E tests (API mode — no browser required):
```bash
npm test
```

Run a single test:
```bash
npm run test:single "create namespace"
```

Capture UI screenshots:
```bash
N8N_EMAIL=you@example.com N8N_PASS=yourpassword npm run screenshots
```

---

## Project Structure

```
├── docker-compose.yml               # 5 Docker services
├── CLAUDE.md                        # AI assistant guidance
│
├── workflows/                       # n8n workflow JSON files
├── k8s-watcher/                     # Python K8s API watcher → Kafka
├── infra/schemas/                   # Qdrant collection schema
├── infra/connectors/                # Debezium connector (legacy reference)
├── prompts/                         # LLM system prompt
├── scripts/                         # Screenshot capture + n8n setup
├── tests/e2e/                       # Playwright E2E test suite
└── docs/
    ├── manual-test.md               # Step-by-step manual test guide
    ├── screenshots/                 # Auto-generated UI screenshots
    ├── plans/                       # Implementation plans
    └── specs/                       # Original specification docs
```

---

## Key Design Decisions

- **k8s-watcher over Debezium** — watches the K8s API directly. The Debezium etcd connector approach is incorrect (etcd is not MongoDB).
- **Qdrant score threshold 0.3** — `nomic-embed-text` on short k8s metadata produces scores in 0.38–0.70. The threshold of 0.3 ensures all resource types are returned; higher values silently exclude Deployments (~0.43).
- **Natural-language embed text** — `"Kubernetes Deployment named coredns in namespace kube-system. Labels: ..."` gives significantly better cosine similarity than terse `kind:X name:Y` format.
- **Kafka KRaft mode** — no ZooKeeper dependency.
- **Ollama on host** — never inside Docker. All containers reach it via `host.docker.internal:11434`.

---

## Slash Commands (Claude Code)

When using [Claude Code](https://claude.ai/code) in this repo, these project-specific commands are available:

| Command | Purpose |
|---------|---------|
| `/resume` | Session-start brief — system health + what's built + next steps |
| `/status` | Full health check across all 9 components |
| `/start-services` | Start Docker Compose + verify all components |
| `/reset-db` | Wipe Qdrant + trigger CDC resync |
| `/reimport-workflows` | Reimport + reactivate all 3 n8n workflows |
| `/test` | Run all 5 E2E tests with diagnostic output |
| `/screenshots` | Capture all UI screenshots |
