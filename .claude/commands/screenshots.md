Capture all UI screenshots for the Kubernetes AI Knowledge System documentation.

**Steps:**

1. Verify n8n is running and healthy:
   ```bash
   curl -s http://localhost:5678/healthz
   ```

2. Run the screenshot capture script:
   ```bash
   npm run screenshots
   ```
   This script:
   - Temporarily disables N8N_BASIC_AUTH_ACTIVE via docker-compose.override.yml
   - Restarts n8n without basic auth
   - Launches headless Chromium (1440×900)
   - Navigates through all UI pages: sign-in, dashboard, CDC canvas, CDC executions, AI canvas, public chat, reset canvas, settings
   - Saves 17 screenshots to docs/screenshots/
   - Restores basic auth and restarts n8n

3. List the captured screenshots:
   ```bash
   ls docs/screenshots/*.png
   ```

4. Report which screenshots were saved and flag any that are missing (expected files):
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

If any screenshots are missing, check `docker logs kind_vector_n8n-n8n-1 --tail 20` and `docker logs kind_vector_n8n-k8s-watcher-1 --tail 10` for issues.
