# Step-by-Step: Adding Kubernetes Secret Watching

This document describes how the Secret resource watching feature was diagnosed and implemented (Plan 3).

---

## Problem

Querying the AI assistant "give me secrets information of each namespace" returned:

> No indexed Kubernetes resources found in vector database.

Two root causes were found during investigation.

---

## Root Cause 1: Secret not in the watched resource list

`k8s-watcher/watcher.py` only watched 9 resource types:

```
Namespace, Pod, Service, ConfigMap, PVC,
Deployment, ReplicaSet, StatefulSet, DaemonSet
```

`Secret` was absent. No Secret events were ever published to Kafka, so no Secret vectors existed in Qdrant. Embedding a query about secrets produced a vector that found zero matches.

## Root Cause 2: `obj.kind` is always `None` from the Kubernetes watch stream

The Kubernetes Python client does not populate `obj.kind` on watch stream objects. The previous code also tried `raw.get("kind", "")` (from `obj.to_dict()`), which is also empty for watch events. This caused every resource's embed text to read:

```
"Kubernetes  named coredns in namespace kube-system. ..."
              ↑ empty string
```

The `kind` payload field stored in Qdrant was `null` for all resource types.

---

## Fix

### 1. Add `kind_hint` parameter to `obj_to_payload`

`kind_hint` is the resource type label string passed in by the caller (e.g. `"Secret"`, `"Pod"`). The kind resolution becomes:

```python
kind = obj.kind or raw.get("kind", "") or kind_hint
```

Both `watch_stream` and `resync_all` pass `kind_hint=label` for every resource type. This fixes the empty-kind problem for all 10 resource types.

```python
# Before
payload = obj_to_payload(event["type"], obj)

# After
payload = obj_to_payload(event["type"], obj, kind_hint=label)
```

### 2. Secret-safe spec block

When `kind == "Secret"`, the `spec` block is replaced before it is stored in Qdrant or published to Kafka:

```python
if kind == "Secret":
    spec = {
        "type": raw.get("type", "Opaque"),
        "dataKeys": list((raw.get("data") or {}).keys()),
    }
```

`raw["data"]` contains base64-encoded secret values. Only the **key names** are kept. The values are discarded. This applies to both the live watch stream and the `resync_all` bulk republish.

### 3. Add Secret to the watcher and resync lists

Both the `watchers` list in `main()` and the `resource_fns` list in `resync_all` gained one entry:

```python
(v1.list_secret_for_all_namespaces, "Secret"),
```

The watcher now tracks **10 resource types** and logs:

```
Watching 10 resource types on topic 'k8s-resources' (Secrets: key names only)
```

### 4. RBAC: add `secrets` to the ClusterRole

`infra/k8s/k8s-watcher/k8s-watcher-rbac.yaml` — added `"secrets"` to the core API group:

```yaml
- apiGroups: [""]
  resources: ["namespaces", "pods", "services", "configmaps",
              "persistentvolumeclaims", "secrets"]
  verbs: ["list", "watch"]
```

Without this, the k8s-watcher ServiceAccount receives `403 Forbidden` when it tries to list or watch Secrets.

### 5. New E2E tests

Two new tests were added to `tests/e2e/playwright_k8s_ai_e2e.spec.ts`:

**Test 6 — CDC Secret:** creates `e2e-test-secret` with `username=admin` and `password=supersecret123`, verifies the Kafka offset advances (k8s-watcher published the event), upserts safe metadata to Qdrant, then asserts:
- `point.payload.kind === "Secret"`
- The Qdrant payload does **not** contain `"supersecret123"`

**Test 7 — AI secrets query:** embeds "What secrets exist in the kube-system namespace?", searches Qdrant, asserts ≥1 result has `kind=Secret` and `namespace=kube-system`, calls the Ollama LLM, asserts the response mentions "secret" and "kube-system" but never contains raw secret values.

---

## Operational Steps Executed

```bash
# 1. Build new k8s-watcher image with Secret support
docker build -t k8s-watcher-classic:latest ./k8s-watcher/

# 2. Load into kind cluster (imagePullPolicy: Never)
kind load docker-image k8s-watcher-classic:latest --name k8s-ai-classic

# 3. Apply updated RBAC (adds secrets to ClusterRole)
kubectl --context kind-k8s-ai-classic apply -f infra/k8s/k8s-watcher/k8s-watcher-rbac.yaml

# 4. Rolling restart to pick up new image
kubectl --context kind-k8s-ai-classic -n k8s-ai rollout restart deployment/k8s-watcher
kubectl --context kind-k8s-ai-classic -n k8s-ai rollout status deployment/k8s-watcher

# Confirm startup log:
# "Watching 10 resource types on topic 'k8s-resources' (Secrets: key names only)"
# "Starting watch: Secret"

# 5. Trigger full resync so Secrets are indexed into Qdrant
curl -X POST http://localhost:31000/webhook/k8s-reset \
  -H 'Content-Type: application/json' -d '{}'

# 6. Wait ~30-45s for Qdrant repopulation, then verify
curl -s http://localhost:31001/collections/k8s/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"must":[{"key":"kind","match":{"value":"Secret"}}]},"limit":5,"with_payload":true}' \
  | python3 -m json.tool
# Expected: points with kind=Secret, raw_spec_json contains type+dataKeys, no base64 values

# 7. Run all tests
npm test   # 7/7 pass
```

---

## Verification

```
Running 7 tests using 1 worker

  ✓  CDC: create namespace → Kafka event published + Qdrant insertion (2.9s)
  ✓  CDC: update deployment → old vector replaced (dedup by resource_uid) (2.0s)
  ✓  CDC: delete resource → point removed from Qdrant vector store (35ms)
  ✓  AI: namespace count query → structured markdown table response (15.5s)
  ✓  CDC: create secret → Kafka event published + Qdrant insertion (safe metadata only) (2.9s)
  ✓  AI: secrets query → returns Secret metadata without exposing values (1.1s)
  ✓  Reset: POST /webhook/k8s-reset clears Qdrant and CDC resync repopulates (3.4s)

  7 passed (28.3s)
```

Sample Qdrant entry for a Secret (safe — no values):

```json
{
  "kind": "Secret",
  "name": "bootstrap-token-abcdef",
  "namespace": "kube-system",
  "raw_spec_json": "{\"type\": \"bootstrap.kubernetes.io/token\", \"dataKeys\": [\"auth-extra-groups\", \"expiration\", \"token-id\", \"token-secret\", \"usage-bootstrap-authentication\", \"usage-bootstrap-signing\"]}"
}
```

---

## Files Changed

| File | What changed |
|------|-------------|
| `k8s-watcher/watcher.py` | `kind_hint` param on `obj_to_payload`; Secret-safe spec block; Secret added to `watchers` and `resync_all` |
| `infra/k8s/k8s-watcher/k8s-watcher-rbac.yaml` | Added `"secrets"` to core API group resources |
| `tests/e2e/playwright_k8s_ai_e2e.spec.ts` | Added Test 6 (CDC Secret) and Test 7 (AI secrets query) |
| `docs/plans/3. Add Secret Resource Watching.md` | Implementation plan |
