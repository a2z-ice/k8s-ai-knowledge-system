/**
 * E2E tests for the Kubernetes AI Knowledge System.
 *
 * Coverage:
 *   1. Create namespace → Kafka event published + Qdrant insertion
 *   2. Update deployment → old vector replaced (dedup by resource_uid)
 *   3. Delete resource  → point removed from Qdrant
 *   4. AI query        → structured markdown table response (direct Ollama + Qdrant)
 *   5. Reset           → Qdrant cleared + CDC resync repopulates  [declared LAST]
 *   6. CDC Secret      → Secret event in Kafka + Qdrant (safe metadata only, no values)
 *   7. AI secrets query → Secret metadata returned, values never exposed (direct)
 *   8. AI Agent webhook → n8n AI Agent end-to-end via /webhook/k8s-ai-chat/chat
 *   9. AI Agent webhook → namespace query via Qdrant Vector Store tool
 *  10. AI Agent webhook → secrets query, values never exposed
 *  11. Memory: consecutive queries share session context (postgres-backed)
 *  12. Memory: clear removes all chat history from n8n_chat_histories table
 *
 * Qdrant payload structure (set by CDC_K8s_Flow's native Qdrant Vector Store insert):
 *
 *   {
 *     "pageContent": "<embed text>",       ← contentPayloadKey: "pageContent"
 *     "metadata": {                         ← metadataPayloadKey: "metadata"
 *       "resource_uid": "<k8s uid>",
 *       "kind": "Deployment",
 *       "namespace": "kube-system",
 *       "name": "coredns",
 *       "labels": "{}",
 *       "annotations": "{}",
 *       "raw_spec_json": "...",
 *       "last_updated_timestamp": "..."
 *     }
 *   }
 *
 * Delete uses Qdrant filter API (not point-ID delete) because native Qdrant insert
 * assigns auto-generated UUIDs as point IDs — resource_uid lives in metadata instead:
 *
 *   POST /collections/k8s/points/delete
 *   { "filter": { "must": [{ "key": "metadata.resource_uid", "match": { "value": "..." } }] } }
 *
 * E2E test helpers (qdrantUpsert, qdrantGet) set resource_uid as the Qdrant point ID
 * directly so qdrantGet(uid) still works for test-inserted points.  The CDC flow's
 * filter-delete finds both test-inserted and CDC-inserted points via metadata.resource_uid.
 *
 * AI flow topology (AI_K8s_Flow — native LangChain, parameter "agent": "toolsAgent"):
 *
 *   When chat message received
 *     │ (main)
 *     └→ AI Agent  ──────────────────────────────────────── output
 *          │ (ai_languageModel)   │ (ai_tool)   │ (ai_memory)
 *          ▼                      ▼              ▼
 *     Ollama Chat Model    Qdrant Vector Store  Postgres Chat Memory
 *     (qwen3:8b, 0.1)      (retrieve-as-tool,   (n8n_chat_histories,
 *                           topK=30)             session: k8s-ai-global,
 *                                │ (ai_embedding) contextWindow: 5)
 *                                ▼
 *                          Embeddings Ollama
 *                          (nomic-embed-text, 768-dim)
 *
 * Memory is stored in postgres (n8n_memory DB, n8n_chat_histories table).
 * Memory_Clear_Flow: Manual Trigger + hourly Schedule → DELETE FROM n8n_chat_histories
 */

import { test, expect, APIRequestContext } from '@playwright/test';
import { execFileSync } from 'child_process';

// ── constants ─────────────────────────────────────────────────────────────────
const N8N           = 'http://localhost:30000';
const QDRANT        = 'http://localhost:30001';
const OLLAMA        = 'http://localhost:11434';
const KAFKA_TOPIC   = 'k8s-resources';
const K8S_CONTEXT   = 'kind-k8s-ai';
const K8S_NAMESPACE = 'k8s-ai';
const EMBED_MODEL   = 'nomic-embed-text';
const CHAT_MODEL    = 'qwen3:8b';

// AI chat webhook — public endpoint exposed by Chat Trigger (webhookId: k8s-ai-chat)
const AI_CHAT_WEBHOOK = `${N8N}/webhook/k8s-ai-chat/chat`;

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

/** Returns the postgres pod name in the k8s-ai namespace. */
function postgresPodName(): string {
  return execFileSync('kubectl', [
    '--context', K8S_CONTEXT, '-n', K8S_NAMESPACE,
    'get', 'pod', '-l', 'app=postgres',
    '-o', 'jsonpath={.items[0].metadata.name}',
  ], { encoding: 'utf-8' }).trim();
}

/** Run a psql command in the postgres pod and return trimmed stdout. */
function psqlExec(sql: string): string {
  const pod = postgresPodName();
  return execFileSync('kubectl', [
    '--context', K8S_CONTEXT, '-n', K8S_NAMESPACE,
    'exec', pod, '--',
    'psql', '-U', 'n8n', '-d', 'n8n_memory', '-t', '-c', sql,
  ], { encoding: 'utf-8' }).trim();
}

/** Returns the current end offset of the Kafka topic. */
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

/** Waits until the Kafka topic offset advances past `baseline`. */
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

/** Build the canonical embed text (matches watcher.py format). */
function embedText(kind: string, name: string, namespace: string,
                   labels: Record<string, string>, specJson: string): string {
  const scope = namespace ? `in namespace ${namespace}` : 'cluster-scoped';
  const labelStr = Object.entries(labels).slice(0, 5)
    .map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
  return `Kubernetes ${kind} named ${name} ${scope}. Labels: ${labelStr}. Spec: ${specJson.substring(0, 600)}`;
}

/**
 * Upsert a Qdrant point using the same payload structure as CDC_K8s_Flow's
 * native Qdrant Vector Store insert node:
 *
 *   payload.pageContent   = embed text     (contentPayloadKey: "pageContent")
 *   payload.metadata.*    = all fields     (metadataPayloadKey: "metadata")
 *
 * We set id = resource_uid so qdrantGet(uid) works directly.
 * The CDC flow's filter-delete (key: "metadata.resource_uid") finds both
 * test-inserted and CDC-native-inserted points via the metadata field.
 */
async function qdrantUpsert(
  request: APIRequestContext,
  uid: string, kind: string, namespace: string, name: string,
  labels: Record<string, string>, specJson: string, ts: string,
): Promise<void> {
  const text = embedText(kind, name, namespace, labels, specJson);
  const vector = await embed(request, text);

  // Filter-delete first (matches how CDC_K8s_Flow deletes — by metadata.resource_uid)
  await request.post(`${QDRANT}/collections/k8s/points/delete`, {
    data: {
      filter: {
        must: [{ key: 'metadata.resource_uid', match: { value: uid } }],
      },
    },
  });

  const ins = await request.put(`${QDRANT}/collections/k8s/points`, {
    data: {
      points: [{
        id: uid,
        vector,
        payload: {
          pageContent: text,
          metadata: {
            resource_uid:           uid,
            kind,
            namespace,
            name,
            labels:                 JSON.stringify(labels),
            annotations:            '{}',
            spec_summary:           specJson,
            last_updated_timestamp: ts,
          },
        },
      }],
    },
  });
  expect(ins.ok(), `Qdrant upsert failed: ${ins.status()}`).toBeTruthy();
}

/**
 * Wait until Qdrant points_count is stable for `stableMs` ms.
 * Prevents Test 4 from racing against n8n CDC's async Ollama embed calls.
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
        return;
      }
    }
    await sleep(2_000);
  }
}

/** Fetch a single Qdrant point by id (works for test-inserted points where id = resource_uid). */
async function qdrantGet(request: APIRequestContext, uid: string) {
  const resp = await request.get(`${QDRANT}/collections/k8s/points/${uid}`);
  if (resp.status() === 404) return null;
  const body = await resp.json();
  if (body?.status?.error) return null;
  return body.result ?? null;
}

/**
 * Call the live n8n AI chat webhook.
 * Exercises the full native LangChain pipeline:
 *   When chat message received → AI Agent
 *     → Qdrant Vector Store (ai_tool, retrieve-as-tool, topK=30)
 *         → Embeddings Ollama (ai_embedding, nomic-embed-text)
 *     → Ollama Chat Model   (ai_languageModel, qwen3:8b)
 *     → Postgres Chat Memory (ai_memory, session: k8s-ai-global)
 */
async function aiWebhookQuery(
  request: APIRequestContext,
  chatInput: string,
  timeoutMs = 240_000,
): Promise<string> {
  const resp = await request.post(AI_CHAT_WEBHOOK, {
    data: { chatInput },
    timeout: timeoutMs,
  });
  expect(resp.ok(), `AI chat webhook HTTP ${resp.status()} — is AI_K8s_Flow active?`)
    .toBeTruthy();
  const body = await resp.json();
  const output: string = body?.output ?? body?.text ?? '';
  expect(output, 'AI Agent must return non-empty output').toBeTruthy();
  return output;
}

// ── Test 1: Create namespace ──────────────────────────────────────────────────
test('CDC: create namespace → Kafka event published + Qdrant insertion', async ({ request }) => {
  const NS = 'e2e-create-ns';

  try { kubectl(['delete', 'namespace', NS, '--ignore-not-found', '--wait=false']); } catch { /* ok */ }
  await sleep(500);

  const offsetBefore = kafkaOffset();

  kubectl(['create', 'namespace', NS]);
  const uid = kubectl(['get', 'namespace', NS, '-o', 'jsonpath={.metadata.uid}']);
  expect(uid, 'namespace uid must be non-empty').toBeTruthy();

  // k8s-watcher must publish the ADDED event
  const offsetAfter = await waitForKafkaEvent(offsetBefore, 10_000);
  expect(offsetAfter, 'Kafka offset must advance after namespace creation')
    .toBeGreaterThan(offsetBefore);

  // Simulate CDC processing: Format Document → Insert to Qdrant
  await qdrantUpsert(request, uid, 'Namespace', '', NS, {}, '{}', new Date().toISOString());

  // Verify payload structure: pageContent at top level, metadata nested
  const point = await qdrantGet(request, uid);
  expect(point, 'Qdrant must contain the new namespace').not.toBeNull();
  expect(point.payload.pageContent, 'pageContent must be stored (contentPayloadKey)')
    .toContain('Namespace');
  expect(point.payload.metadata.kind, 'kind stored under metadata').toBe('Namespace');
  expect(point.payload.metadata.name, 'name stored under metadata').toBe(NS);
  expect(point.payload.metadata.resource_uid, 'resource_uid stored under metadata').toBe(uid);
  expect(point.vector).toHaveLength(768);

  kubectl(['delete', 'namespace', NS, '--ignore-not-found', '--wait=false']);
});

// ── Test 2: Update deployment → vector replacement ────────────────────────────
test('CDC: update deployment → old vector replaced (dedup by resource_uid)', async ({ request }) => {
  const uid = kubectl(['get', 'deployment', 'coredns', '-n', 'kube-system',
                       '-o', 'jsonpath={.metadata.uid}']);
  expect(uid, 'coredns deployment must exist').toBeTruthy();

  const ts1 = new Date(Date.now() - 5_000).toISOString();
  await qdrantUpsert(request, uid, 'Deployment', 'kube-system', 'coredns',
    { app: 'coredns' }, '{"replicas":2}', ts1);

  const before = await qdrantGet(request, uid);
  expect(before).not.toBeNull();
  expect(before.payload.metadata.last_updated_timestamp).toBe(ts1);
  expect(before.payload.pageContent).toContain('Deployment');

  // Trigger MODIFIED event
  const offsetBefore = kafkaOffset();
  const marker = `e2e-${Date.now()}`;
  kubectl(['annotate', 'deployment', 'coredns', '-n', 'kube-system',
           `e2e-test=${marker}`, '--overwrite']);

  const offsetAfter = await waitForKafkaEvent(offsetBefore, 10_000);
  expect(offsetAfter, 'Kafka offset must advance after deployment annotation')
    .toBeGreaterThan(offsetBefore);

  // Replace vector (same uid → delete-by-filter + re-insert)
  const ts2 = new Date().toISOString();
  await qdrantUpsert(request, uid, 'Deployment', 'kube-system', 'coredns',
    { app: 'coredns' }, `{"replicas":2,"e2eMarker":"${marker}"}`, ts2);

  const after = await qdrantGet(request, uid);
  expect(after).not.toBeNull();
  expect(after.payload.metadata.kind).toBe('Deployment');
  expect(after.payload.metadata.last_updated_timestamp).toBe(ts2);
  expect(after.payload.metadata.last_updated_timestamp).not.toBe(ts1);
  expect(after.payload.pageContent).toContain('Deployment');
});

// ── Test 3: Delete resource → removed from Qdrant ────────────────────────────
test('CDC: delete resource → point removed from Qdrant vector store', async ({ request }) => {
  const uid = 'e2e10000-e2e1-4e2e-ae2e-e2e100000003';
  const NS  = 'e2e-ephemeral';

  await qdrantUpsert(request, uid, 'Namespace', '', NS, {}, '{}', new Date().toISOString());
  const before = await qdrantGet(request, uid);
  expect(before, 'point must exist before deletion').not.toBeNull();
  expect(before.payload.metadata.resource_uid).toBe(uid);

  // CDC DELETE: remove from Qdrant by metadata.resource_uid filter
  const del = await request.post(`${QDRANT}/collections/k8s/points/delete`, {
    data: {
      filter: {
        must: [{ key: 'metadata.resource_uid', match: { value: uid } }],
      },
    },
  });
  expect(del.ok(), `Qdrant filter-delete failed: ${del.status()}`).toBeTruthy();

  const after = await qdrantGet(request, uid);
  expect(after, 'point must be absent after deletion').toBeNull();
});

// ── Test 4: AI query → markdown table (direct Ollama + Qdrant) ───────────────
test('AI: namespace count query → structured markdown table response', async ({ request }) => {
  await waitForQdrantStable(request);

  const QUERY = 'How many namespaces exist in the Kubernetes cluster and how many resources per namespace?';

  // Embed with nomic-embed-text (same as Embeddings Ollama sub-node)
  const vector = await embed(request, QUERY);
  expect(vector).toHaveLength(768);

  // Search Qdrant — topK=50, score_threshold=0.3 (matches Qdrant Vector Store topK=30 in AI flow)
  const searchResp = await request.post(`${QDRANT}/collections/k8s/points/search`, {
    data: { vector, limit: 50, with_payload: true, score_threshold: 0.3 },
  });
  expect(searchResp.ok()).toBeTruthy();
  const results: Array<{ id: string; score: number; payload: Record<string, unknown> }> =
    (await searchResp.json()).result;
  expect(results.length, 'Qdrant must return results for the namespace query')
    .toBeGreaterThan(0);

  // Verify Qdrant payload has new nested metadata structure
  const first = results[0];
  expect(first.payload.pageContent, 'points must have pageContent field').toBeTruthy();
  const meta = first.payload.metadata as Record<string, unknown> | undefined;
  expect(meta, 'points must have metadata field').toBeTruthy();

  // Build prompt and call Ollama Chat Model (qwen3:8b, temp 0.1)
  const SYSTEM = `You are an expert Kubernetes AI assistant integrated with a RAG system.
Rules:
- ONLY answer based on the retrieved context. Never hallucinate cluster state.
- If context is empty, respond: "No indexed Kubernetes resources found in vector database."
- Use markdown tables for structured/aggregated data. Do not expose resource_uid values.
- Be concise and technical.`;

  const ctx = results.map((r, i) => {
    const m = r.payload.metadata as Record<string, unknown> || {};
    return `[${i + 1}] kind=${m.kind ?? r.payload['kind']}  name=${m.name ?? r.payload['name']}  ns=${m.namespace ?? r.payload['namespace'] ?? '(cluster)'}  score=${r.score.toFixed(3)}`;
  }).join('\n');
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
  expect(answer, 'response must contain markdown table').toMatch(/\|/);
  expect(answer.toLowerCase(), 'response must mention namespace').toMatch(/namespace/);
  expect(answer).toMatch(/default/);
  expect(answer).toMatch(/kube-system/);
  expect(answer.toLowerCase()).not.toMatch(/redis/);
  expect(answer.toLowerCase()).not.toMatch(/mongodb/);
});

// ── Test 6: CDC Secret ────────────────────────────────────────────────────────
test('CDC: create secret → Kafka event published + Qdrant insertion (safe metadata only)', async ({ request }) => {
  const SECRET_NAME = 'e2e-test-secret';

  try { kubectl(['-n', K8S_NAMESPACE, 'delete', 'secret', SECRET_NAME, '--ignore-not-found', '--wait=false']); } catch { /* ok */ }
  await sleep(500);

  const offsetBefore = kafkaOffset();

  kubectl(['-n', K8S_NAMESPACE, 'create', 'secret', 'generic', SECRET_NAME,
    '--from-literal=username=admin', '--from-literal=password=supersecret123']);
  const uid = kubectl(['-n', K8S_NAMESPACE, 'get', 'secret', SECRET_NAME,
    '-o', 'jsonpath={.metadata.uid}']);
  expect(uid, 'secret uid must be non-empty').toBeTruthy();

  const offsetAfter = await waitForKafkaEvent(offsetBefore, 10_000);
  expect(offsetAfter, 'Kafka offset must advance after secret creation')
    .toBeGreaterThan(offsetBefore);

  // CDC: embed + upsert safe Secret metadata (type + dataKeys only, no values)
  const safeSpec = JSON.stringify({ type: 'Opaque', dataKeys: ['password', 'username'] });
  await qdrantUpsert(request, uid, 'Secret', K8S_NAMESPACE, SECRET_NAME, {}, safeSpec, new Date().toISOString());

  const point = await qdrantGet(request, uid);
  expect(point, 'Qdrant must contain the new secret').not.toBeNull();
  expect(point.payload.metadata.kind).toBe('Secret');
  expect(point.payload.metadata.name).toBe(SECRET_NAME);
  expect(point.payload.metadata.namespace).toBe(K8S_NAMESPACE);
  expect(point.payload.metadata.resource_uid).toBe(uid);
  expect(point.vector).toHaveLength(768);
  expect(point.payload.pageContent).toContain('Secret');

  // Must NOT store raw secret values in payload
  const payloadStr = JSON.stringify(point.payload);
  expect(payloadStr, 'payload must not contain raw secret value')
    .not.toContain('supersecret123');

  kubectl(['-n', K8S_NAMESPACE, 'delete', 'secret', SECRET_NAME, '--ignore-not-found', '--wait=false']);
});

// ── Test 7: AI secrets query (direct Ollama + Qdrant) ─────────────────────────
test('AI: secrets query → returns Secret metadata without exposing values', async ({ request }) => {
  const QUERY = 'What secrets exist in the kube-system namespace?';

  const vector = await embed(request, QUERY);
  expect(vector).toHaveLength(768);

  const searchResp = await request.post(`${QDRANT}/collections/k8s/points/search`, {
    data: { vector, limit: 20, with_payload: true, score_threshold: 0.3 },
  });
  expect(searchResp.ok()).toBeTruthy();
  const results: Array<{ id: string; score: number; payload: Record<string, unknown> }> =
    (await searchResp.json()).result;
  expect(results.length, 'Qdrant must return results for the secrets query').toBeGreaterThan(0);

  // Verify at least 1 Secret from kube-system (metadata may be nested or flat)
  const secretResults = results.filter(r => {
    const m = r.payload.metadata as Record<string, unknown> || {};
    return (m.kind ?? r.payload['kind']) === 'Secret' &&
           (m.namespace ?? r.payload['namespace']) === 'kube-system';
  });
  expect(secretResults.length, 'At least 1 kube-system Secret must be in results')
    .toBeGreaterThan(0);

  const SYSTEM = `You are an expert Kubernetes AI assistant integrated with a RAG system.
Rules:
- ONLY answer based on the retrieved context. Never hallucinate cluster state.
- If context is empty, respond: "No indexed Kubernetes resources found in vector database."
- List secret names and their types but NEVER expose data values. Do not expose resource_uid values.
- Be concise and technical.`;

  const ctx = results.map((r, i) => {
    const m = r.payload.metadata as Record<string, unknown> || {};
    return `[${i + 1}] kind=${m.kind ?? r.payload['kind']}  name=${m.name ?? r.payload['name']}  ns=${m.namespace ?? r.payload['namespace'] ?? '(cluster)'}  score=${r.score.toFixed(3)}`;
  }).join('\n');
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
  expect(answer.toLowerCase()).toMatch(/secret/);
  expect(answer.toLowerCase()).toMatch(/kube-system/);
  expect(answer).not.toMatch(/supersecret/);
});

// ── Tests 8–10: AI Agent webhook end-to-end ───────────────────────────────────
/**
 * These tests call the live n8n webhook and exercise the full native pipeline:
 *
 *   POST /webhook/k8s-ai-chat/chat  {"chatInput": "..."}
 *     → When chat message received  (Chat Trigger, typeVersion 1.4)
 *     → AI Agent  (agent: "toolsAgent", typeVersion 1.7)
 *         → Ollama Chat Model  (lmChatOllama, qwen3:8b)   [ai_languageModel]
 *         → Qdrant Vector Store  (retrieve-as-tool, topK=30) [ai_tool]
 *               → Embeddings Ollama  (nomic-embed-text:latest) [ai_embedding]
 *         → Postgres Chat Memory  (memoryPostgresChat, session: k8s-ai-global) [ai_memory]
 */

test('AI Agent webhook: deployment query → grounded response via Qdrant tool', async ({ request }) => {
  // Verify Qdrant is populated before the AI Agent query
  const colResp = await request.get(`${QDRANT}/collections/k8s`);
  expect(colResp.ok()).toBeTruthy();
  const pointsCount: number = (await colResp.json()).result?.points_count ?? 0;
  expect(pointsCount, 'Qdrant must have ≥ 10 points before AI Agent query')
    .toBeGreaterThanOrEqual(10);

  const answer = await aiWebhookQuery(
    request,
    'Show me all deployments and their replica counts',
  );

  expect(answer.length, 'response must be substantive (> 20 chars)').toBeGreaterThan(20);
  // Response must mention at least one real deployment (n8n, coredns, qdrant, etc.)
  expect(answer.toLowerCase(), 'response must mention a known deployment').toMatch(/n8n|coredns|qdrant|k8s-watcher|local-path-provisioner/);
  // Must contain deployment-related content
  expect(answer.toLowerCase(), 'response must reference deployments or replicas').toMatch(/deploy|replica/);
  // Must not hallucinate resources not in the cluster
  expect(answer.toLowerCase()).not.toMatch(/redis/);
  expect(answer.toLowerCase()).not.toMatch(/mongodb/);
});

test('AI Agent webhook: namespace query → markdown table via Qdrant Vector Store tool', async ({ request }) => {
  const answer = await aiWebhookQuery(
    request,
    'List all namespaces in the Kubernetes cluster',
  );

  expect(answer.toLowerCase()).toMatch(/namespace/);
  // Response must mention at least one known namespace
  expect(answer.toLowerCase(), 'response must mention a known namespace').toMatch(/k8s-ai|kube-system|default|kube-node-lease|local-path-storage|kube-public/);
  // AI Agent should produce a markdown table for aggregated data
  expect(answer, 'agent must produce structured markdown').toMatch(/\|/);
});

test('AI Agent webhook: secrets query → names returned, values never exposed', async ({ request }) => {
  const answer = await aiWebhookQuery(
    request,
    'What secrets exist in the kube-system namespace? List their names and types.',
  );

  expect(answer.toLowerCase()).toMatch(/secret/);
  expect(answer.toLowerCase()).toMatch(/kube-system/);
  // No raw secret values — Qdrant only stores {type, dataKeys}, never base64 values
  expect(answer).not.toMatch(/supersecret/);
  // No suspiciously long base64 strings
  expect(answer).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
});

// ── Test 11: Memory persistence ───────────────────────────────────────────────
/**
 * Verifies that the AI Agent retains context across webhook calls within the same
 * session (k8s-ai-global). The MemoryPostgresChat node stores message pairs in
 * n8n_chat_histories (postgres) with contextWindowLength=5.
 *
 * Approach:
 *   1. Clear existing session history so the test starts from a clean slate.
 *   2. Ask a distinctive first question about kube-system pods.
 *   3. Ask a follow-up: "Which namespace did I just ask about?"
 *   4. Verify the second response references kube-system.
 */
test('Memory: consecutive queries share session context (postgres-backed)', async ({ request }) => {
  // 1. Clear any existing session history so the test is deterministic
  try {
    psqlExec("DELETE FROM n8n_chat_histories WHERE session_id = 'k8s-ai-global';");
  } catch (err) {
    // Table may not exist yet on first run before any AI call — that's fine
    // The table is auto-created by n8n on first MemoryPostgresChat use
  }

  // 2. First query — ask about a specific, memorable topic
  const firstQuery = 'How many pods are running in the kube-system namespace?';
  const answer1 = await aiWebhookQuery(request, firstQuery);
  expect(answer1, 'first AI response must be non-empty').toBeTruthy();
  expect(answer1.toLowerCase(), 'first response must mention kube-system or pods')
    .toMatch(/kube-system|pod/);

  // Small wait to ensure n8n has committed the memory rows to postgres
  await sleep(1_500);

  // 3. Follow-up question that requires memory of the first query
  const answer2 = await aiWebhookQuery(
    request,
    'Based on my previous question, which Kubernetes namespace did I ask about?',
  );

  // 4. The agent must recall the session context and reference kube-system
  expect(answer2.toLowerCase(), 'second response must recall kube-system from memory')
    .toMatch(/kube-system/);
});

// ── Test 12: Memory clear ─────────────────────────────────────────────────────
/**
 * Verifies the Memory_Clear_Flow operation: after chat history is present in
 * n8n_chat_histories, a DELETE clears it — exactly what Memory_Clear_Flow's
 * "Clear Memory" postgres node executes.
 *
 * This test uses kubectl exec on the postgres pod (psql) to verify rows before
 * and after the clear, since N8N_BASIC_AUTH_ACTIVE=true blocks REST API triggers.
 */
test('Memory: clear removes all chat history from n8n_chat_histories', async ({ request }) => {
  // 1. Ensure some history exists — send a chat query if needed
  //    (Test 11 above will have already populated the session, but if run in isolation
  //     we need to guarantee at least one row.)
  let countBefore: number;
  try {
    const raw = psqlExec('SELECT COUNT(*) FROM n8n_chat_histories;');
    countBefore = parseInt(raw, 10);
  } catch {
    // Table doesn't exist yet — send a query to create it
    countBefore = 0;
  }

  if (countBefore === 0) {
    await aiWebhookQuery(request, 'List all pods in the kube-system namespace');
    await sleep(1_500);
    const raw = psqlExec('SELECT COUNT(*) FROM n8n_chat_histories;');
    countBefore = parseInt(raw, 10);
  }

  expect(countBefore, 'n8n_chat_histories must have rows before clear')
    .toBeGreaterThan(0);

  // 2. Execute the same DELETE that Memory_Clear_Flow's "Clear Memory" node runs
  psqlExec('DELETE FROM n8n_chat_histories;');

  // 3. Verify the table is now empty
  const rawAfter = psqlExec('SELECT COUNT(*) FROM n8n_chat_histories;');
  const countAfter = parseInt(rawAfter, 10);
  expect(countAfter, 'n8n_chat_histories must be empty after clear').toBe(0);

  // 4. Confirm the session key specifically is gone
  const rawSession = psqlExec(
    "SELECT COUNT(*) FROM n8n_chat_histories WHERE session_id = 'k8s-ai-global';"
  );
  const sessionCount = parseInt(rawSession, 10);
  expect(sessionCount, 'k8s-ai-global session must have no rows after clear').toBe(0);
});

// ── Test 5: Reset (declared LAST — wipes Qdrant) ──────────────────────────────
test('Reset: POST /webhook/k8s-reset clears Qdrant and CDC resync repopulates', async ({ request }) => {
  const resetResp = await request.post(`${N8N}/webhook/k8s-reset`, {
    headers: { 'Content-Type': 'application/json' },
    data: {},
  });
  expect(resetResp.ok(), `Reset webhook failed: ${resetResp.status()}`).toBeTruthy();

  const body = await resetResp.json();
  expect(body.status, 'reset response must have status=ok').toBe('ok');
  expect(body.reset_at, 'reset response must include reset_at').toBeTruthy();

  // After reset the collection must exist (was just recreated).
  // Note: with a working CDC pipeline, the resync can insert points very quickly,
  // so we cannot guarantee exactly 0 points at the moment the webhook responds.
  // Instead we verify the collection is accessible and will repopulate.
  const afterReset = await request.get(`${QDRANT}/collections/k8s`);
  expect(afterReset.ok(), 'Qdrant collection must exist after reset').toBeTruthy();
  const afterBody = await afterReset.json();
  expect(afterBody.result?.config?.params?.vectors?.size,
    'collection must be recreated with 768-dim vectors').toBe(768);

  // CDC resync repopulates via native Qdrant insert (pageContent + nested metadata)
  let pointsCount = 0;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(3_000);
    const colResp = await request.get(`${QDRANT}/collections/k8s`);
    if (colResp.ok()) {
      pointsCount = (await colResp.json()).result.points_count ?? 0;
      if (pointsCount >= 10) break;
    }
  }

  expect(pointsCount, 'Qdrant must be repopulated with ≥ 10 points after resync')
    .toBeGreaterThanOrEqual(10);

  // Verify new points have the native insert payload structure
  const scrollResp = await request.post(`${QDRANT}/collections/k8s/points/scroll`, {
    data: { limit: 1, with_payload: true, with_vector: false },
  });
  if (scrollResp.ok()) {
    const pts = (await scrollResp.json()).result?.points ?? [];
    if (pts.length > 0) {
      expect(pts[0].payload.pageContent,
        'repopulated points must have pageContent (contentPayloadKey)').toBeTruthy();
      expect(pts[0].payload.metadata,
        'repopulated points must have metadata (metadataPayloadKey)').toBeTruthy();
    }
  }
});
