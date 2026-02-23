Start all Docker Compose services for the Kubernetes AI Knowledge System and verify they are healthy.

**Steps:**

1. Start all services:
   ```bash
   docker compose -f docker-compose.yml up -d
   ```

2. Wait 10 seconds for services to initialize, then check status:
   ```bash
   docker compose -f docker-compose.yml ps
   ```

3. Verify each critical service:

   **Qdrant:**
   ```bash
   curl -s http://localhost:6333/collections/k8s
   ```
   Expected: `{"result":{"status":"green",...}}` — if collection doesn't exist yet, create it:
   ```bash
   curl -X PUT http://localhost:6333/collections/k8s \
     -H 'Content-Type: application/json' \
     -d @infra/schemas/qdrant_k8s_collection_schema.json
   ```

   **k8s-watcher:**
   ```bash
   curl -s http://localhost:8085/healthz
   ```
   Expected: `{"status":"ok"}`

   **n8n:**
   ```bash
   curl -s http://localhost:5678/healthz
   ```
   Expected: `{"status":"ok"}`

   **Kafka:**
   ```bash
   docker exec kind_vector_n8n-kafka-1 kafka-get-offsets \
     --bootstrap-server localhost:9092 --topic k8s-resources
   ```

4. Verify kind cluster is reachable:
   ```bash
   kubectl --context kind-k8s-ai get nodes
   ```
   If the cluster doesn't exist: `kind create cluster --name k8s-ai`

5. Verify Ollama models are available on the host:
   ```bash
   ollama list
   ```
   Required: `nomic-embed-text` and `qwen3:8b`. If missing:
   ```bash
   ollama pull nomic-embed-text
   ollama pull qwen3:8b
   ```

6. Check that n8n workflows are active:
   ```bash
   docker exec kind_vector_n8n-n8n-1 n8n list:workflow
   ```
   All three workflows (CDC_K8s_Flow, AI_K8s_Flow, Reset_K8s_Flow) should show as active.
   If not, run `/reimport-workflows`.

7. If Qdrant has 0 points, trigger initial sync:
   ```bash
   docker restart kind_vector_n8n-k8s-watcher-1
   ```
   Or use the reset endpoint: `curl -X POST http://localhost:5678/webhook/k8s-reset`

Report the final state of all services.
