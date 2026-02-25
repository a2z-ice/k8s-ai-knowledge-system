Reimport and reactivate all three n8n workflows from the local JSON files. Use this after editing workflow JSON files or after a fresh n8n pod.

**Steps (run sequentially):**

1. Get the n8n pod name:
   ```bash
   N8N_POD=$(kubectl --context kind-k8s-ai-classic -n k8s-ai get pod -l app=n8n -o jsonpath='{.items[0].metadata.name}')
   echo "n8n pod: ${N8N_POD}"
   ```

2. Copy all workflow JSON files into the n8n pod:
   ```bash
   kubectl --context kind-k8s-ai-classic -n k8s-ai cp workflows/n8n_cdc_k8s_flow.json   ${N8N_POD}:/tmp/
   kubectl --context kind-k8s-ai-classic -n k8s-ai cp workflows/n8n_ai_k8s_flow.json    ${N8N_POD}:/tmp/
   kubectl --context kind-k8s-ai-classic -n k8s-ai cp workflows/n8n_reset_k8s_flow.json ${N8N_POD}:/tmp/
   ```

3. Import each workflow:
   ```bash
   kubectl --context kind-k8s-ai-classic -n k8s-ai exec ${N8N_POD} -- n8n import:workflow --input=/tmp/n8n_cdc_k8s_flow.json
   kubectl --context kind-k8s-ai-classic -n k8s-ai exec ${N8N_POD} -- n8n import:workflow --input=/tmp/n8n_ai_k8s_flow.json
   kubectl --context kind-k8s-ai-classic -n k8s-ai exec ${N8N_POD} -- n8n import:workflow --input=/tmp/n8n_reset_k8s_flow.json
   ```

4. Get the current workflow IDs (import may assign new IDs):
   ```bash
   kubectl --context kind-k8s-ai-classic -n k8s-ai exec ${N8N_POD} -- n8n list:workflow
   ```

5. Publish (activate) using the IDs from step 4. If IDs match the known values, use:
   ```bash
   kubectl --context kind-k8s-ai-classic -n k8s-ai exec ${N8N_POD} -- n8n publish:workflow --id=sLFyTfSNzFIiVC9t
   kubectl --context kind-k8s-ai-classic -n k8s-ai exec ${N8N_POD} -- n8n publish:workflow --id=5cf0evFgopkFXM7q
   kubectl --context kind-k8s-ai-classic -n k8s-ai exec ${N8N_POD} -- n8n publish:workflow --id=JItVx5wVu0WTIvkA
   ```
   If the IDs have changed (fresh DB), use the new IDs shown by `list:workflow` and update CLAUDE.md accordingly.

6. Restart n8n for webhook registration to take effect:
   ```bash
   kubectl --context kind-k8s-ai-classic -n k8s-ai rollout restart deployment/n8n
   kubectl --context kind-k8s-ai-classic -n k8s-ai rollout status deployment/n8n --timeout=60s
   ```

7. Wait 15 seconds, then verify the webhooks are registered:
   ```bash
   curl -s -o /dev/null -w "AI chat: %{http_code}\n" http://localhost:31000/webhook/k8s-ai-chat/chat
   curl -s -o /dev/null -w "Reset:   %{http_code}\n" -X POST http://localhost:31000/webhook/k8s-reset -H 'Content-Type: application/json' -d '{}'
   ```
   Both should return 200.

> **Note:** The n8n 2.6.4 body-parser bug means `N8N_BASIC_AUTH_ACTIVE=true` blocks all POST /rest/* calls. Always use the `n8n publish:workflow` CLI — never the REST API or browser toggle for activation.
