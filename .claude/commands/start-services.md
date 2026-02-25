Start all Kubernetes services for the Kubernetes AI Knowledge System and verify they are healthy.

**Steps:**

1. Apply all manifests (namespace, PVs, then workloads):
   ```bash
   kubectl --context kind-k8s-ai-classic apply -f infra/k8s/00-namespace.yaml
   kubectl --context kind-k8s-ai-classic apply -f infra/k8s/01-pvs.yaml
   kubectl --context kind-k8s-ai-classic apply -f infra/k8s/kafka/
   kubectl --context kind-k8s-ai-classic apply -f infra/k8s/qdrant/
   kubectl --context kind-k8s-ai-classic apply -f infra/k8s/k8s-watcher/
   kubectl --context kind-k8s-ai-classic apply -f infra/k8s/n8n/
   ```

2. Wait 30 seconds for services to initialize, then check pod status:
   ```bash
   kubectl --context kind-k8s-ai-classic -n k8s-classic-ai get pods
   ```
   Expected: all 4 pods (kafka-0, qdrant-*, k8s-watcher-*, n8n-*) in Running state.

3. Verify each critical service:

   **Qdrant:**
   ```bash
   curl -s http://localhost:31001/collections/k8s
   ```
   Expected: `{"result":{"status":"green",...}}` — if collection doesn't exist yet, create it:
   ```bash
   curl -X PUT http://localhost:31001/collections/k8s \
     -H 'Content-Type: application/json' \
     -d @infra/schemas/qdrant_k8s_collection_schema.json
   ```

   **k8s-watcher:**
   ```bash
   curl -s http://localhost:31002/healthz
   ```
   Expected: `{"status":"ok"}`

   **n8n:**
   ```bash
   curl -s http://localhost:31000/healthz
   ```
   Expected: `{"status":"ok"}`

   **Kafka:**
   ```bash
   KAFKA_POD=$(kubectl --context kind-k8s-ai-classic -n k8s-classic-ai get pod -l app=kafka -o jsonpath='{.items[0].metadata.name}')
   kubectl --context kind-k8s-ai-classic -n k8s-classic-ai exec ${KAFKA_POD} -- kafka-get-offsets \
     --bootstrap-server localhost:9092 --topic k8s-resources
   ```

4. Verify kind cluster is reachable:
   ```bash
   kubectl --context kind-k8s-ai-classic get nodes
   ```
   If the cluster doesn't exist: `kind create cluster --config infra/kind-config.yaml`

5. If k8s-watcher image is missing from the cluster:
   ```bash
   docker build -t k8s-watcher-classic:latest ./k8s-watcher/
   kind load docker-image k8s-watcher-classic:latest --name k8s-ai-classic
   kubectl --context kind-k8s-ai-classic -n k8s-classic-ai rollout restart deployment/k8s-watcher
   ```

6. Verify Ollama models are available on the host:
   ```bash
   ollama list
   ```
   Required: `nomic-embed-text` and `qwen3:8b`. If missing:
   ```bash
   ollama pull nomic-embed-text
   ollama pull qwen3:8b
   ```

7. Check that n8n workflows are active:
   ```bash
   N8N_POD=$(kubectl --context kind-k8s-ai-classic -n k8s-classic-ai get pod -l app=n8n -o jsonpath='{.items[0].metadata.name}')
   kubectl --context kind-k8s-ai-classic -n k8s-classic-ai exec ${N8N_POD} -- n8n list:workflow
   ```
   All three workflows (classic_CDC_K8s_Flow, classic_AI_K8s_Flow, classic_Reset_K8s_Flow) should be present.
   If webhooks return 404, run `/reimport-workflows`.

8. If Qdrant has 0 points, trigger initial sync:
   ```bash
   curl -X POST http://localhost:31000/webhook/k8s-reset -H 'Content-Type: application/json' -d '{}'
   ```
   Wait 45 seconds, then verify: `curl -s http://localhost:31001/collections/k8s`

Report the final state of all services.
