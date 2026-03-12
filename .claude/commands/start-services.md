Start all Kubernetes services for the Kubernetes AI Knowledge System and verify they are healthy.

**Steps:**

1. Apply all manifests (namespace, PVs, then workloads):
   ```bash
   kubectl --context kind-k8s-ai apply -f infra/k8s/00-namespace.yaml
   kubectl --context kind-k8s-ai apply -f infra/k8s/01-pvs.yaml
   kubectl --context kind-k8s-ai apply -f infra/k8s/kafka/
   kubectl --context kind-k8s-ai apply -f infra/k8s/qdrant/
   kubectl --context kind-k8s-ai apply -f infra/k8s/k8s-watcher/
   kubectl --context kind-k8s-ai apply -f infra/k8s/n8n/
   ```

2. Wait 30 seconds for services to initialize, then check pod status:
   ```bash
   kubectl --context kind-k8s-ai -n k8s-ai get pods
   ```
   Expected: all 6 pods (kafka-0, qdrant-*, k8s-watcher-*, n8n-*, postgres-*, pgadmin-*) in Running state.

3. Verify each critical service:

   **Qdrant:**
   ```bash
   curl -s http://localhost:30001/collections/k8s
   ```
   Expected: `{"result":{"status":"green",...}}` — if collection doesn't exist yet, create it:
   ```bash
   curl -X PUT http://localhost:30001/collections/k8s \
     -H 'Content-Type: application/json' \
     -d @infra/schemas/qdrant_k8s_collection_schema.json
   ```

   **k8s-watcher:**
   ```bash
   curl -s http://localhost:30002/healthz
   ```
   Expected: `{"status":"ok"}`

   **n8n:**
   ```bash
   curl -s http://localhost:30000/healthz
   ```
   Expected: `{"status":"ok"}`

   **Kafka:**
   ```bash
   KAFKA_POD=$(kubectl --context kind-k8s-ai -n k8s-ai get pod -l app=kafka -o jsonpath='{.items[0].metadata.name}')
   kubectl --context kind-k8s-ai -n k8s-ai exec ${KAFKA_POD} -- kafka-get-offsets \
     --bootstrap-server localhost:9092 --topic k8s-resources
   ```

   **Postgres:**
   ```bash
   psql -h localhost -p 30004 -U n8n -d n8n_memory -c "SELECT 1" 2>/dev/null || echo "Postgres not reachable via NodePort"
   ```

   **pgAdmin:**
   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://localhost:30003
   ```
   Expected: 200

4. Verify kind cluster is reachable:
   ```bash
   kubectl --context kind-k8s-ai get nodes
   ```
   If the cluster doesn't exist: `kind create cluster --config infra/kind-config.yaml`

5. If k8s-watcher image is missing from the cluster:
   ```bash
   docker build -t k8s-watcher:latest ./k8s-watcher/
   kind load docker-image k8s-watcher:latest --name k8s-ai
   kubectl --context kind-k8s-ai -n k8s-ai rollout restart deployment/k8s-watcher
   ```

6. Verify Ollama models are available on the host:
   ```bash
   ollama list
   ```
   Required: `nomic-embed-text` and `qwen3:14b-k8s`. If missing:
   ```bash
   ollama pull nomic-embed-text
   ollama pull qwen3:14b-k8s
   ```
   If `qwen3:14b-k8s` is not built yet:
   ```bash
   ollama pull qwen3:14b
   ollama create qwen3:14b-k8s -f models/Modelfile.k8s
   ```

7. Check that n8n workflows are active (webhook-based check — `n8n list:workflow` does not show active flag):
   ```bash
   curl -s -o /dev/null -w "AI chat: %{http_code}\n" http://localhost:30000/webhook/k8s-ai-chat/chat
   curl -s -o /dev/null -w "Reset:   %{http_code}\n" -X POST http://localhost:30000/webhook/k8s-reset -H 'Content-Type: application/json' -d '{}'
   ```
   All 4 workflows (CDC_K8s_Flow, AI_K8s_Flow, Reset_K8s_Flow, Memory_Clear_Flow) should be present.
   If webhooks return 404, run `/reimport-workflows`.

8. If Qdrant has 0 points, trigger initial sync:
   ```bash
   curl -X POST http://localhost:30000/webhook/k8s-reset -H 'Content-Type: application/json' -d '{}'
   ```
   Wait 45 seconds, then verify: `curl -s http://localhost:30001/collections/k8s`

Report the final state of all services.
