Run a full health check of the Kubernetes AI Knowledge System and report the current state of every component.

**Important:** If any pods are not Running, apply the manifests and wait 30 seconds before proceeding. Do not report checks as failed simply because pods were stopped — start them, then check.

**Step 0 — Ensure pods are up:**
```bash
kubectl --context kind-k8s-ai -n k8s-ai get pods
```
If any pod is not in "Running" state, run:
```bash
kubectl --context kind-k8s-ai apply -f infra/k8s/
# then wait 30 seconds for startup
```
Then re-check `kubectl -n k8s-ai get pods` to confirm all pods are Running before continuing.

**Step 1 — Run all checks in parallel:**

1. **Qdrant** — `curl -s http://localhost:30001/collections/k8s` — extract `points_count` and `status`
2. **Kafka offset** — get kafka pod name then exec:
   ```bash
   KAFKA_POD=$(kubectl --context kind-k8s-ai -n k8s-ai get pod -l app=kafka -o jsonpath='{.items[0].metadata.name}')
   kubectl --context kind-k8s-ai -n k8s-ai exec ${KAFKA_POD} -- kafka-get-offsets --bootstrap-server localhost:9092 --topic k8s-resources
   ```
3. **k8s-watcher health** — `curl -s http://localhost:30002/healthz` — verify `{"status":"ok"}`
4. **Ollama models** — `curl -s http://localhost:11434/api/tags` — confirm `nomic-embed-text` and `qwen3:8b` are present
5. **kind cluster** — `kubectl --context kind-k8s-ai get nodes` — verify cluster is reachable
6. **n8n workflows (active check)** — Test the webhook endpoints directly, as `n8n list:workflow` does not expose the active flag:
   - `curl -s -o /dev/null -w "%{http_code}" http://localhost:30000/webhook/k8s-ai-chat/chat` → 200 means AI workflow is active
   - `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:30000/webhook/k8s-reset -H 'Content-Type: application/json' -d '{}'` → 200 means Reset workflow is active
   - CDC workflow active status is confirmed indirectly: if Kafka offset is advancing and Qdrant points_count > 0, CDC is processing

**Step 2 — Display Status Summary:**

| Component | Status | Detail |
|-----------|--------|--------|
| k8s pods (4) | ✅ / ❌ | list any that are not Running |
| Qdrant | ✅ / ❌ | points_count, collection status |
| Kafka | ✅ / ❌ | topic offset |
| k8s-watcher | ✅ / ❌ | /healthz response |
| Ollama | ✅ / ❌ | models present |
| kind cluster | ✅ / ❌ | node status |
| n8n workflows | ✅ / ❌ | AI webhook HTTP code / Reset webhook HTTP code |
| AI chat | ✅ / ❌ | HTTP 200 + returns output field |
| Reset endpoint | ✅ / ❌ | HTTP 200 + returns status/reset_at |

**Step 3 — Auto-remediation hints for known failures:**

- **Pods not Running** → `kubectl --context kind-k8s-ai apply -f infra/k8s/` (already done in Step 0)
- **Qdrant collection missing** → `curl -X PUT http://localhost:30001/collections/k8s -H 'Content-Type: application/json' -d @infra/schemas/qdrant_k8s_collection_schema.json`
- **Qdrant points_count = 0** → `curl -X POST http://localhost:30000/webhook/k8s-reset` then wait 45s
- **Workflow endpoints return 404** → run `/reimport-workflows`
- **kind cluster unreachable** → `kind create cluster --config infra/kind-config.yaml`
- **Ollama models missing** → `ollama pull nomic-embed-text && ollama pull qwen3:8b`
- **k8s-watcher image not found** → `docker build -t k8s-watcher:latest ./k8s-watcher/ && kind load docker-image k8s-watcher:latest --name k8s-ai`
