Reset the Qdrant vector database and trigger a full resync from the live Kubernetes cluster.

**Steps:**

1. First check the current Qdrant point count so you can report before/after:
   ```bash
   curl -s http://localhost:30001/collections/k8s
   ```

2. Call the reset webhook:
   ```bash
   curl -s -X POST http://localhost:30000/webhook/k8s-reset \
     -H 'Content-Type: application/json' \
     -d '{}'
   ```
   Expected response: `{"status":"ok","message":"...","reset_at":"<ISO8601>"}`

3. Immediately verify Qdrant is empty (should be 0 points):
   ```bash
   curl -s http://localhost:30001/collections/k8s
   ```

4. Poll Qdrant every 5 seconds until point count reaches ≥ 25 (or up to 90 seconds):
   ```bash
   python3 -c "
   import urllib.request, json, time
   for i in range(18):
       time.sleep(5)
       d = json.load(urllib.request.urlopen('http://localhost:30001/collections/k8s'))
       count = d['result']['points_count']
       print(f't+{(i+1)*5}s: {count} points')
       if count >= 25:
           print('Repopulated!')
           break
   "
   ```

5. Report the final point count and confirm the collection status is `green`.

If the reset webhook returns 404, the workflow is not active. Run `/reimport-workflows` to reactivate all workflows, then retry.
