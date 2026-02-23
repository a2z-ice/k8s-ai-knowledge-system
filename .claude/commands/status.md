Run a full health check of the Kubernetes AI Knowledge System and report the current state of every component. Execute the following checks in parallel where possible, then print a clean summary table.

**Checks to run:**

1. **Docker services** — `docker compose -f docker-compose.yml ps` — list all 5 containers and their status
2. **Qdrant** — `curl -s http://localhost:6333/collections/k8s` — extract `points_count` and `status`
3. **Kafka offset** — `docker exec kind_vector_n8n-kafka-1 kafka-get-offsets --bootstrap-server localhost:9092 --topic k8s-resources` — show latest offset
4. **k8s-watcher health** — `curl -s http://localhost:8085/healthz` — verify `{"status":"ok"}`
5. **Ollama models** — `curl -s http://localhost:11434/api/tags` — confirm `nomic-embed-text` and `qwen3:8b` are present
6. **kind cluster** — `kubectl --context kind-k8s-ai get nodes` — verify cluster is reachable
7. **n8n workflows** — `docker exec kind_vector_n8n-n8n-1 n8n list:workflow` — show all workflows and active status
8. **AI chat endpoint** — `curl -s -o /dev/null -w "%{http_code}" http://localhost:5678/webhook/k8s-ai-chat/chat` — should return 200
9. **Reset endpoint** — `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:5678/webhook/k8s-reset -H 'Content-Type: application/json' -d '{}'` — should return 200

After running all checks, display a **Status Summary** table:

| Component | Status | Detail |
|-----------|--------|--------|
| Docker (5 containers) | ✅ / ❌ | list any that are not Up |
| Qdrant | ✅ / ❌ | points_count, collection status |
| Kafka | ✅ / ❌ | topic offset |
| k8s-watcher | ✅ / ❌ | /healthz response |
| Ollama | ✅ / ❌ | models present |
| kind cluster | ✅ / ❌ | node status |
| n8n workflows | ✅ / ❌ | CDC / AI / Reset active |
| AI chat | ✅ / ❌ | HTTP status |
| Reset endpoint | ✅ / ❌ | HTTP status |

Flag any failures clearly with the exact error and the remediation command from CLAUDE.md or docs/manual-test.md Troubleshooting section.
