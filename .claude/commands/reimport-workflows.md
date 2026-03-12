Reimport and reactivate all 4 n8n workflows from the local JSON files. Use this after editing workflow JSON files or after a fresh n8n pod.

**Important:** The recommended approach is `./scripts/setup.sh --keep-cluster --no-test` which handles deduplication, ID discovery, and activation automatically. The manual steps below are for when you need fine-grained control.

**Workflow files and static IDs:**
- `workflows/n8n_cdc_k8s_flow.json` → ID: `k8sCDCflow00001`
- `workflows/n8n_ai_k8s_flow.json` → ID: `k8sAIflow000001`
- `workflows/n8n_reset_k8s_flow.json` → ID: `k8sRSTflow00001`
- `workflows/n8n_memory_clear_flow.json` → ID: `k8sMEMclear001`

**Steps (run sequentially):**

1. Get the n8n pod name:
   ```bash
   N8N_POD=$(kubectl --context kind-k8s-ai -n k8s-ai get pod -l app=n8n -o jsonpath='{.items[0].metadata.name}')
   echo "n8n pod: ${N8N_POD}"
   ```

2. Scale n8n to 0 (required for safe sqlite3 operations):
   ```bash
   kubectl --context kind-k8s-ai -n k8s-ai scale deployment/n8n --replicas=0
   kubectl --context kind-k8s-ai -n k8s-ai wait --for=delete pod/${N8N_POD} --timeout=30s
   ```

3. Delete existing workflow rows by static ID (prevents duplicates on re-import):
   ```bash
   # This is handled automatically by setup.sh step 10b
   # If doing manually, exec into n8n pod's sqlite3 and delete by ID
   ```

4. Scale n8n back to 1 and get new pod name:
   ```bash
   kubectl --context kind-k8s-ai -n k8s-ai scale deployment/n8n --replicas=1
   kubectl --context kind-k8s-ai -n k8s-ai rollout status deployment/n8n --timeout=60s
   N8N_POD=$(kubectl --context kind-k8s-ai -n k8s-ai get pod -l app=n8n -o jsonpath='{.items[0].metadata.name}')
   ```

5. Copy all workflow JSON files into the n8n pod:
   ```bash
   kubectl --context kind-k8s-ai -n k8s-ai cp workflows/n8n_cdc_k8s_flow.json ${N8N_POD}:/tmp/
   kubectl --context kind-k8s-ai -n k8s-ai cp workflows/n8n_ai_k8s_flow.json ${N8N_POD}:/tmp/
   kubectl --context kind-k8s-ai -n k8s-ai cp workflows/n8n_reset_k8s_flow.json ${N8N_POD}:/tmp/
   kubectl --context kind-k8s-ai -n k8s-ai cp workflows/n8n_memory_clear_flow.json ${N8N_POD}:/tmp/
   ```

6. Import each workflow:
   ```bash
   kubectl --context kind-k8s-ai -n k8s-ai exec ${N8N_POD} -- n8n import:workflow --input=/tmp/n8n_cdc_k8s_flow.json
   kubectl --context kind-k8s-ai -n k8s-ai exec ${N8N_POD} -- n8n import:workflow --input=/tmp/n8n_ai_k8s_flow.json
   kubectl --context kind-k8s-ai -n k8s-ai exec ${N8N_POD} -- n8n import:workflow --input=/tmp/n8n_reset_k8s_flow.json
   kubectl --context kind-k8s-ai -n k8s-ai exec ${N8N_POD} -- n8n import:workflow --input=/tmp/n8n_memory_clear_flow.json
   ```

7. Verify workflows are imported:
   ```bash
   kubectl --context kind-k8s-ai -n k8s-ai exec ${N8N_POD} -- n8n list:workflow
   ```
   Expected: 4 workflows listed (CDC_K8s_Flow, AI_K8s_Flow, Reset_K8s_Flow, Memory_Clear_Flow).

8. Publish (activate) all workflows using static IDs:
   ```bash
   kubectl --context kind-k8s-ai -n k8s-ai exec ${N8N_POD} -- n8n publish:workflow --id=k8sCDCflow00001
   kubectl --context kind-k8s-ai -n k8s-ai exec ${N8N_POD} -- n8n publish:workflow --id=k8sAIflow000001
   kubectl --context kind-k8s-ai -n k8s-ai exec ${N8N_POD} -- n8n publish:workflow --id=k8sRSTflow00001
   kubectl --context kind-k8s-ai -n k8s-ai exec ${N8N_POD} -- n8n publish:workflow --id=k8sMEMclear001
   ```

9. Restart n8n for webhook registration to take effect:
   ```bash
   kubectl --context kind-k8s-ai -n k8s-ai rollout restart deployment/n8n
   kubectl --context kind-k8s-ai -n k8s-ai rollout status deployment/n8n --timeout=60s
   ```

10. Wait 15 seconds, then verify the webhooks are registered:
    ```bash
    curl -s -o /dev/null -w "AI chat: %{http_code}\n" http://localhost:30000/webhook/k8s-ai-chat/chat
    curl -s -o /dev/null -w "Reset:   %{http_code}\n" -X POST http://localhost:30000/webhook/k8s-reset -H 'Content-Type: application/json' -d '{}'
    ```
    Both should return 200.

> **Note:** `n8n import:workflow` always creates a new row with a fresh auto-ID unless a row with the same `id` already exists. The static IDs in the workflow JSON files ensure idempotent imports. If you see duplicate workflows, delete them via sqlite3 (with n8n at 0 replicas) and re-import.
