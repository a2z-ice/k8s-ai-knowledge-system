Run the full E2E test suite for the Kubernetes AI Knowledge System and report results.

**Important:** Always verify prerequisites before running tests. A common failure mode is that Docker containers stopped between sessions. Fix the environment first, then run tests.

**Step 1 — Ensure Docker services are up:**
```bash
docker compose -f docker-compose.yml ps
```
If any container is not in "Up" state:
```bash
docker compose -f docker-compose.yml up -d
# wait 20 seconds for services to initialize
```

**Step 2 — Verify prerequisites:**
```bash
# Qdrant: must have ≥ 10 points before AI test will pass
curl -s http://localhost:6333/collections/k8s | python3 -c "import sys,json; d=json.load(sys.stdin); print('Qdrant:', d['result']['points_count'], 'points,', d['result']['status'])"

# Ollama: both models must be present
curl -s http://localhost:11434/api/tags | python3 -c "import sys,json; models=[m['name'] for m in json.load(sys.stdin)['models']]; print('Ollama:', models)"

# kind cluster must be reachable
kubectl --context kind-k8s-ai get nodes --no-headers
```

If Qdrant has 0 points, trigger a resync and wait for repopulation before running tests:
```bash
curl -s -X POST http://localhost:5678/webhook/k8s-reset -H 'Content-Type: application/json' -d '{}'
# wait 45 seconds, then verify:
curl -s http://localhost:6333/collections/k8s | python3 -c "import sys,json; d=json.load(sys.stdin); print('points:', d['result']['points_count'])"
```

**Step 3 — Run all 5 tests:**
```bash
npm test
```
Expected: `5 passed` in under 120 s.

**Step 4 — If any test fails, diagnose:**

- **Test 1 (CDC create namespace)** → check k8s-watcher logs: `docker logs kind_vector_n8n-k8s-watcher-1 --tail 30`
- **Test 2 (CDC update deployment)** → check Kafka offset is advancing: run `kafka-get-offsets` command
- **Test 3 (CDC delete)** → check Qdrant API reachable: `curl -s http://localhost:6333/healthz`
- **Test 4 (AI query)** → check Ollama is responding and Qdrant has ≥ 10 points
- **Test 5 (Reset)** → check reset webhook returns 200; if 404, run `/reimport-workflows`

**Step 5 — Run a single test by name:**
```bash
npm run test:single "create namespace"
npm run test:single "update deployment"
npm run test:single "delete resource"
npm run test:single "namespace count query"
npm run test:single "Reset: POST"
```

Report the pass/fail count and total duration.
