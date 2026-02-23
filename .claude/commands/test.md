Run the full E2E test suite for the Kubernetes AI Knowledge System and report results.

**Steps:**

1. First verify prerequisites are met (quick check):
   ```bash
   curl -s http://localhost:6333/collections/k8s | python3 -c "import sys,json; d=json.load(sys.stdin); print('Qdrant:', d['result']['points_count'], 'points,', d['result']['status'])"
   curl -s http://localhost:11434/api/tags | python3 -c "import sys,json; models=[m['name'] for m in json.load(sys.stdin)['models']]; print('Ollama:', models)"
   kubectl --context kind-k8s-ai get nodes --no-headers | awk '{print "kind:", $1, $2}'
   ```

2. Run all 5 tests:
   ```bash
   npm test
   ```

3. If any test fails, diagnose the failure:
   - **Test 1 (CDC create namespace)** fails → check k8s-watcher logs: `docker logs kind_vector_n8n-k8s-watcher-1 --tail 20`
   - **Test 2 (CDC update deployment)** fails → check Kafka topic has events: run the kafka-get-offsets command
   - **Test 3 (CDC delete)** fails → check Qdrant API is reachable
   - **Test 4 (AI query)** fails → check Ollama is running and models are loaded; check Qdrant has ≥ 5 points
   - **Test 5 (Reset)** fails → check reset webhook is active: `curl -X POST http://localhost:5678/webhook/k8s-reset`

4. To run a single test by name:
   ```bash
   npm run test:single "create namespace"
   npm run test:single "update deployment"
   npm run test:single "delete resource"
   npm run test:single "namespace count query"
   npm run test:single "Reset: POST"
   ```

5. Report the pass/fail count and total duration.

Expected result: `5 passed` in under 120 s.
