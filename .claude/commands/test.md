Run the full E2E test suite for the Kubernetes AI Knowledge System and report results.

**Important:** Always verify prerequisites before running tests. A common failure mode is that pods are not running. Fix the environment first, then run tests.

**Step 1 — Ensure pods are running:**
```bash
kubectl --context kind-k8s-ai-classic -n k8s-classic-ai get pods
```
If any pod is not in "Running" state:
```bash
kubectl --context kind-k8s-ai-classic apply -f infra/k8s/
# wait 30 seconds for services to initialize
```

**Step 2 — Verify prerequisites:**
```bash
# Qdrant: must have ≥ 10 points before AI test will pass
curl -s http://localhost:31001/collections/k8s | python3 -c "import sys,json; d=json.load(sys.stdin); print('Qdrant:', d['result']['points_count'], 'points,', d['result']['status'])"

# Ollama: both models must be present
curl -s http://localhost:11434/api/tags | python3 -c "import sys,json; models=[m['name'] for m in json.load(sys.stdin)['models']]; print('Ollama:', models)"

# kind cluster must be reachable
kubectl --context kind-k8s-ai-classic get nodes --no-headers
```

If Qdrant has 0 points, trigger a resync and wait for repopulation before running tests:
```bash
curl -s -X POST http://localhost:31000/webhook/k8s-reset -H 'Content-Type: application/json' -d '{}'
# wait 45 seconds, then verify:
curl -s http://localhost:31001/collections/k8s | python3 -c "import sys,json; d=json.load(sys.stdin); print('points:', d['result']['points_count'])"
```

**Step 3 — Run all 8 tests:**
```bash
npm test
```
Expected: `8 passed` in under 120 s.

**Step 4 — If any test fails, diagnose:**

- **Test 1 (AI namespace count)** → check Ollama is responding (`curl -s http://localhost:11434/api/tags`) and Qdrant has ≥ 10 points. qwen3:8b cold-load on CPU can take > 5 minutes — test has 10-minute timeout.
- **Test 2 (AI secrets query)** → check Qdrant has ≥ 10 points with Secret resources
- **Test 3 (CDC create namespace)** → check k8s-watcher logs: `kubectl --context kind-k8s-ai-classic -n k8s-classic-ai logs deployment/k8s-watcher --tail 30`
- **Test 4 (CDC update deployment)** → check Kafka offset is advancing:
  ```bash
  KAFKA_POD=$(kubectl --context kind-k8s-ai-classic -n k8s-classic-ai get pod -l app=kafka -o jsonpath='{.items[0].metadata.name}')
  kubectl --context kind-k8s-ai-classic -n k8s-classic-ai exec ${KAFKA_POD} -- kafka-get-offsets --bootstrap-server localhost:9092 --topic k8s-resources
  ```
- **Test 5 (CDC delete)** → check Qdrant API reachable: `curl -s http://localhost:31001/healthz`
- **Test 6 (CDC Secret)** → check k8s-watcher is watching Secrets (check watcher logs)
- **Test 7 (Reset: POST)** → check reset webhook returns 200; if 404, run `/reimport-workflows`; check n8n logs: `kubectl -n k8s-classic-ai logs deployment/n8n --tail 50`
- **Test 8 (Reset: Manual Trigger)** → check `POST /rest/login` returns 200 (n8n auth); check workflow is active at `http://localhost:31000/workflow/k8sRSTflow00001`; verify execution `mode=manual` via `GET /rest/executions/{id}`

**Step 5 — Run a single test by name:**
```bash
npm run test:single "create namespace"
npm run test:single "update deployment"
npm run test:single "delete resource"
npm run test:single "namespace count query"
npm run test:single "Reset: POST"
npm run test:single "Reset: Manual"
```

Report the pass/fail count and total duration.
