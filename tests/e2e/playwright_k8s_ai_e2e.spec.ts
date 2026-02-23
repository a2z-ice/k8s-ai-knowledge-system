/**
 * E2E tests for the Kubernetes AI Knowledge System.
 *
 * Coverage:
 *   1. Create namespace → Kafka event published + Qdrant insertion
 *   2. Update deployment → old vector replaced (dedup by resource_uid)
 *   3. Delete resource  → point removed from Qdrant
 *   4. AI query        → structured markdown table response
 *
 * The tests exercise the full pipeline:
 *   k8s API → k8s-watcher → Kafka → (CDC processing) → Qdrant → Ollama LLM
 *
 * CDC processing is invoked directly in the tests (embed + upsert) to remain
 * independent of the n8n workflow activation state.  Once n8n workflows are
 * activated via the UI, the same pipeline runs automatically on every change.
 *
 * Prerequisites (all set up by Phases 1–3):
 *   - kind cluster 'k8s-ai' running
 *   - docker compose services up  (qdrant:6333, kafka:9092, k8s-watcher)
 *   - Ollama on host              (localhost:11434, nomic-embed-text + qwen3:8b)
 *   - Qdrant collection 'k8s'     (seeded with cluster snapshot)
 */

import { test, expect, APIRequestContext } from '@playwright/test';
import { execFileSync } from 'child_process';

// ── constants ─────────────────────────────────────────────────────────────────
const N8N     = 'http://localhost:5678';
const QDRANT  = 'http://localhost:6333';
const OLLAMA  = 'http://localhost:11434';
const KAFKA_CONTAINER = 'kind_vector_n8n-kafka-1';
const KAFKA_TOPIC = 'k8s-resources';
const K8S_CONTEXT = 'kind-k8s-ai';
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

/** Returns the current end offset of the Kafka topic (message count). */
function kafkaOffset(): number {
  try {
    const out = execFileSync('docker', [
      'exec', KAFKA_CONTAINER,
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

/** Fetch a single Qdrant point by id; returns null if not found. */
async function qdrantGet(request: APIRequestContext, uid: string) {
  const resp = await request.get(`${QDRANT}/collections/k8s/points/${uid}`);
  if (resp.status() === 404) return null;
  const body = await resp.json();
  if (body?.status?.error) return null;
  return body.result ?? null;
}

// ── Test 1: Create namespace ──────────────────────────────────────────────────
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

// ── Test 2: Update deployment → vector replacement ────────────────────────────
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

// ── Test 3: Delete resource → removed from Qdrant ────────────────────────────
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

// ── Test 4: AI query → markdown table ────────────────────────────────────────
test('AI: namespace count query → structured markdown table response', async ({ request }) => {
  const QUERY = 'How many namespaces exist in the Kubernetes cluster and how many resources per namespace?';

  // 1. Embed query
  const vector = await embed(request, QUERY);
  expect(vector).toHaveLength(768);

  // 2. Search Qdrant (threshold matches n8n AI flow config)
  const searchResp = await request.post(`${QDRANT}/collections/k8s/points/search`, {
    data: { vector, limit: 20, with_payload: true, score_threshold: 0.45 },
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

  // 5 known namespaces must be present
  expect(answer).toMatch(/default/);
  expect(answer).toMatch(/kube-system/);
  expect(answer).toMatch(/kube-public/);

  // No hallucinated resources
  expect(answer.toLowerCase()).not.toMatch(/redis/);
  expect(answer.toLowerCase()).not.toMatch(/mongodb/);
  expect(answer.toLowerCase()).not.toMatch(/postgres/);
});

// ── Test 5: Reset REST endpoint ───────────────────────────────────────────────
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
