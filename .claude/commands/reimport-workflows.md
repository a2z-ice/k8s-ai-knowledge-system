Reimport and reactivate all three n8n workflows from the local JSON files. Use this after editing workflow JSON files or after a fresh n8n container.

**Steps (run sequentially):**

1. Copy all workflow JSON files into the n8n container:
   ```bash
   docker cp workflows/n8n_cdc_k8s_flow.json   kind_vector_n8n-n8n-1:/tmp/
   docker cp workflows/n8n_ai_k8s_flow.json    kind_vector_n8n-n8n-1:/tmp/
   docker cp workflows/n8n_reset_k8s_flow.json kind_vector_n8n-n8n-1:/tmp/
   ```

2. Import each workflow:
   ```bash
   docker exec kind_vector_n8n-n8n-1 n8n import:workflow --input=/tmp/n8n_cdc_k8s_flow.json
   docker exec kind_vector_n8n-n8n-1 n8n import:workflow --input=/tmp/n8n_ai_k8s_flow.json
   docker exec kind_vector_n8n-n8n-1 n8n import:workflow --input=/tmp/n8n_reset_k8s_flow.json
   ```

3. Get the current workflow IDs (import may assign new IDs):
   ```bash
   docker exec kind_vector_n8n-n8n-1 n8n list:workflow
   ```

4. Publish (activate) using the IDs from step 3. If IDs match the known values, use:
   ```bash
   docker exec kind_vector_n8n-n8n-1 n8n publish:workflow --id=sLFyTfSNzFIiVC9t
   docker exec kind_vector_n8n-n8n-1 n8n publish:workflow --id=5cf0evFgopkFXM7q
   docker exec kind_vector_n8n-n8n-1 n8n publish:workflow --id=JItVx5wVu0WTIvkA
   ```
   If the IDs have changed (fresh container), use the new IDs shown by `list:workflow` and update CLAUDE.md accordingly.

5. Restart n8n for webhook registration to take effect:
   ```bash
   docker restart kind_vector_n8n-n8n-1
   ```

6. Wait 15 seconds, then verify all three workflows are active:
   ```bash
   docker exec kind_vector_n8n-n8n-1 n8n list:workflow
   ```

7. Verify the webhooks are registered:
   ```bash
   curl -s -o /dev/null -w "AI chat: %{http_code}\n" http://localhost:5678/webhook/k8s-ai-chat/chat
   curl -s -o /dev/null -w "Reset:   %{http_code}\n" -X POST http://localhost:5678/webhook/k8s-reset -H 'Content-Type: application/json' -d '{}'
   ```
   Both should return 200.

> **Note:** The n8n 2.6.4 body-parser bug means `N8N_BASIC_AUTH_ACTIVE=true` blocks all POST /rest/* calls. Always use the `n8n publish:workflow` CLI — never the REST API or browser toggle for activation.
