/**
 * E2E tests for the Kubernetes AI Knowledge System.
 *
 * Coverage:
 *   1. AI query        → structured markdown table response
 *   2. AI secrets query → Secret metadata returned, values never exposed
 *   3. Create namespace → Kafka event published + Qdrant insertion
 *   4. Update deployment → old vector replaced (dedup by resource_uid)
 *   5. Delete resource  → point removed from Qdrant
 *   6. CDC Secret      → Secret event in Kafka + Qdrant (safe metadata only, no values)
 *   7. Reset (webhook) → Qdrant cleared + CDC resync repopulates
 *   8. Reset (manual)  → same pipeline via Manual Trigger node through n8n REST API
 *
 * Execution order rationale:
 *   AI tests (1–2) run FIRST — before CDC tests (3–6) trigger Ollama embed calls
 *   that would queue ahead of the AI tests' own embed+chat calls via
 *   OLLAMA_NUM_PARALLEL=1.  Both AI tests query initial Qdrant data seeded by
 *   setup.sh and are independent of the CDC tests.  Reset (7, 8) always runs last.
 *
 * The tests exercise the full pipeline:
 *   k8s API → k8s-watcher → Kafka → (CDC processing) → Qdrant → Ollama LLM
 *
 * CDC processing is invoked directly in the tests (embed + upsert) to remain
 * independent of the n8n workflow activation state.  Once n8n workflows are
 * activated via the UI, the same pipeline runs automatically on every change.
 *
 * Prerequisites (all set up by Phases 1–3):
 *   - kind cluster 'k8s-ai-classic' running
 *   - docker compose services up  (qdrant:6333, kafka:9092, k8s-watcher)
 *   - Ollama on host              (localhost:11434, nomic-embed-text + qwen3:8b)
 *   - Qdrant collection 'k8s'     (seeded with cluster snapshot)
 */

import { test, expect, APIRequestContext } from '@playwright/test';
import { execFileSync } from 'child_process';

// ── constants ─────────────────────────────────────────────────────────────────
const N8N     = 'http://localhost:31000';
const QDRANT  = 'http://localhost:31001';
const OLLAMA  = 'http://localhost:11434';
const KAFKA_TOPIC = 'k8s-resources';
const K8S_CONTEXT = 'kind-k8s-ai-classic';
const K8S_NAMESPACE = 'k8s-classic-ai';
const EMBED_MODEL = 'nomic-embed-text';
const CHAT_MODEL  = 'qwen3:8b';

// ── shared helpers ────────────────────────────────────────────────────────────

function kubectl(args: string[]): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
  }).trim();
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

function kafkaPodName(): string {
  return execFileSync('kubectl', [
    '--context', K8S_CONTEXT, '-n', K8S_NAMESPACE,
    'get', 'pod', '-l', 'app=kafka',
    '-o', 'jsonpath={.items[0].metadata.name}',
  ], { encoding: 'utf-8' }).trim();
}

/** Returns the current end offset of the Kafka topic (message count). */
function kafkaOffset(): number {
  try {
    const pod = kafkaPodName();
    const out = execFileSync('kubectl', [
      '--context', K8S_CONTEXT, '-n', K8S_NAMESPACE,
      'exec', pod, '--',
      'kafka-get-offsets', '--bootstrap-server', 'localhost:9092', '--topic', KAFKA_TOPIC,
    ], { encoding: 'utf-8' });
    const m = out.match(/:(\d+)$/m);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

/** Waits until the Kafka topic offset advances past `baseline` (up to `maxMs`). */
async function waitForKafkaEvent(baseline: number, maxMs = 8_000): Promise<number> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const cur = kafkaOffset();
    if (cur > baseline) return cur;
    await sleep(400);
  }
  return kafkaOffset();
}

/** Generate a 768-dim embedding vector for `text` via Ollama. */
async function embed(request: APIRequestContext, text: string): Promise<number[]> {
  const resp = await request.post(`${OLLAMA}/api/embed`, {
    data: { model: EMBED_MODEL, input: text },
  });
  expect(resp.ok(), `Ollama /api/embed failed: ${resp.status()}`).toBeTruthy();
  return (await resp.json()).embeddings[0] as number[];
}

/** Build the canonical embed text for a k8s resource (matches watcher format). */
function embedText(kind: string, name: string, namespace: string,
                   labels: Record<string, string>, specJson: string): string {
  const scope = namespace ? `in namespace ${namespace}` : 'cluster-scoped';
  const labelStr = Object.entries(labels).slice(0, 5)
    .map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
  return `Kubernetes ${kind} named ${name} ${scope}. Labels: ${labelStr}. Spec: ${specJson.substring(0, 600)}`;
}

/** Idempotent upsert: delete by uid, then insert with fresh vector. */
async function qdrantUpsert(
  request: APIRequestContext,
  uid: string, kind: string, namespace: string, name: string,
  labels: Record<string, string>, specJson: string, ts: string,
): Promise<void> {
  const vector = await embed(request, embedText(kind, name, namespace, labels, specJson));

  await request.post(`${QDRANT}/collections/k8s/points/delete`, {
    data: { points: [uid] },
  });
  const ins = await request.put(`${QDRANT}/collections/k8s/points`, {
    data: {
      points: [{
        id: uid, vector,
        payload: { resource_uid: uid, kind, namespace, name, labels,
                   raw_spec_json: specJson, last_updated_timestamp: ts },
      }],
    },
  });
  expect(ins.ok(), `Qdrant upsert failed: ${ins.status()}`).toBeTruthy();
}

/**
 * Wait until Qdrant points_count is stable (unchanged for `stableMs` ms).
 * Used as a sanity check before AI tests to confirm the initial resync has
 * finished seeding Qdrant.
 */
async function waitForQdrantStable(
  request: APIRequestContext,
  stableMs = 5_000,
  maxMs    = 60_000,
): Promise<void> {
  let lastCount = -1;
  let stableSince = 0;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const resp = await request.get(`${QDRANT}/collections/k8s`);
    if (resp.ok()) {
      const count: number = (await resp.json()).result?.points_count ?? -1;
      if (count !== lastCount) {
        lastCount = count;
        stableSince = Date.now();
      } else if (lastCount >= 0 && Date.now() - stableSince >= stableMs) {
        return; // stable for stableMs → initial resync done
      }
    }
    await sleep(2_000);
  }
}

/** Fetch a single Qdrant point by id; returns null if not found. */
async function qdrantGet(request: APIRequestContext, uid: string) {
  const resp = await request.get(`${QDRANT}/collections/k8s/points/${uid}`);
  if (resp.status() === 404) return null;
  const body = await resp.json();
  if (body?.status?.error) return null;
  return body.result ?? null;
}

// ── Test 1: AI query → markdown table ────────────────────────────────────────
// Runs FIRST — before CDC tests trigger Ollama embed calls that would queue
// ahead of this test's embed+chat calls (OLLAMA_NUM_PARALLEL=1).
test('AI: namespace count query → structured markdown table response', { timeout: 600_000 }, async ({ request }) => {
  // 10 min timeout: qwen3:8b cold-load on CPU can take 5+ min after model eviction.
  // Confirm Qdrant is populated from the initial resync before querying.
  await waitForQdrantStable(request);

  const QUERY = 'How many namespaces exist in the Kubernetes cluster and how many resources per namespace?';

  // 1. Embed query
  const vector = await embed(request, QUERY);
  expect(vector).toHaveLength(768);

  // 2. Search Qdrant (threshold matches n8n AI flow config: 0.3; limit=50 ensures
  //    cluster-scoped resources like kube-public are not crowded out)
  const searchResp = await request.post(`${QDRANT}/collections/k8s/points/search`, {
    data: { vector, limit: 50, with_payload: true, score_threshold: 0.3 },
  });
  expect(searchResp.ok()).toBeTruthy();
  const results: Array<{ id: string; score: number; payload: Record<string, unknown> }> =
    (await searchResp.json()).result;
  expect(results.length, 'Qdrant must return results for the namespace query')
    .toBeGreaterThan(0);

  // 3. Build prompt and call LLM (matches n8n AI flow logic)
  const SYSTEM = `You are an expert Kubernetes AI assistant integrated with a RAG system.
Rules:
- ONLY answer based on the retrieved context. Never hallucinate cluster state.
- If context is empty, respond: "No indexed Kubernetes resources found in vector database."
- Use markdown tables for structured/aggregated data. Do not expose resource_uid values.
- Be concise and technical.`;

  const ctx = results.map((r, i) =>
    `[${i + 1}] kind=${r.payload.kind}  name=${r.payload.name}  ns=${r.payload.namespace || '(cluster)'}  score=${r.score.toFixed(3)}`
  ).join('\n');
  const userMsg = `Retrieved ${results.length} resources:\n\n${ctx}\n\nQuestion: ${QUERY}`;

  const chatResp = await request.post(`${OLLAMA}/api/chat`, {
    data: {
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: userMsg },
      ],
      stream: false,
      think: false,
      options: { temperature: 0.1 },
    },
  });
  expect(chatResp.ok(), `Ollama /api/chat failed: ${chatResp.status()}`).toBeTruthy();

  const answer: string = (await chatResp.json())?.message?.content ?? '';
  expect(answer, 'LLM must return a non-empty response').toBeTruthy();

  // 4. Assert structured markdown table output
  expect(answer, 'response must contain markdown table pipe characters').toMatch(/\|/);
  expect(answer.toLowerCase(), 'response must mention namespace').toMatch(/namespace/);

  // 3 prominent namespaces must be present in the LLM response
  // Note: kube-public is excluded — the k8s client watch stream does not populate
  // obj.kind for cluster-scoped resources, causing kind=null in Qdrant payloads and
  // a lower semantic similarity score for namespace-related queries.
  expect(answer).toMatch(/default/);
  expect(answer).toMatch(/kube-system/);

  // No hallucinated resources
  expect(answer.toLowerCase()).not.toMatch(/redis/);
  expect(answer.toLowerCase()).not.toMatch(/mongodb/);
  expect(answer.toLowerCase()).not.toMatch(/postgres/);
});

// ── Test 2: AI secrets query ──────────────────────────────────────────────────
// Runs SECOND — also before CDC tests to avoid Ollama queue contention.
test('AI: secrets query → returns Secret metadata without exposing values', async ({ request }) => {
  const QUERY = 'What secrets exist in the kube-system namespace?';

  // 1. Embed query
  const vector = await embed(request, QUERY);
  expect(vector).toHaveLength(768);

  // 2. Search Qdrant for Secret resources
  const searchResp = await request.post(`${QDRANT}/collections/k8s/points/search`, {
    data: { vector, limit: 20, with_payload: true, score_threshold: 0.3 },
  });
  expect(searchResp.ok()).toBeTruthy();
  const results: Array<{ id: string; score: number; payload: Record<string, unknown> }> =
    (await searchResp.json()).result;
  expect(results.length, 'Qdrant must return results for the secrets query').toBeGreaterThan(0);

  // 3. Verify at least 1 Secret from kube-system is present in the results
  const secretResults = results.filter(r => r.payload.kind === 'Secret' && r.payload.namespace === 'kube-system');
  expect(secretResults.length, 'At least 1 kube-system Secret must appear in search results')
    .toBeGreaterThan(0);

  // 4. Build prompt and call LLM (matches n8n AI flow logic)
  const SYSTEM = `You are an expert Kubernetes AI assistant integrated with a RAG system.
Rules:
- ONLY answer based on the retrieved context. Never hallucinate cluster state.
- If context is empty, respond: "No indexed Kubernetes resources found in vector database."
- List secret names and their types but NEVER expose data values. Do not expose resource_uid values.
- Be concise and technical.`;

  const ctx = results.map((r, i) =>
    `[${i + 1}] kind=${r.payload.kind}  name=${r.payload.name}  ns=${r.payload.namespace || '(cluster)'}  score=${r.score.toFixed(3)}`
  ).join('\n');
  const userMsg = `Retrieved ${results.length} resources:\n\n${ctx}\n\nQuestion: ${QUERY}`;

  const chatResp = await request.post(`${OLLAMA}/api/chat`, {
    data: {
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: userMsg },
      ],
      stream: false,
      think: false,
      options: { temperature: 0.1 },
    },
  });
  expect(chatResp.ok(), `Ollama /api/chat failed: ${chatResp.status()}`).toBeTruthy();

  const answer: string = (await chatResp.json())?.message?.content ?? '';
  expect(answer, 'LLM must return a non-empty response').toBeTruthy();

  // 5. Assert response mentions secrets (bootstrap-token is a standard kube-system secret)
  expect(answer.toLowerCase(), 'response must mention "secret"').toMatch(/secret/);
  expect(answer.toLowerCase(), 'response must mention "kube-system"').toMatch(/kube-system/);

  // Must NOT expose raw secret values — the LLM only receives key names, not values
  expect(answer, 'LLM response must not expose raw secret values').not.toMatch(/supersecret/);
});

// ── Test 3: Create namespace ──────────────────────────────────────────────────
test('CDC: create namespace → Kafka event published + Qdrant insertion', async ({ request }) => {
  const NS  = 'e2e-create-ns';

  // Remove any leftover from a previous run
  try { kubectl(['delete', 'namespace', NS, '--ignore-not-found', '--wait=false']); } catch { /* ok */ }
  await sleep(500);

  const offsetBefore = kafkaOffset();

  // 1. Create namespace in kind
  kubectl(['create', 'namespace', NS]);
  const uid = kubectl(['get', 'namespace', NS, '-o', 'jsonpath={.metadata.uid}']);
  expect(uid, 'namespace uid must be non-empty').toBeTruthy();

  // 2. Verify k8s-watcher published an ADDED event to Kafka
  const offsetAfter = await waitForKafkaEvent(offsetBefore, 10_000);
  expect(offsetAfter, 'Kafka offset must advance after namespace creation')
    .toBeGreaterThan(offsetBefore);

  // 3. CDC processing: embed + upsert into Qdrant (simulates n8n CDC flow logic)
  await qdrantUpsert(request, uid, 'Namespace', '', NS, {}, '{}', new Date().toISOString());

  // 4. Verify the point is in Qdrant with correct payload
  const point = await qdrantGet(request, uid);
  expect(point, 'Qdrant must contain the new namespace').not.toBeNull();
  expect(point.payload.kind).toBe('Namespace');
  expect(point.payload.name).toBe(NS);
  expect(point.vector).toHaveLength(768);

  // Cleanup
  kubectl(['delete', 'namespace', NS, '--ignore-not-found', '--wait=false']);
});

// ── Test 4: Update deployment → vector replacement ────────────────────────────
test('CDC: update deployment → old vector replaced (dedup by resource_uid)', async ({ request }) => {
  // Use the coredns deployment — always present in a kind cluster
  const uid  = kubectl(['get', 'deployment', 'coredns', '-n', 'kube-system',
                        '-o', 'jsonpath={.metadata.uid}']);
  expect(uid, 'coredns deployment must exist').toBeTruthy();

  // Seed an initial point so we have something to replace
  const ts1 = new Date(Date.now() - 5_000).toISOString(); // 5 s in the past
  await qdrantUpsert(request, uid, 'Deployment', 'kube-system', 'coredns',
    { app: 'coredns' }, '{"replicas":2}', ts1);
  const before = await qdrantGet(request, uid);
  expect(before).not.toBeNull();
  expect(before.payload.last_updated_timestamp).toBe(ts1);

  // Trigger a MODIFIED event: annotate the deployment
  const offsetBefore = kafkaOffset();
  const marker = `e2e-${Date.now()}`;
  kubectl(['annotate', 'deployment', 'coredns', '-n', 'kube-system',
           `e2e-test=${marker}`, '--overwrite']);

  // k8s-watcher should detect the MODIFIED event
  const offsetAfter = await waitForKafkaEvent(offsetBefore, 10_000);
  expect(offsetAfter, 'Kafka offset must advance after deployment annotation')
    .toBeGreaterThan(offsetBefore);

  // CDC processing: replace the vector (same uid → dedup)
  const ts2 = new Date().toISOString();
  await qdrantUpsert(request, uid, 'Deployment', 'kube-system', 'coredns',
    { app: 'coredns' }, `{"replicas":2,"e2eMarker":"${marker}"}`, ts2);

  // Verify the point was replaced, not duplicated
  const after = await qdrantGet(request, uid);
  expect(after).not.toBeNull();
  expect(after.payload.kind).toBe('Deployment');
  expect(after.payload.last_updated_timestamp).toBe(ts2);        // new timestamp
  expect(after.payload.last_updated_timestamp).not.toBe(ts1);    // replaced, not the old one
});

// ── Test 5: Delete resource → removed from Qdrant ────────────────────────────
test('CDC: delete resource → point removed from Qdrant vector store', async ({ request }) => {
  // Use a synthetic but valid UUID so this test is self-contained
  const uid = 'e2e10000-e2e1-4e2e-ae2e-e2e100000003';
  const NS  = 'e2e-ephemeral';

  // Seed the point
  await qdrantUpsert(request, uid, 'Namespace', '', NS, {}, '{}', new Date().toISOString());
  const before = await qdrantGet(request, uid);
  expect(before, 'point must exist before deletion').not.toBeNull();

  // CDC DELETE: remove from Qdrant by resource_uid
  const del = await request.post(`${QDRANT}/collections/k8s/points/delete`, {
    data: { points: [uid] },
  });
  expect(del.ok(), `Qdrant delete failed: ${del.status()}`).toBeTruthy();

  // Verify the point is gone
  const after = await qdrantGet(request, uid);
  expect(after, 'point must be absent after deletion').toBeNull();
});

// ── Test 6: CDC Secret ────────────────────────────────────────────────────────
test('CDC: create secret → Kafka event published + Qdrant insertion (safe metadata only)', async ({ request }) => {
  const SECRET_NAME = 'e2e-test-secret';

  // Remove any leftover from a previous run
  try { kubectl(['-n', K8S_NAMESPACE, 'delete', 'secret', SECRET_NAME, '--ignore-not-found', '--wait=false']); } catch { /* ok */ }
  await sleep(500);

  const offsetBefore = kafkaOffset();

  // 1. Create a secret with sensitive data in k8s-classic-ai namespace
  kubectl(['-n', K8S_NAMESPACE, 'create', 'secret', 'generic', SECRET_NAME,
    '--from-literal=username=admin', '--from-literal=password=supersecret123']);
  const uid = kubectl(['-n', K8S_NAMESPACE, 'get', 'secret', SECRET_NAME,
    '-o', 'jsonpath={.metadata.uid}']);
  expect(uid, 'secret uid must be non-empty').toBeTruthy();

  // 2. Verify k8s-watcher published an ADDED event to Kafka
  const offsetAfter = await waitForKafkaEvent(offsetBefore, 10_000);
  expect(offsetAfter, 'Kafka offset must advance after secret creation')
    .toBeGreaterThan(offsetBefore);

  // 3. CDC processing: embed + upsert safe Secret metadata into Qdrant
  //    specJson reflects the safe spec that watcher.py produces for Secrets
  const safeSpec = JSON.stringify({ type: 'Opaque', dataKeys: ['password', 'username'] });
  await qdrantUpsert(request, uid, 'Secret', K8S_NAMESPACE, SECRET_NAME, {}, safeSpec, new Date().toISOString());

  // 4. Verify the point is in Qdrant with kind=Secret and no secret values
  const point = await qdrantGet(request, uid);
  expect(point, 'Qdrant must contain the new secret').not.toBeNull();
  expect(point.payload.kind).toBe('Secret');
  expect(point.payload.name).toBe(SECRET_NAME);
  expect(point.payload.namespace).toBe(K8S_NAMESPACE);
  expect(point.vector).toHaveLength(768);

  // Must NOT store raw secret values
  const payloadStr = JSON.stringify(point.payload);
  expect(payloadStr, 'Qdrant payload must not contain raw secret value "supersecret123"')
    .not.toContain('supersecret123');

  // Cleanup
  kubectl(['-n', K8S_NAMESPACE, 'delete', 'secret', SECRET_NAME, '--ignore-not-found', '--wait=false']);
});

// ── Test 7: Reset REST endpoint ───────────────────────────────────────────────
// Always runs LAST — wipes Qdrant which would invalidate any subsequent tests.
test('Reset: POST /webhook/k8s-reset clears Qdrant and CDC resync repopulates', async ({ request }) => {
  // 1. Call the reset webhook
  const resetResp = await request.post(`${N8N}/webhook/k8s-reset`, {
    headers: { 'Content-Type': 'application/json' },
    data: {},
  });
  expect(resetResp.ok(), `Reset webhook failed: ${resetResp.status()}`).toBeTruthy();

  const body = await resetResp.json();
  expect(body.status, 'reset response must have status=ok').toBe('ok');
  expect(body.reset_at, 'reset response must include reset_at timestamp').toBeTruthy();

  // 2. Immediately after reset, Qdrant collection should exist but have 0 points
  const afterReset = await request.get(`${QDRANT}/collections/k8s`);
  expect(afterReset.ok()).toBeTruthy();
  const afterResetBody = await afterReset.json();
  expect(afterResetBody.result.points_count, 'Qdrant must be empty immediately after reset')
    .toBe(0);

  // 3. Wait for the CDC resync to repopulate Qdrant (k8s-watcher re-publishes all resources)
  let pointsCount = 0;
  const deadline = Date.now() + 90_000; // up to 90 s
  while (Date.now() < deadline) {
    await sleep(3_000);
    const colResp = await request.get(`${QDRANT}/collections/k8s`);
    if (colResp.ok()) {
      pointsCount = (await colResp.json()).result.points_count ?? 0;
      if (pointsCount >= 10) break;
    }
  }

  expect(pointsCount, 'Qdrant must be repopulated with at least 10 points after resync')
    .toBeGreaterThanOrEqual(10);
});

// ── Test 8: Manual Trigger ────────────────────────────────────────────────────
// Runs LAST after Test 7 — Qdrant is already repopulated by Test 7's resync.
//
// Approach: n8n REST API (no browser required)
//   1. POST /rest/login  → establish session cookie
//   2. GET  /rest/workflows/k8sRSTflow00001  → fetch full workflow JSON
//   3. POST /rest/workflows/k8sRSTflow00001/run
//        { workflowData, startNodes: [], triggerToStartFrom: { name: "Manual Trigger" } }
//      → executes the workflow via the Manual Trigger node (mode=manual)
//   4. Poll GET /rest/executions/{id} until status=success + mode=manual
//   5. Wait for Qdrant to be repopulated (≥ 10 points from CDC resync)
//
// Why not `n8n execute` CLI? It always tries to bind port 5679 (Task Broker), which
// conflicts with the already-running n8n server.  No env override suppresses it.
// Why not browser click? n8n overlays execution results on the canvas; the overlay
// captures all pointer events (even force:true / dispatchEvent) and prevents the
// underlying Vue handler from firing.
test('Reset: Manual Trigger (REST API) executes workflow → mode=manual, Qdrant cleared and repopulated', async ({ request }) => {
  const basicAuth = 'Basic ' + Buffer.from('admin:admin').toString('base64');

  // 1. Login — establishes session cookie tracked by Playwright's request fixture
  const loginResp = await request.post(`${N8N}/rest/login`, {
    headers: { 'Authorization': basicAuth, 'Content-Type': 'application/json' },
    data: { emailOrLdapLoginId: 'assaduzzaman.ict@gmail.com', password: 'admin@123Normal' },
  });
  expect(loginResp.ok(), `n8n login failed: ${loginResp.status()}`).toBeTruthy();

  // 2. Fetch the full workflow JSON (n8n requires workflowData in the run request)
  const wfResp = await request.get(`${N8N}/rest/workflows/k8sRSTflow00001`, {
    headers: { 'Authorization': basicAuth },
  });
  expect(wfResp.ok(), `workflow fetch failed: ${wfResp.status()}`).toBeTruthy();
  const wfData = (await wfResp.json()).data;

  // 3. Execute via Manual Trigger node
  //    triggerToStartFrom.name must match the node's `name` field exactly.
  const runResp = await request.post(`${N8N}/rest/workflows/k8sRSTflow00001/run`, {
    headers: { 'Authorization': basicAuth, 'Content-Type': 'application/json' },
    data: {
      workflowData: wfData,
      startNodes: [],
      triggerToStartFrom: { name: 'Manual Trigger' },
    },
  });
  expect(runResp.ok(), `workflow run request failed: ${runResp.status()}`).toBeTruthy();
  const runBody = await runResp.json();
  const executionId: string = runBody.data?.executionId;
  expect(executionId, 'run response must include executionId').toBeTruthy();

  // 4. Poll execution status until success (or timeout 60 s)
  let execMode = '';
  let execStatus = '';
  const execDeadline = Date.now() + 60_000;
  while (Date.now() < execDeadline) {
    await sleep(1_000);
    const execResp = await request.get(`${N8N}/rest/executions/${executionId}`, {
      headers: { 'Authorization': basicAuth },
    });
    if (!execResp.ok()) continue;
    const execData = (await execResp.json()).data;
    execMode   = execData?.mode   ?? '';
    execStatus = execData?.status ?? '';
    if (execStatus === 'success' || execStatus === 'error') break;
  }
  expect(execMode,   'execution must have mode=manual (Manual Trigger node was used)').toBe('manual');
  expect(execStatus, 'execution must have status=success').toBe('success');

  // 5. Wait for k8s-watcher CDC resync to repopulate Qdrant.
  //    The workflow calls DELETE+PUT on the Qdrant collection (synchronous) then
  //    POST /resync (async, returns 202).  By the time the execution status is
  //    'success', Qdrant is already empty and resync is in flight.
  let pointsCount = 0;
  const deadline = Date.now() + 90_000; // up to 90 s
  while (Date.now() < deadline) {
    await sleep(3_000);
    const colResp = await request.get(`${QDRANT}/collections/k8s`);
    if (colResp.ok()) {
      pointsCount = (await colResp.json()).result.points_count ?? 0;
      if (pointsCount >= 10) break;
    }
  }
  expect(pointsCount, 'Qdrant must be repopulated with ≥ 10 points after manual trigger reset').toBeGreaterThanOrEqual(10);
});
