Run a full health check of the Kubernetes AI Knowledge System and report the current state of every component.

**Important:** If any Docker containers are not running, start them first with `docker compose -f docker-compose.yml up -d` and wait 20 seconds before proceeding with checks. Do not report checks as failed simply because containers were stopped — start them, then check.

**Step 0 — Ensure services are up:**
```bash
docker compose -f docker-compose.yml ps
```
If any container is not in "Up" state, run:
```bash
docker compose -f docker-compose.yml up -d
# then wait 20 seconds for startup
```
Then re-check `docker compose ps` to confirm all 5 are Up before continuing.

**Step 1 — Run all checks in parallel:**

1. **Qdrant** — `curl -s http://localhost:6333/collections/k8s` — extract `points_count` and `status`
2. **Kafka offset** — `docker exec kind_vector_n8n-kafka-1 kafka-get-offsets --bootstrap-server localhost:9092 --topic k8s-resources` — show latest offset
3. **k8s-watcher health** — `curl -s http://localhost:8085/healthz` — verify `{"status":"ok"}`
4. **Ollama models** — `curl -s http://localhost:11434/api/tags` — confirm `nomic-embed-text` and `qwen3:8b` are present
5. **kind cluster** — `kubectl --context kind-k8s-ai get nodes` — verify cluster is reachable
6. **n8n workflows (active check)** — Test the webhook endpoints directly, as `n8n list:workflow` does not expose the active flag:
   - `curl -s -o /dev/null -w "%{http_code}" http://localhost:5678/webhook/k8s-ai-chat/chat` → 200 means AI workflow is active
   - `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:5678/webhook/k8s-reset -H 'Content-Type: application/json' -d '{}'` → 200 means Reset workflow is active
   - CDC workflow active status is confirmed indirectly: if Kafka offset is advancing and Qdrant points_count > 0, CDC is processing

**Step 2 — Display Status Summary:**

| Component | Status | Detail |
|-----------|--------|--------|
| Docker (5 containers) | ✅ / ❌ | list any that are not Up |
| Qdrant | ✅ / ❌ | points_count, collection status |
| Kafka | ✅ / ❌ | topic offset |
| k8s-watcher | ✅ / ❌ | /healthz response |
| Ollama | ✅ / ❌ | models present |
| kind cluster | ✅ / ❌ | node status |
| n8n workflows | ✅ / ❌ | AI webhook HTTP code / Reset webhook HTTP code |
| AI chat | ✅ / ❌ | HTTP 200 + returns output field |
| Reset endpoint | ✅ / ❌ | HTTP 200 + returns status/reset_at |

**Step 3 — Auto-remediation hints for known failures:**

- **Containers not Up** → `docker compose -f docker-compose.yml up -d` (already done in Step 0)
- **Qdrant collection missing** → `curl -X PUT http://localhost:6333/collections/k8s -H 'Content-Type: application/json' -d @infra/schemas/qdrant_k8s_collection_schema.json`
- **Qdrant points_count = 0** → `curl -X POST http://localhost:5678/webhook/k8s-reset` then wait 45s
- **Workflow endpoints return 404** → run `/reimport-workflows`
- **kind cluster unreachable** → `kind create cluster --name k8s-ai` then update `K8S_SERVER` port in docker-compose.yml
- **Ollama models missing** → `ollama pull nomic-embed-text && ollama pull qwen3:8b`
