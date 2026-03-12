Capture all UI screenshots for the Kubernetes AI Knowledge System documentation.

**Steps:**

1. Verify n8n is running and healthy:
   ```bash
   curl -s http://localhost:30000/healthz
   ```

2. Verify all pods are running:
   ```bash
   kubectl --context kind-k8s-ai -n k8s-ai get pods
   ```
   Expected: 6 pods Running (kafka-0, qdrant, k8s-watcher, n8n, postgres, pgadmin).

3. Run the screenshot capture script:
   ```bash
   npm run screenshots
   ```
   This script:
   - Launches headless Chromium (1440×900)
   - Navigates through all UI pages: sign-in, dashboard, workflow canvases, executions, public chat, settings
   - Saves screenshots to docs/screenshots/

4. List the captured screenshots:
   ```bash
   ls docs/screenshots/*.png
   ```

5. Report which screenshots were saved and flag any that are missing (expected files):
   - 01-signin-page.png
   - 02-signin-credentials-filled.png
   - 03-workflow-dashboard.png
   - 04-workflow-list-active-badges.png
   - 05-cdc-workflow-canvas.png
   - 06-cdc-executions-list.png
   - 07-cdc-execution-detail.png
   - 08-ai-workflow-canvas.png
   - 09-ai-chat-public.png
   - 10-ai-chat-query-typed.png
   - 11-ai-chat-response.png
   - 12-ai-executions-list.png
   - 15-reset-workflow-canvas.png
   - 16-reset-workflow-executions.png
   - 17-settings-api.png

If any screenshots are missing, check n8n pod logs:
```bash
kubectl --context kind-k8s-ai -n k8s-ai logs deployment/n8n --tail 20
```
