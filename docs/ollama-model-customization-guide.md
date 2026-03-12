# Ollama Model Customization: Complete Technical Guide

> How we built `qwen3:14b-k8s` — a domain-specific Kubernetes assistant model — and how you can customize any Ollama model for your own use case.

---

## Table of Contents

0. [Why Customize? The Problem and the Proof](#0-why-customize-the-problem-and-the-proof)
1. [What is Ollama Model Customization?](#1-what-is-ollama-model-customization)
2. [How LLM Inference Works (Under the Hood)](#2-how-llm-inference-works-under-the-hood)
3. [Ollama Architecture](#3-ollama-architecture)
4. [The Modelfile — Ollama's Dockerfile](#4-the-modelfile--ollamas-dockerfile)
5. [Step-by-Step: Building qwen3:14b-k8s](#5-step-by-step-building-qwen314b-k8s)
6. [Every Modelfile Directive Explained](#6-every-modelfile-directive-explained)
7. [System Prompt Engineering for Domain Models](#7-system-prompt-engineering-for-domain-models)
8. [Inference Parameters Deep Dive](#8-inference-parameters-deep-dive)
9. [How n8n Utilizes the Custom Model](#9-how-n8n-utilizes-the-custom-model)
10. [The RAG Pipeline: Embeddings + Vector Search + LLM](#10-the-rag-pipeline-embeddings--vector-search--llm)
11. [Customization Recipes for Other Domains](#11-customization-recipes-for-other-domains)
12. [Testing and Validating Your Custom Model](#12-testing-and-validating-your-custom-model)
13. [Troubleshooting](#13-troubleshooting)
14. [Appendix: Full Modelfile Reference](#14-appendix-full-modelfile-reference)
15. [Line-by-Line Modelfile Explained](#15-line-by-line-modelfile-explained)

---

## 0. Why Customize? The Problem and the Proof

### The Problem

A base LLM like `qwen3:14b` is a general-purpose model. When you ask it a Kubernetes question, it responds like a textbook — verbose explanations, code blocks, markdown headers, and unpredictable formatting. This makes it **unusable** for:

- **Programmatic consumption** — n8n agents need structured, parseable output
- **Consistent monitoring** — the same query should always return the same format
- **Fast responses** — chain-of-thought reasoning (`<think>` blocks) wastes tokens and time
- **Tool-calling accuracy** — the agent needs to reliably choose the right tool

### The Proof: Before vs After

Here is the **exact same query** sent to both models via the Ollama API:

**Query:** `"List namespaces in a default k8s cluster"`

#### Base Model Output (`qwen3:14b`):

```
To list namespaces in a default Kubernetes cluster, you can use the `kubectl`
command-line tool. Here's how you can do it:

### Command:
```bash
kubectl get namespaces
```

### Output Example:
```bash
NAME              STATUS   AGE
default           Active   3d
kube-public       Active   3d
kube-system       Active   3d
kube-node-lease   Active   3d
```

### Explanation:
- **default**: The default namespace used for most workloads if no other
  namespace is specified.
- **kube-system**: Contains system-level components...
```

**Problems:** Verbose prose, markdown headers, code blocks, explanations — impossible to parse programmatically.

#### Custom Model Output (`qwen3:14b-k8s`):

```
| Namespace | Count |
|---------|------|
| default | 1 |
| kube-system | 1 |
| kube-public | 1 |
| kube-node-lease | 1 |
```

**Result:** Clean markdown table. No headers, no code blocks, no explanations. Directly parseable by n8n, scripts, or any downstream system.

### What Customization Gives You

| Benefit | Base Model | Custom Model |
|---|---|---|
| Output format | Unpredictable (prose, code, headers) | Consistent markdown tables |
| Chain-of-thought | 500+ words of `<think>` reasoning | Suppressed via `/no_think` |
| Determinism | Different output each run (temp=0.7) | Same input = same output (temp=0) |
| Response time | ~15-20s (reasoning + verbose output) | ~5-10s (table only, fewer tokens) |
| Tool calling | Works but unreliable without guidance | System prompt guides tool selection |
| Parseable by code | No — needs regex/NLP to extract data | Yes — standard markdown table |
| Disk space cost | N/A | Zero extra (shares base model weights) |
| Build time | N/A | 0.040 seconds |

### How to Reproduce This Comparison

```bash
# Test the base model
curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3:14b",
  "messages": [{"role":"user","content":"List namespaces in a default k8s cluster"}],
  "stream": false, "think": false
}' | python3 -c "import sys,json; print(json.load(sys.stdin)['message']['content'])"

# Test the custom model
curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3:14b-k8s",
  "messages": [{"role":"user","content":"List namespaces in a default k8s cluster"}],
  "stream": false, "think": false
}' | python3 -c "import sys,json; print(json.load(sys.stdin)['message']['content'])"
```

### Hands-On Tutorial Script

To build the custom model yourself step-by-step with live output comparisons:

```bash
./models/build-custom-model.sh
```

This interactive script walks through every step: pulling the base model, creating the Modelfile, building, comparing outputs, and testing tool-calling — all with explanations.

---

## 1. What is Ollama Model Customization?

Ollama model customization is **NOT fine-tuning or retraining**. The model weights remain identical to the base model. Instead, you create a new model identity that bundles:

| What Changes | What Stays the Same |
|---|---|
| System prompt (persona/instructions) | Neural network weights (billions of parameters) |
| Inference parameters (temperature, top_k) | Tokenizer vocabulary |
| Template format (chat structure) | Model architecture (transformer layers) |
| Stop tokens | Training data knowledge |
| Context window size | Language understanding |

Think of it like this:

```
┌─────────────────────────────────────────────────┐
│  qwen3:14b  (base model = the brain)            │
│  ┌───────────────────────────────────────────┐   │
│  │  14 billion parameters                    │   │
│  │  Pre-trained on massive text corpus       │   │
│  │  General-purpose knowledge                │   │
│  └───────────────────────────────────────────┘   │
│                     +                            │
│  ┌───────────────────────────────────────────┐   │
│  │  Modelfile (the configuration)            │   │
│  │  ┌─────────────────────────────────────┐  │   │
│  │  │ SYSTEM: "You are a K8s assistant"   │  │   │
│  │  │ PARAMETER temperature 0             │  │   │
│  │  │ PARAMETER num_ctx 32768             │  │   │
│  │  │ TEMPLATE: chat format               │  │   │
│  │  └─────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────┘   │
│                     =                            │
│          qwen3:14b-k8s (custom model)            │
└─────────────────────────────────────────────────┘
```

**Key insight:** The custom model is a thin wrapper. It occupies zero additional disk space for weights — Ollama stores a single copy of the base weights and layers the Modelfile config on top.

---

## 2. How LLM Inference Works (Under the Hood)

Understanding inference helps you tune parameters intelligently.

### 2.1 Tokenization

The input text is split into tokens (subword units):

```
Input:  "Kubernetes Deployment named coredns"
Tokens: ["Kuber", "netes", " Deploy", "ment", " named", " core", "dns"]
         [48291]  [17352]  [43891]   [1326]  [7086]   [6254]  [12847]
```

Each token maps to an integer ID. The model only sees numbers, never raw text.

### 2.2 The Forward Pass (Simplified)

```
Token IDs → Embedding Layer → [Transformer Block × 48 layers] → Logits
                                     │
                                     ├── Multi-Head Self-Attention
                                     │   (each token attends to all previous tokens)
                                     │
                                     └── Feed-Forward Network
                                         (processes each position independently)
```

For `qwen3:14b`:
- **48 transformer layers** (decoder blocks)
- **40 attention heads** (each head learns different relationships)
- **5120-dimensional hidden state** per token
- **~14 billion trainable parameters** total

### 2.3 Token Generation (Autoregressive)

The model generates one token at a time:

```
Step 1: [system prompt + user query]          → predicts token_1
Step 2: [system prompt + user query + token_1] → predicts token_2
Step 3: [... + token_1 + token_2]              → predicts token_3
...until stop token or num_predict limit
```

At each step, the model outputs a **probability distribution** over its entire vocabulary (~152,000 tokens for Qwen3):

```
Vocabulary Logits (raw scores):
  "Deployment" → 8.7     ← highest score
  "deployment" → 8.1
  "Service"    → 4.2
  "the"        → 2.1
  "cat"        → -3.4
  ...

After Softmax → Probabilities:
  "Deployment" → 0.42
  "deployment" → 0.28
  "Service"    → 0.05
  "the"        → 0.006
  "cat"        → 0.00001
```

### 2.4 Sampling Strategy

How the next token is selected from these probabilities:

```
                    Logits from model
                          │
                          ▼
              ┌───── Temperature ─────┐
              │  Scale the logits     │
              │  temp=0 → argmax      │
              │  temp=1 → as-is       │
              │  temp>1 → more random │
              └───────────┬───────────┘
                          │
                          ▼
              ┌──────── Top-K ────────┐
              │  Keep only top K      │
              │  tokens by score      │
              │  (K=20 in our model)  │
              └───────────┬───────────┘
                          │
                          ▼
              ┌──────── Top-P ────────┐
              │  Keep tokens until    │
              │  cumulative prob ≥ P  │
              │  (P=0.95 in ours)     │
              └───────────┬───────────┘
                          │
                          ▼
              ┌─── Repeat Penalty ───┐
              │  Penalize tokens     │
              │  already generated   │
              │  (1.0 = no penalty)  │
              └───────────┬──────────┘
                          │
                          ▼
                  Selected Token
```

**With temperature=0** (our model): The sampling is bypassed entirely — the highest-probability token is always chosen (greedy/argmax decoding). This gives deterministic, reproducible output.

### 2.5 The KV Cache

During generation, the model caches key-value pairs from attention layers to avoid recomputing them:

```
Without KV Cache:
  Step 1: Process [A, B, C]        → predict D  (3 tokens processed)
  Step 2: Process [A, B, C, D]     → predict E  (4 tokens processed)
  Step 3: Process [A, B, C, D, E]  → predict F  (5 tokens processed)
  Total: 3+4+5 = 12 token-computations

With KV Cache:
  Step 1: Process [A, B, C]    → cache KV for A,B,C → predict D  (3 new)
  Step 2: Process [D]          → cache KV for D     → predict E  (1 new)
  Step 3: Process [E]          → cache KV for E     → predict F  (1 new)
  Total: 3+1+1 = 5 token-computations
```

The `num_ctx` parameter (32768 in our model) determines the maximum KV cache size — the total number of tokens the model can "remember" during a single inference call.

---

## 3. Ollama Architecture

Ollama is a local LLM runtime that wraps `llama.cpp` (C++ inference engine for GGUF model files):

```
┌─────────────────────────────────────────────────────────┐
│  Your Application (n8n, curl, Python, etc.)             │
│  POST http://localhost:11434/api/chat                   │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP REST API
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Ollama Server (Go binary)                              │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Model Registry    │ Scheduler      │ API Router   │  │
│  │ ~/.ollama/models/ │ Queue requests │ /api/chat    │  │
│  │ Manifests + Blobs │ Manage VRAM    │ /api/generate│  │
│  │ Layer dedup       │ Load/unload    │ /api/embed   │  │
│  └───────────────────────────────────────────────────┘  │
│                       │                                  │
│                       ▼                                  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ llama.cpp Engine (C++)                            │  │
│  │ ┌─────────┐ ┌──────────┐ ┌─────────────────────┐ │  │
│  │ │ GGUF    │ │ KV Cache │ │ Compute Backend     │ │  │
│  │ │ Loader  │ │ Manager  │ │ Metal/CUDA/CPU      │ │  │
│  │ └─────────┘ └──────────┘ └─────────────────────┘ │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼
           ┌──────────────────────┐
           │  Hardware            │
           │  GPU (Metal/CUDA)    │
           │  or CPU (AVX2/NEON)  │
           │  RAM: ~10GB for 14B  │
           └──────────────────────┘
```

### Storage Layout

```
~/.ollama/models/
├── manifests/
│   └── registry.ollama.ai/
│       └── library/
│           ├── qwen3/14b           ← base model manifest
│           └── qwen3/14b-k8s      ← custom model manifest (tiny JSON file)
└── blobs/
    ├── sha256-a8cc1361f3...       ← model weights (~9.3GB, SHARED between both)
    ├── sha256-<template-hash>     ← chat template
    ├── sha256-<system-hash>       ← system prompt (custom)
    └── sha256-<params-hash>       ← parameters (custom)
```

**Important:** `qwen3:14b-k8s` does NOT duplicate the 9.3GB weights file. The manifest just points to the same blob as `qwen3:14b`, plus additional small blobs for the custom template, system prompt, and parameters.

---

## 4. The Modelfile — Ollama's Dockerfile

A Modelfile is to Ollama what a Dockerfile is to Docker — a declarative recipe for building a model image.

### Syntax Overview

```dockerfile
# Base model (required — first line)
FROM qwen3:14b

# System prompt — injected before every conversation
SYSTEM """
Your instructions here
"""

# Chat template — how messages are formatted for the model
TEMPLATE """
{{ template syntax }}
"""

# Inference parameters — control generation behavior
PARAMETER temperature 0
PARAMETER num_ctx 32768
PARAMETER num_predict 1024
PARAMETER top_k 20
PARAMETER top_p 0.95
PARAMETER repeat_penalty 1
PARAMETER stop <|im_start|>
PARAMETER stop <|im_end|>

# License (optional)
LICENSE """Apache 2.0..."""

# Adapter (optional — for actual fine-tuned LoRA weights)
# ADAPTER ./path-to-lora-weights.gguf
```

---

## 5. Step-by-Step: Building qwen3:14b-k8s

### Step 1: Choose the Base Model

Pick a base model from the [Ollama model library](https://ollama.com/library):

```bash
# See available models
ollama list

# Pull the base model if not already present
ollama pull qwen3:14b
```

**Why qwen3:14b?**
- 14B parameters — sweet spot between capability and speed
- Excellent instruction following and structured output
- Native tool-calling support (function calling)
- 32K context window
- Apache 2.0 license (commercial use OK)

### Step 2: Create the Modelfile

Create a file named `Modelfile.k8s` (any name works):

```bash
cat > Modelfile.k8s << 'MODELFILE_EOF'
FROM qwen3:14b

SYSTEM """
/no_think
You are a concise Kubernetes cluster assistant.
STRICT OUTPUT RULES:
- Output ONLY markdown tables. Nothing else.
- For counting queries: | Namespace | Count |
- For listing queries: | Kind | Name | Namespace | Details |
- NEVER output section headers (###), bullet lists, recommendations, or verbose text.
- NEVER hallucinate or invent resource names. Only use data from tool results.
- Maximum one summary sentence after the table.
"""

PARAMETER temperature 0
PARAMETER num_ctx 32768
PARAMETER num_predict 1024
PARAMETER top_k 20
PARAMETER top_p 0.95
PARAMETER repeat_penalty 1
PARAMETER stop <|im_start|>
PARAMETER stop <|im_end|>
MODELFILE_EOF
```

### Step 3: Build the Custom Model

```bash
ollama create qwen3:14b-k8s -f Modelfile.k8s
```

Output:

```
transferring model data ██████████████████████████████████ 100%
using existing layer sha256:a8cc1361f3...    ← reuses base weights (no copy)
creating new layer sha256:7f2d1e3a4b...     ← system prompt (few KB)
creating new layer sha256:9c4b8e2f1a...     ← parameters (few KB)
writing manifest
success
```

**Time:** Under 5 seconds (no weights are copied or modified).

### Step 4: Verify the Custom Model

```bash
# List all models — both should appear
ollama list | grep qwen3

# Expected output:
# qwen3:14b-k8s    341bed557d58    9.3 GB    just now
# qwen3:14b        bdbd181c33f2    9.3 GB    4 days ago

# Test it interactively
ollama run qwen3:14b-k8s "List 3 Kubernetes resource types"
```

### Step 5: Inspect the Custom Model

```bash
# View the complete Modelfile (including template inherited from base)
ollama show qwen3:14b-k8s --modelfile

# View just the system prompt
ollama show qwen3:14b-k8s --system

# View model metadata
ollama show qwen3:14b-k8s --parameters
```

### Step 6: Iterate

If the output isn't what you want, edit the Modelfile and rebuild:

```bash
# Edit system prompt or parameters
vim Modelfile.k8s

# Rebuild (overwrites the previous version)
ollama create qwen3:14b-k8s -f Modelfile.k8s

# Test again
ollama run qwen3:14b-k8s "How many namespaces exist?"
```

Rebuilding is near-instant since only the config layers change.

---

## 6. Every Modelfile Directive Explained

### FROM (Required)

```dockerfile
FROM qwen3:14b          # From Ollama library
FROM ./local-model.gguf  # From a local GGUF file
FROM qwen3:14b-k8s       # From another custom model (layering)
```

### SYSTEM

The system prompt is prepended to every conversation. It defines the model's persona, rules, and output format.

```dockerfile
SYSTEM """
You are a Kubernetes assistant.
Only output markdown tables.
"""
```

**How it works internally:** The system text is inserted as the first message in the chat template with `role: system`. The model sees it before any user input and treats it as persistent instructions.

### TEMPLATE

The chat template controls how messages are formatted before being sent to the model. Ollama uses Go's `text/template` syntax.

```dockerfile
TEMPLATE """
{{- if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}
{{- range .Messages }}
<|im_start|>{{ .Role }}
{{ .Content }}<|im_end|>
{{ end }}
<|im_start|>assistant
"""
```

**When to customize:** Usually you DON'T need to — the base model's template is correct. Only customize if you need to modify tool-calling format or add special directives like `/no_think`.

**Qwen3's template includes:**
- `<|im_start|>` / `<|im_end|>` delimiters (ChatML format)
- Tool-calling support via `<tool_call>` / `<tool_response>` XML tags
- Think/no_think toggle for chain-of-thought control
- Proper handling of multi-turn conversations

### PARAMETER

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `temperature` | 0.8 | 0.0–2.0 | Randomness. 0=deterministic, higher=more creative |
| `num_ctx` | 2048 | 512–131072 | Context window (tokens). More = more memory |
| `num_predict` | -1 | -1 to ∞ | Max output tokens. -1=unlimited |
| `top_k` | 40 | 1–100 | Sample from top K tokens only |
| `top_p` | 0.9 | 0.0–1.0 | Nucleus sampling (cumulative probability cutoff) |
| `repeat_penalty` | 1.1 | 0.0–2.0 | Penalize repeated tokens. 1.0=no penalty |
| `stop` | (model default) | any string | Stop generation when this string is produced |
| `seed` | -1 | any int | Random seed for reproducibility. -1=random |
| `num_gpu` | (auto) | 0–999 | Number of GPU layers to offload |
| `num_thread` | (auto) | 1–N | CPU threads for computation |
| `mirostat` | 0 | 0, 1, 2 | Mirostat sampling (perplexity-targeting) |
| `mirostat_tau` | 5.0 | 0.0–10.0 | Target perplexity for mirostat |
| `mirostat_eta` | 0.1 | 0.0–1.0 | Mirostat learning rate |

### ADAPTER (Advanced — Actual Fine-Tuning)

```dockerfile
# Load LoRA adapter weights on top of base model
ADAPTER ./my-lora-adapter.gguf
```

This is the only directive that modifies model behavior at the weight level. LoRA adapters are small (~1-5% of model size) trained weight deltas. Creating them requires actual GPU training (see Section 11).

### LICENSE

```dockerfile
LICENSE """Apache License 2.0..."""
```

Metadata only — doesn't affect inference.

---

## 7. System Prompt Engineering for Domain Models

The system prompt is the most impactful customization. Here's how we engineered it for K8s:

### Design Principles

```
┌───────────────────────────────────────────────────────┐
│              System Prompt Design                      │
│                                                        │
│   1. ROLE         → "You are a K8s assistant"          │
│   2. CONSTRAINTS  → "Output ONLY tables"               │
│   3. FORMAT       → "| Kind | Name | Namespace |"      │
│   4. SAFETY       → "NEVER hallucinate"                 │
│   5. BREVITY      → "Maximum one summary sentence"      │
│   6. DIRECTIVES   → "/no_think" (suppress reasoning)    │
└───────────────────────────────────────────────────────┘
```

### The `/no_think` Directive

Qwen3 has a built-in chain-of-thought mode. By default, it wraps responses in `<think>...</think>` blocks:

```
# WITHOUT /no_think:
<think>
The user is asking about deployments. I should query the vector store
for deployment resources. Let me formulate a search query...
The results show 3 deployments: coredns, kafka, and qdrant...
I should format this as a table...
</think>

| Name | Namespace | Replicas |
|------|-----------|----------|
| coredns | kube-system | 2 |
...
```

```
# WITH /no_think:
| Name | Namespace | Replicas |
|------|-----------|----------|
| coredns | kube-system | 2 |
...
```

The `/no_think` directive is placed in TWO locations for maximum reliability:

1. **Modelfile SYSTEM prompt** — baked into the model config
2. **n8n AI Agent system message** — sent at runtime with each conversation

Additionally, the n8n deployment patches the LangChain Ollama node to pass `think: false` at the API level:

```javascript
// Patched in n8n-deployment.yaml startup command:
const model = new ollama_1.ChatOllama({ think: false, ...otherOptions })
```

This triple-layer approach (`/no_think` in system + `/no_think` in agent prompt + `think:false` in API) ensures the model never outputs chain-of-thought in production.

### The Two-Layer System Prompt

Our model has TWO system prompts that work together:

**Layer 1: Modelfile SYSTEM (baked into model)**

```
/no_think
You are a concise Kubernetes cluster assistant.
STRICT OUTPUT RULES:
- Output ONLY markdown tables. Nothing else.
- For counting queries: | Namespace | Count |
- For listing queries: | Kind | Name | Namespace | Details |
- NEVER output section headers, bullet lists, recommendations
- NEVER hallucinate or invent resource names
- Maximum one summary sentence after the table.
```

**Layer 2: n8n Agent System Message (sent at runtime)**

```
You are a Kubernetes cluster monitoring assistant for the kind cluster "k8s-ai".

/no_think

You have TWO tools. You MUST call a tool before EVERY answer.

## Tool Selection
**kubernetes_inventory** — ALWAYS use this when:
- Counting ("how many pods?")
- Listing ALL resources of a type
- Aggregation ("resources per namespace")
- Follow-up questions about counted resources

**kubernetes_search** — Use this ONLY when:
- ONE specific named resource ("show me the coredns deployment")
- Searching by label
- Deep details about a single resource

## Critical Rules
1. ALWAYS call a tool before answering
2. When in doubt, use kubernetes_inventory
3. NEVER invent resources, names, or counts
4. Output concise markdown tables
```

**Why two layers?**

| Layer | Purpose | When it applies |
|-------|---------|-----------------|
| Modelfile SYSTEM | Base behavior, output format | Every inference call (even direct API) |
| n8n Agent prompt | Tool selection, RAG rules | Only when called via n8n agent |

If someone calls the model directly via `ollama run qwen3:14b-k8s`, they still get the table-only output format. The n8n layer adds tool-calling intelligence on top.

---

## 8. Inference Parameters Deep Dive

### Why We Chose These Specific Values

#### `temperature 0` — Deterministic Output

```
temperature = 0:
  Logits: [8.7, 8.1, 4.2, 2.1, -3.4]
  After temp scaling: argmax → always pick "Deployment" (8.7)
  Same input → ALWAYS same output

temperature = 0.7:
  Logits scaled: [12.4, 11.6, 6.0, 3.0, -4.9]
  Softmax: [0.58, 0.32, 0.05, 0.03, 0.00]
  "Deployment" picked ~58% of the time

temperature = 1.5:
  Logits scaled: [5.8, 5.4, 2.8, 1.4, -2.3]
  Softmax: [0.31, 0.24, 0.12, 0.08, 0.02]
  More varied output, occasional oddities
```

For a Kubernetes monitoring tool, determinism is critical — the same query should always produce the same answer.

#### `num_ctx 32768` — 32K Context Window

Context budget breakdown for a typical query:

```
┌──────────────────────────────────────────────┐
│ 32,768 tokens total context                  │
├──────────────────────────────────────────────┤
│ System prompt (Modelfile + Agent)  ~500 tok  │
│ Chat history (5 turns × ~200)    ~1,000 tok  │
│ Tool results (Qdrant scroll ALL) ~25,000 tok │
│ Current query                       ~50 tok  │
│ Response generation budget        ~6,218 tok │
└──────────────────────────────────────────────┘
```

The `kubernetes_inventory` tool scrolls ALL Qdrant points (~150+ resources), which can generate 20,000+ tokens of context. Without 32K, the model would truncate results and give incomplete answers.

**Memory cost:** ~10GB RAM for 14B model with 32K context (KV cache scales linearly with `num_ctx`).

#### `num_predict 1024` — Response Length Limit

Prevents the model from generating excessively long responses. A markdown table with 20 rows typically requires ~300-500 tokens.

#### `top_k 20` and `top_p 0.95`

With `temperature 0`, these are effectively ignored (argmax always picks the single highest-probability token). They serve as safety nets if the temperature is ever changed:

- `top_k 20`: Consider only the top 20 candidate tokens
- `top_p 0.95`: Within those 20, only keep tokens until cumulative probability reaches 95%

#### `repeat_penalty 1` — No Repetition Penalty

Set to 1.0 (disabled) because:
- Table output naturally repeats column separators (`|`) and common words
- A penalty would corrupt table formatting
- Deterministic decoding (temp=0) doesn't produce runaway repetition

#### Stop Tokens: `<|im_start|>` and `<|im_end|>`

These are Qwen3's ChatML delimiters. Setting them as stop tokens ensures the model stops generating when it tries to start a new chat turn:

```
<|im_start|>assistant
| Name | Namespace | Replicas |
| coredns | kube-system | 2 |
| kafka | k8s-ai | 1 |
<|im_end|>            ← STOP HERE (don't generate user turn)
```

---

## 9. How n8n Utilizes the Custom Model

### The Multi-Tool Agent Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  n8n AI_K8s_Flow Workflow                                       │
│                                                                  │
│  ┌──────────┐    ┌─────────────────────────────────────────┐    │
│  │  Chat    │    │  AI Agent (toolsAgent)                  │    │
│  │  Trigger │───▶│  maxIterations: 5                       │    │
│  │          │    │                                          │    │
│  │  Input:  │    │  ┌──────────────┐  ┌──────────────────┐ │    │
│  │  chatInput    │  │ Ollama Chat  │  │ Postgres Chat    │ │    │
│  └──────────┘    │  │ Model        │  │ Memory           │ │    │
│                  │  │              │  │                   │ │    │
│                  │  │ qwen3:       │  │ session:          │ │    │
│                  │  │ 14b-k8s     │  │ k8s-ai-global    │ │    │
│                  │  │ temp: 0     │  │ window: 5 turns  │ │    │
│                  │  │ ctx: 32768  │  │                   │ │    │
│                  │  └──────────────┘  └──────────────────┘ │    │
│                  │                                          │    │
│                  │  Tools:                                   │    │
│                  │  ┌──────────────────────────────────────┐ │    │
│                  │  │ kubernetes_inventory (Code Tool)     │ │    │
│                  │  │ → HTTP scroll ALL from Qdrant        │ │    │
│                  │  │ → Group by kind + namespace           │ │    │
│                  │  │ → Returns structured summary          │ │    │
│                  │  ├──────────────────────────────────────┤ │    │
│                  │  │ kubernetes_search (Qdrant Vector)    │ │    │
│                  │  │ → Embed query via nomic-embed-text   │ │    │
│                  │  │ → Cosine similarity search            │ │    │
│                  │  │ → topK: 20 results                    │ │    │
│                  │  └──────────────────────────────────────┘ │    │
│                  └─────────────────────────────────────────┘    │
│                                    │                             │
│                                    ▼                             │
│                           Markdown Response                      │
└─────────────────────────────────────────────────────────────────┘
```

### Ollama Credential Configuration

n8n connects to Ollama via a stored credential:

```json
{
  "id": "ollama-local",
  "name": "Ollama Local",
  "type": "ollamaApi",
  "data": {
    "baseUrl": "http://host.docker.internal:11434"
  }
}
```

Pods inside the kind cluster reach the host machine's Ollama via:

```yaml
# n8n-deployment.yaml
hostAliases:
  - ip: "192.168.1.154"      # Host machine's LAN IP
    hostnames:
      - "host.docker.internal"
```

### The think:false Runtime Patch

n8n's built-in Ollama Chat Model node doesn't expose Qwen3's `think` parameter. We patch it at container startup:

```bash
# In n8n-deployment.yaml command:
OLLAMA_FILE=$(find /usr/local/lib/node_modules/n8n \
  -path "*/LMChatOllama/LmChatOllama.node.js" 2>/dev/null | head -1)

sed -i "s/const model = new ollama_1.ChatOllama({/\
  const model = new ollama_1.ChatOllama({ think: false,/" "$OLLAMA_FILE"
```

This modifies the LangChain ChatOllama constructor to always pass `think: false`, which tells the Ollama API to suppress `<think>` blocks at the protocol level.

### How the Agent Decides Which Tool to Call

The LLM sees the tool descriptions and decides based on the query:

```
User: "How many pods are in each namespace?"

Model reasoning (internal, not shown due to /no_think):
→ This is a counting/aggregation query
→ System prompt says: counting → kubernetes_inventory
→ Generate tool call:

<tool_call>
{"name": "kubernetes_inventory", "arguments": {}}
</tool_call>

Tool returns: (structured inventory of all resources)

Model then formats the response as a table:
| Namespace | Pod Count |
|-----------|-----------|
| kube-system | 8 |
| k8s-ai | 6 |
```

---

## 10. The RAG Pipeline: Embeddings + Vector Search + LLM

### How Data Flows from Kubernetes to AI Answers

```
Phase 1: INDEXING (CDC Pipeline — runs continuously)
═══════════════════════════════════════════════════

K8s API ──watch──▶ k8s-watcher ──publish──▶ Kafka ──trigger──▶ n8n CDC Flow
                        │                                           │
                        │  obj_to_payload()                         │
                        │  embed_text = "Kubernetes                 │
                        │    Deployment named coredns               │
                        │    in namespace kube-system.              │
                        │    Labels: k8s-app=kube-dns"              │
                        │                                           ▼
                        │                                    ┌──────────────┐
                        │                                    │ Ollama API   │
                        │                                    │ /api/embed   │
                        │                                    │ nomic-embed  │
                        │                                    │ -text        │
                        │                                    └──────┬───────┘
                        │                                           │
                        │                              768-dim float vector
                        │                                           │
                        │                                           ▼
                        │                                    ┌──────────────┐
                        │                                    │   Qdrant     │
                        │                                    │ Collection:  │
                        │                                    │   k8s        │
                        │                                    │ Point ID:    │
                        │                                    │ resource_uid │
                        └────────────────────────────────────┘   (UUID)     │
                                                             └──────────────┘

Phase 2: QUERYING (AI Pipeline — on user request)
═════════════════════════════════════════════════

User: "Show me all deployments"
          │
          ▼
   ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
   │ n8n Chat     │─────▶│ AI Agent     │─────▶│ Tool Call:   │
   │ Trigger      │      │ qwen3:14b-k8s│      │ k8s_search   │
   └──────────────┘      └──────────────┘      └──────┬───────┘
                                                       │
                         ┌─────────────────────────────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ Embed Query  │   "Show me all deployments"
                  │ nomic-embed  │ → [0.12, -0.34, 0.78, ...]
                  │ -text        │   768-dim vector
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ Qdrant       │   Cosine similarity search
                  │ topK: 20    │   Score threshold: 0.3
                  │              │
                  │ Results:     │   score=0.67: Deployment/coredns
                  │              │   score=0.61: Deployment/kafka
                  │              │   score=0.43: Deployment/qdrant
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ AI Agent     │   Receives tool results
                  │ qwen3:14b-k8s│   Formats as markdown table
                  │              │
                  │ Output:      │   | Name | Namespace | Replicas |
                  │              │   |------|-----------|----------|
                  │              │   | coredns | kube-system | 2 |
                  └──────────────┘
```

### The Embedding Model: nomic-embed-text

| Property | Value |
|----------|-------|
| Model | `nomic-embed-text:latest` |
| Dimensions | 768 |
| Similarity Metric | Cosine |
| Score Range for K8s Data | 0.38–0.70 |
| Score Threshold | 0.3 |
| Max Sequence Length | 8192 tokens |
| Size | ~274 MB |

### Natural Language Embedding Format

The embedding text format is critical for search quality:

```python
# GOOD (natural language — what we use):
embed_text = "Kubernetes Deployment named coredns in namespace kube-system. "
             "Labels: k8s-app=kube-dns. "
             "Spec: {\"replicas\": 2, \"containers\": [{\"name\": \"coredns\"}]}"

# BAD (terse key-value — lower similarity scores):
embed_text = "kind:Deployment name:coredns ns:kube-system labels:k8s-app=kube-dns"
```

The natural language format matches how users phrase queries ("Show me the coredns deployment in kube-system"), resulting in higher cosine similarity scores.

---

## 11. Customization Recipes for Other Domains

### Recipe 1: SQL Database Assistant

```dockerfile
FROM qwen3:14b

SYSTEM """
/no_think
You are a PostgreSQL database assistant.
RULES:
- Always write standard PostgreSQL SQL (not MySQL syntax)
- Output queries in ```sql code blocks
- Explain query plans when asked
- NEVER use DROP, TRUNCATE, or DELETE without WHERE clause
- Always suggest adding indexes for slow queries
- Maximum 3 sentences of explanation after the SQL
"""

PARAMETER temperature 0
PARAMETER num_ctx 16384
PARAMETER num_predict 2048
PARAMETER stop <|im_start|>
PARAMETER stop <|im_end|>
```

```bash
ollama create qwen3:14b-sql -f Modelfile.sql
```

### Recipe 2: Code Review Assistant

```dockerfile
FROM qwen3:14b

SYSTEM """
/no_think
You are a senior code reviewer. For each issue found:
1. State the file and line
2. Describe the problem in one sentence
3. Show the fix as a diff

Categories: BUG, SECURITY, PERFORMANCE, STYLE
Only flag real issues. Do not nitpick formatting.
"""

PARAMETER temperature 0.1
PARAMETER num_ctx 32768
PARAMETER num_predict 4096
PARAMETER stop <|im_start|>
PARAMETER stop <|im_end|>
```

### Recipe 3: Creative Writing Assistant

```dockerfile
FROM qwen3:14b

SYSTEM """
You are a creative fiction writer. Write vivid, engaging prose
with strong sensory details. Vary sentence length and structure.
Show, don't tell.
"""

PARAMETER temperature 0.9
PARAMETER num_ctx 8192
PARAMETER num_predict 4096
PARAMETER top_k 50
PARAMETER top_p 0.95
PARAMETER repeat_penalty 1.15
PARAMETER stop <|im_start|>
PARAMETER stop <|im_end|>
```

Note: Higher temperature (0.9), higher top_k (50), and repeat_penalty (1.15) for creative variety.

### Recipe 4: Using a Smaller Model (Resource-Constrained)

```dockerfile
FROM qwen3:8b

SYSTEM """
/no_think
You are a Kubernetes assistant. Output markdown tables only.
"""

PARAMETER temperature 0
PARAMETER num_ctx 8192
PARAMETER num_predict 512
PARAMETER stop <|im_start|>
PARAMETER stop <|im_end|>
```

```bash
ollama create qwen3:8b-k8s -f Modelfile.8b-k8s
```

### Recipe 5: Using LoRA Fine-Tuning (Advanced)

If you need the model to learn NEW knowledge (not just follow different instructions), you need actual fine-tuning:

```
Step 1: Prepare training data (JSONL format)
──────────────────────────────────────────
{"messages": [
  {"role": "system", "content": "You are a K8s assistant"},
  {"role": "user", "content": "What is a DaemonSet?"},
  {"role": "assistant", "content": "| Property | Value |\n|---|---|\n| Type | Workload Controller |\n| Scheduling | One pod per node |"}
]}

Step 2: Fine-tune with a framework (e.g., unsloth, axolotl)
──────────────────────────────────────────────────────────
pip install unsloth
python train.py \
  --model qwen3:14b \
  --data training_data.jsonl \
  --output ./lora-adapter \
  --epochs 3 \
  --lr 2e-4 \
  --lora_r 16

Step 3: Convert to GGUF
───────────────────────
python convert_lora_to_gguf.py ./lora-adapter

Step 4: Create Modelfile with adapter
──────────────────────────────────────
FROM qwen3:14b
ADAPTER ./lora-adapter.gguf
SYSTEM "..."
PARAMETER temperature 0

Step 5: Build
─────────────
ollama create qwen3:14b-k8s-finetuned -f Modelfile.finetuned
```

**When to fine-tune vs. when to customize:**

| Use Modelfile Customization When | Use LoRA Fine-Tuning When |
|---|---|
| You want different output format | Model lacks domain knowledge |
| You want different personality | You need new factual recall |
| You want specific parameters | Output quality is insufficient |
| Zero additional training cost | You have training data (100+ examples) |
| Instant iteration | Hours of GPU time acceptable |

---

## 12. Testing and Validating Your Custom Model

### Test 1: Direct CLI Test

```bash
# Basic functionality
ollama run qwen3:14b-k8s "List 3 Kubernetes namespaces"

# Expected: clean markdown table, no thinking blocks, no verbose text
```

### Test 2: API Test (Same as n8n Uses)

```bash
curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3:14b-k8s",
  "messages": [
    {"role": "user", "content": "How many pods are in kube-system?"}
  ],
  "stream": false
}' | python3 -m json.tool
```

### Test 3: Verify No Think Blocks

```bash
# Should NOT contain <think> tags
ollama run qwen3:14b-k8s "What deployments exist?" 2>&1 | grep -c "<think>"
# Expected: 0
```

### Test 4: Tool-Calling Format Test

```bash
curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3:14b-k8s",
  "messages": [
    {"role": "user", "content": "How many pods exist?"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "kubernetes_inventory",
        "description": "Get all K8s resources grouped by kind and namespace",
        "parameters": {"type": "object", "properties": {}}
      }
    }
  ],
  "stream": false
}' | python3 -c "import sys,json; r=json.load(sys.stdin); print(json.dumps(r.get('message',{}), indent=2))"
```

### Test 5: End-to-End via n8n

```bash
curl -s -X POST http://localhost:30000/webhook/k8s-ai-chat/chat \
  -H 'Content-Type: application/json' \
  -d '{"chatInput": "Show me all deployments and their replica counts"}' | \
  python3 -m json.tool
```

### Test 6: Automated E2E Suite

```bash
npm test   # All 15 Playwright tests
```

---

## 13. Troubleshooting

### Model Not Found

```
Error: model "qwen3:14b-k8s" not found
```

**Fix:** Rebuild the model:
```bash
ollama create qwen3:14b-k8s -f Modelfile.k8s
```

### Think Blocks Appearing in Output

```
<think>Let me analyze this query...</think>
```

**Fix:** Ensure all three layers are in place:
1. `/no_think` in Modelfile SYSTEM
2. `/no_think` in n8n Agent system message
3. `think: false` patch in n8n deployment

### Slow Response Times

| Symptom | Cause | Fix |
|---------|-------|-----|
| First query slow (~30s) | Model loading into memory | Normal — subsequent queries are fast |
| All queries slow | Insufficient RAM | Reduce `num_ctx` or use smaller model |
| Queries queue up | `OLLAMA_NUM_PARALLEL=1` | Expected — Ollama serializes requests |

### Out of Memory

```
Error: out of memory
```

**Fix:** Reduce context window:
```dockerfile
PARAMETER num_ctx 8192    # Instead of 32768
```

Or use a smaller model:
```dockerfile
FROM qwen3:8b             # Instead of qwen3:14b
```

**Memory requirements:**

| Model | num_ctx | Approximate RAM |
|-------|---------|-----------------|
| qwen3:8b | 8192 | ~6 GB |
| qwen3:8b | 32768 | ~8 GB |
| qwen3:14b | 8192 | ~10 GB |
| qwen3:14b | 32768 | ~14 GB |

### Qdrant Returns No Results

Check the score threshold and embedding model:
```bash
# Verify embedding model is running
curl http://localhost:11434/api/tags | python3 -c \
  "import sys,json; [print(m['name']) for m in json.load(sys.stdin)['models']]"

# Check Qdrant point count
curl http://localhost:30001/collections/k8s | python3 -c \
  "import sys,json; print('Points:', json.load(sys.stdin)['result']['points_count'])"
```

---

## 14. Appendix: Full Modelfile Reference

### Complete Modelfile for qwen3:14b-k8s

```dockerfile
FROM qwen3:14b

SYSTEM """
/no_think
You are a concise Kubernetes cluster assistant.
STRICT OUTPUT RULES:
- Output ONLY markdown tables. Nothing else.
- For counting queries: | Namespace | Count |
- For listing queries: | Kind | Name | Namespace | Details |
- NEVER output section headers (###), bullet lists, recommendations, or verbose text.
- NEVER hallucinate or invent resource names. Only use data from tool results.
- Maximum one summary sentence after the table.
"""

PARAMETER temperature 0
PARAMETER num_ctx 32768
PARAMETER num_predict 1024
PARAMETER top_k 20
PARAMETER top_p 0.95
PARAMETER repeat_penalty 1
PARAMETER stop <|im_start|>
PARAMETER stop <|im_end|>
```

### Build Command

```bash
ollama create qwen3:14b-k8s -f Modelfile.k8s
```

### Verify

```bash
ollama show qwen3:14b-k8s --modelfile
ollama run qwen3:14b-k8s "List Kubernetes resource types as a table"
```

---

## 15. Line-by-Line Modelfile Explained

This section walks through every line of `models/Modelfile.k8s` and explains **what it does technically** and **what observable change it produces**.

### The Complete Modelfile

```dockerfile
FROM qwen3:14b                          # Line 1

SYSTEM """                               # Line 3
/no_think                                # Line 4
You are a concise Kubernetes cluster assistant.  # Line 5
STRICT OUTPUT RULES:                     # Line 6
- Output ONLY markdown tables. Nothing else.     # Line 7
- For counting queries: | Namespace | Count |    # Line 8
- For listing queries: | Kind | Name | Namespace | Details |  # Line 9
- NEVER output section headers (###), bullet lists, recommendations, or verbose text.  # Line 10
- NEVER hallucinate or invent resource names. Only use data from tool results.          # Line 11
- Maximum one summary sentence after the table.  # Line 12
"""                                      # Line 13

PARAMETER temperature 0                  # Line 15
PARAMETER num_ctx 32768                  # Line 16
PARAMETER num_predict 1024              # Line 17
PARAMETER top_k 20                       # Line 18
PARAMETER top_p 0.95                     # Line 19
PARAMETER repeat_penalty 1              # Line 20
PARAMETER stop <|im_start|>             # Line 21
PARAMETER stop <|im_end|>               # Line 22
```

### Line 1: `FROM qwen3:14b`

**What it does:** Specifies the base model. Ollama resolves this to a 9.3 GB GGUF weight blob on disk. The custom model's manifest will point to this same blob — no duplication.

**Why qwen3:14b specifically:**
- 14 billion parameters — large enough for accurate tool-calling and structured output, small enough to run on 16 GB+ RAM
- Native function/tool-calling support (critical for the n8n AI Agent)
- ChatML template format (`<|im_start|>` / `<|im_end|>`) which our stop tokens rely on
- Qwen3 supports the `/no_think` directive to suppress chain-of-thought

**Observable outcome:** Without this line, `ollama create` fails. Changing the model (e.g., `FROM llama3.1:8b`) changes the intelligence, capabilities, and template format of the model entirely.

### Line 3: `SYSTEM """`

**What it does:** Opens a multi-line system prompt block. The triple-quote syntax (`"""`) is Ollama's way of allowing newlines inside the system prompt. Everything between `"""` and the closing `"""` is injected as the system message before every conversation.

**Observable outcome:** Without a SYSTEM block, the model uses its default behavior — verbose, explanatory, and unpredictable output format.

### Line 4: `/no_think`

**What it does:** A Qwen3-specific directive that suppresses the model's chain-of-thought reasoning. By default, Qwen3 generates internal reasoning inside `<think>...</think>` XML blocks before producing the actual answer.

**Without `/no_think`:**
```
<think>
The user is asking about Kubernetes namespaces. Let me think about what
namespaces exist in a default cluster. There's kube-system, kube-public,
kube-node-lease, and default. I should format this as a clear list...
[300-500 more words of reasoning]
</think>

Here are the default namespaces in a Kubernetes cluster:
| Namespace | Purpose |
|-----------|---------|
| default | ... |
```

**With `/no_think`:**
```
| Namespace | Purpose |
|-----------|---------|
| default | Default namespace for user workloads |
```

**Observable outcome:** Response time drops from ~15s to ~4s. Output shrinks from 500+ tokens to ~50 tokens. The `<think>` blocks are completely suppressed. This is the single highest-impact line in the entire Modelfile.

> **Triple-layer suppression:** This project actually suppresses thinking in three places: (1) `/no_think` in the Modelfile SYSTEM prompt (baked in), (2) `think: false` in n8n's Ollama API calls (runtime), and (3) the n8n Agent's own system prompt. All three are needed because different code paths may override each other.

### Line 5: `You are a concise Kubernetes cluster assistant.`

**What it does:** Sets the model's persona/role. This is the first natural-language instruction in the system prompt.

**Observable outcome:** The word "concise" is critical. Without it, the model defaults to being helpful-but-verbose. With it, the model produces shorter answers and avoids explanations. Changing this to "You are a helpful assistant" would produce dramatically longer, more general responses.

### Line 6: `STRICT OUTPUT RULES:`

**What it does:** Signals to the model that the following rules are mandatory, not suggestions. LLMs respond more strongly to imperative framing like "STRICT" and "RULES" than to polite requests.

**Observable outcome:** Without "STRICT", the model occasionally breaks the rules (adds a preamble sentence, uses bullet lists). With "STRICT", compliance increases significantly.

### Line 7: `- Output ONLY markdown tables. Nothing else.`

**What it does:** The primary output format constraint. Forces the model to respond exclusively with markdown tables (pipe-separated rows).

**Without this rule:**
```
Here are the namespaces in your cluster:

### Namespaces

- **default** — The default namespace for user workloads
- **kube-system** — Contains Kubernetes system components
...
```

**With this rule:**
```
| Namespace | Description |
|-----------|-------------|
| default | Default namespace for user workloads |
| kube-system | Kubernetes system components |
```

**Observable outcome:** Output becomes machine-parseable. n8n can reliably extract data from markdown tables. Bullet lists and prose are eliminated.

### Line 8: `- For counting queries: | Namespace | Count |`

**What it does:** Provides an explicit table schema for counting-type questions (e.g., "How many pods are there?", "Count deployments by namespace").

**Observable outcome:** Without this template, the model might respond with prose like "There are 5 pods in namespace X." With it, the model produces a consistent two-column table that's easy to parse programmatically.

### Line 9: `- For listing queries: | Kind | Name | Namespace | Details |`

**What it does:** Provides the table schema for listing/detail queries (e.g., "Show all deployments", "What services exist?").

**Observable outcome:** Ensures consistent 4-column output. Without this, the model might use different column headers each time (sometimes "Resource" vs "Kind", sometimes including "Status" vs not). The fixed schema makes downstream parsing reliable.

### Line 10: `- NEVER output section headers (###), bullet lists, recommendations, or verbose text.`

**What it does:** Explicit prohibition of common LLM output patterns. Models love to use markdown headers and bullet lists — this line blocks that behavior.

**Observable outcome:** Without this, even with "Output ONLY markdown tables", the model occasionally adds `### Namespaces` headers above the table or appends "**Recommendations:**" sections. The NEVER directive with specific examples eliminates these.

### Line 11: `- NEVER hallucinate or invent resource names. Only use data from tool results.`

**What it does:** A grounding constraint. Tells the model to only report data it received from the Qdrant tool results, not from its training data.

**Observable outcome:** Without this, the model might confidently list pods like `nginx-deployment-abc123` that don't exist in the actual cluster. With it, the model sticks to data provided by the `kubernetes_inventory` and `kubernetes_search` tools. This is critical for a monitoring system — false data is worse than no data.

### Line 12: `- Maximum one summary sentence after the table.`

**What it does:** Allows a single concluding sentence after the table, but no more.

**Observable outcome:** This is a controlled relaxation. Without it, the model sometimes feels "incomplete" and generates erratic extra content. With it, the model can add one sentence like "4 namespaces found in the cluster." — helpful context without verbosity.

### Line 13: `"""`

**What it does:** Closes the multi-line SYSTEM prompt block.

### Line 15: `PARAMETER temperature 0`

**What it does:** Sets the sampling temperature to 0 (greedy decoding). At temperature 0, the model always picks the highest-probability token — no randomness.

**temperature 0 (deterministic):**
```
Same input → Always the same output
"List namespaces" → identical table every time
```

**temperature 0.7 (default/creative):**
```
Same input → Slightly different output each time
"List namespaces" → table with different column orders, wording variations
```

**Observable outcome:** Critical for a monitoring tool. The same Kubernetes query should always return the same formatted response. Eliminates non-determinism in output format, column naming, and sentence structure. Also slightly faster (no sampling computation needed).

### Line 16: `PARAMETER num_ctx 32768`

**What it does:** Sets the context window to 32,768 tokens (~24,000 words). This is the maximum amount of text the model can "see" at once — system prompt + conversation history + tool results + generated output must all fit within this window.

**Why 32K:**
- The `kubernetes_inventory` tool scrolls ALL Qdrant points (150+ resources in a typical cluster)
- Each resource has ~100 tokens of metadata (kind, name, namespace, labels, annotations)
- 150 resources × 100 tokens = 15,000 tokens for tool results alone
- Plus system prompt (~200 tokens) + user query (~50 tokens) + conversation history (~2,000 tokens)
- 32K provides comfortable headroom

**Observable outcome:** With the default num_ctx (2048 or 4096), the model would silently truncate tool results — answering "How many pods?" with an incomplete count. At 32K, all resources fit and counts are accurate. Trade-off: higher VRAM usage (~2 GB more than the default).

### Line 17: `PARAMETER num_predict 1024`

**What it does:** Limits the maximum number of tokens the model can generate in a single response to 1,024 tokens (~750 words).

**Observable outcome:** Prevents runaway generation. Without a cap, a malformed query could cause the model to generate thousands of tokens (consuming time and resources). 1,024 is enough for a large table (50+ rows) plus one summary sentence, but prevents multi-page essays. If the model hits this limit, the response is truncated — but for well-formatted tables, 1,024 tokens is rarely reached.

### Line 18: `PARAMETER top_k 20`

**What it does:** During token generation, only consider the top 20 highest-probability candidates before applying further filtering. The default is typically 40.

**Observable outcome:** With `temperature 0`, this parameter has minimal practical effect (greedy decoding always picks the #1 token). It serves as a safety net — if temperature is ever changed to non-zero, top_k=20 keeps the vocabulary tight, preventing the model from selecting unlikely tokens that would break table formatting. Lower top_k = more focused, less creative.

### Line 19: `PARAMETER top_p 0.95`

**What it does:** Nucleus sampling — select from the smallest set of tokens whose cumulative probability exceeds 95%. This is an alternative/complement to top_k.

**Observable outcome:** Like top_k, this is a safety net at temperature 0. At non-zero temperatures, `top_p 0.95` means the model ignores the bottom 5% of probability mass — eliminating very unlikely tokens that could produce garbage characters or broken formatting. The value 0.95 is fairly permissive; for stricter output, you could lower it to 0.8.

### Line 20: `PARAMETER repeat_penalty 1`

**What it does:** Disables the repetition penalty entirely (1.0 = no penalty). Normally, Ollama defaults to `repeat_penalty 1.1`, which penalizes tokens that have already appeared, discouraging repetitive output.

**Why disabled:**

```
NORMAL OUTPUT (repeat_penalty 1.0 — disabled):
| Kind       | Name      | Namespace  |
| Pod        | coredns   | kube-system |
| Pod        | etcd      | kube-system |
| Service    | kubernetes| default    |

CORRUPTED OUTPUT (repeat_penalty 1.1 — enabled):
| Kind       | Name      | Namespace  |
| Pod        | coredns   | kube-system |
  Pod          etcd        kube-system
  Service      kubernetes  default
```

**Observable outcome:** Markdown tables naturally repeat `|` pipe characters on every row. With a repeat penalty, the model starts avoiding `|` after the first few rows, corrupting the table structure. This is one of the most important parameters — getting it wrong silently breaks all output formatting. Must be 1 (disabled) for any model that outputs structured/tabular data.

### Line 21: `PARAMETER stop <|im_start|>`

**What it does:** Adds a stop sequence. When the model generates the token sequence `<|im_start|>`, generation immediately halts. This is a ChatML control token that signals the beginning of a new message turn.

**Observable outcome:** Without this, the model might "hallucinate" a fake follow-up message — generating `<|im_start|>user\nThank you!<|im_end|><|im_start|>assistant\nYou're welcome!` as if the conversation continued. The stop sequence prevents this by terminating generation the moment the model tries to start a new turn.

### Line 22: `PARAMETER stop <|im_end|>`

**What it does:** Adds a second stop sequence for the ChatML end-of-message token. Generation halts when `<|im_end|>` is produced.

**Observable outcome:** Ensures the model stops cleanly at the end of its response, matching the ChatML format. Together with Line 21, these two stop tokens prevent all forms of multi-turn hallucination. They are specific to the Qwen3 model family (which uses ChatML format). Other model families (LLaMA, Mistral) would need different stop tokens matching their template format.

### Combined Effect: The Full Stack

All 22 lines work together as an integrated system:

| Layer | Lines | Purpose |
|-------|-------|---------|
| **Foundation** | 1 | Choose the right brain (14B params, tool-calling capable) |
| **Behavior** | 4-12 | Define persona, suppress thinking, constrain output format |
| **Determinism** | 15, 18-19 | Eliminate randomness for reproducible output |
| **Capacity** | 16-17 | Fit 150+ K8s resources in context, cap output length |
| **Formatting** | 20 | Protect table structure from repetition penalty corruption |
| **Safety** | 21-22 | Prevent multi-turn hallucination via ChatML stop tokens |

**Net result:** The same 9.3 GB model weights that produce verbose, unpredictable, thinking-heavy output as `qwen3:14b` produce clean, deterministic, table-formatted output as `qwen3:14b-k8s` — with zero additional disk space and a 40ms build time.

---

## 16. Portability: Deploying Your Custom Model Anywhere

### 16.1 Export the Custom Model

Ollama doesn't have a built-in `export` command, but the model is fully defined by two things:

1. **The base model** (available from Ollama registry on any machine)
2. **The Modelfile** (a small text file you version-control)

**Method 1: Modelfile (Recommended — Portable and Reproducible)**

```bash
# On your dev machine: extract the Modelfile
ollama show qwen3:14b-k8s --modelfile > Modelfile.k8s

# On any target machine:
ollama pull qwen3:14b          # Download base model (~9.3 GB, one-time)
ollama create qwen3:14b-k8s -f Modelfile.k8s   # Build custom model (~40ms)
```

This is the recommended approach because:
- The Modelfile is a tiny text file (~1 KB) — easy to version-control in Git
- The base model is pulled from Ollama's CDN (fast, verified checksum)
- Reproducible on any machine with Ollama installed

**Method 2: Copy the Blob Directory (Offline / Air-Gapped)**

```bash
# On source machine: find all blobs used by the model
ollama show qwen3:14b-k8s --modelfile  # note the FROM layer hash

# Package the entire model store
tar czf ollama-models.tar.gz ~/.ollama/models/

# On target machine:
tar xzf ollama-models.tar.gz -C ~/
ollama list  # qwen3:14b-k8s should appear
```

**Method 3: Docker Image with Embedded Model**

For Kubernetes or cloud deployments where you need the model baked into a container:

```dockerfile
FROM ollama/ollama:latest

# Copy the Modelfile
COPY Modelfile.k8s /tmp/Modelfile.k8s

# Pull base model and create custom model during build
RUN ollama serve & sleep 5 && \
    ollama pull qwen3:14b && \
    ollama create qwen3:14b-k8s -f /tmp/Modelfile.k8s && \
    kill %1

EXPOSE 11434
CMD ["serve"]
```

```bash
docker build -t my-ollama-k8s:latest .
docker run -p 11434:11434 my-ollama-k8s:latest
```

> **Warning:** This creates a ~12 GB Docker image. Use a registry with layer caching.

### 16.2 Deployment Checklist

| Target | Steps |
|--------|-------|
| **Another Mac/Linux laptop** | Install Ollama → `ollama pull qwen3:14b` → `ollama create` with Modelfile |
| **Linux server (bare metal)** | Install Ollama → install NVIDIA drivers if GPU → same as above |
| **Kubernetes pod** | Docker image with embedded model, or init container that pulls + creates |
| **Air-gapped environment** | Copy `~/.ollama/models/` directory via USB/network share |
| **CI/CD pipeline** | Cache `~/.ollama/models/` between runs; Modelfile in repo |

### 16.3 Version Control Strategy

Keep the Modelfile in your Git repository:

```
your-repo/
├── models/
│   ├── Modelfile.k8s           # Production K8s assistant
│   ├── Modelfile.k8s-dev       # Dev version with higher temperature
│   └── Modelfile.sql           # SQL assistant variant
├── scripts/
│   └── setup-models.sh         # Pulls base + creates all custom models
└── ...
```

```bash
#!/bin/bash
# setup-models.sh — run on any new machine
ollama pull qwen3:14b
ollama pull nomic-embed-text

for mf in models/Modelfile.*; do
  name=$(basename "$mf" | sed 's/Modelfile\./qwen3:14b-/')
  echo "Building $name from $mf..."
  ollama create "$name" -f "$mf"
done

ollama list
```

---

## 17. Future Enhancement Roadmap

### 17.1 Enhancing the System Prompt (No Retraining)

The fastest way to improve the model — just edit the Modelfile and rebuild:

```bash
# Add new capabilities to the system prompt
vim Modelfile.k8s

# Example: add YAML output support
SYSTEM """
/no_think
You are a concise Kubernetes cluster assistant.
OUTPUT RULES:
- Default: markdown tables
- If user says "as yaml": output valid YAML
- If user says "as json": output valid JSON
...
"""

# Rebuild (instant)
ollama create qwen3:14b-k8s -f Modelfile.k8s
```

### 17.2 Upgrading the Base Model

When a better base model is released:

```bash
# Pull the new base
ollama pull qwen3:32b    # hypothetical larger model

# Update the Modelfile
sed -i 's/FROM qwen3:14b/FROM qwen3:32b/' Modelfile.k8s

# Rebuild
ollama create qwen3:32b-k8s -f Modelfile.k8s

# Update n8n workflow to use new model name
# Edit workflows/n8n_ai_k8s_flow.json: "model": "qwen3:32b-k8s"
```

### 17.3 Adding LoRA Fine-Tuning (When Prompting Isn't Enough)

If the model consistently gets certain answers wrong despite good prompting, train a LoRA adapter:

**Step 1: Collect Training Data**

```jsonl
{"messages":[{"role":"system","content":"You are a K8s assistant"},{"role":"user","content":"How many pods in kube-system?"},{"role":"assistant","content":"| Namespace | Pod Count |\n|---|---|\n| kube-system | 8 |"}]}
{"messages":[{"role":"system","content":"You are a K8s assistant"},{"role":"user","content":"Show DaemonSets"},{"role":"assistant","content":"| Name | Namespace | Desired | Ready |\n|---|---|---|---|\n| kindnet | kube-system | 1 | 1 |\n| kube-proxy | kube-system | 1 | 1 |"}]}
```

Aim for 100–500 high-quality examples covering your specific use cases.

**Step 2: Fine-Tune with Unsloth (Most Efficient)**

```bash
pip install unsloth

python -c "
from unsloth import FastLanguageModel
import torch

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name='unsloth/Qwen3-14B',
    max_seq_length=8192,
    load_in_4bit=True,
)

model = FastLanguageModel.get_peft_model(
    model,
    r=16,              # LoRA rank (higher=more capacity, more VRAM)
    lora_alpha=16,
    target_modules=['q_proj','k_proj','v_proj','o_proj',
                    'gate_proj','up_proj','down_proj'],
    lora_dropout=0,
    bias='none',
)

# Train with your data...
from trl import SFTTrainer
trainer = SFTTrainer(
    model=model,
    train_dataset=dataset,   # your JSONL loaded as HF dataset
    max_seq_length=8192,
    args=TrainingArguments(
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        warmup_steps=5,
        num_train_epochs=3,
        learning_rate=2e-4,
        output_dir='./lora-k8s',
    ),
)
trainer.train()
model.save_pretrained_gguf('./lora-k8s-gguf', tokenizer, quantization_method='q4_k_m')
"
```

**Step 3: Create Model with Adapter**

```dockerfile
FROM qwen3:14b
ADAPTER ./lora-k8s-gguf/adapter.gguf
SYSTEM "..."
PARAMETER temperature 0
PARAMETER num_ctx 32768
```

```bash
ollama create qwen3:14b-k8s-ft -f Modelfile.finetuned
```

### 17.4 Adding More Tools

Extend the n8n AI Agent with additional tools without changing the model:

```
Current tools:
  ├── kubernetes_inventory  (Qdrant scroll → group by kind)
  └── kubernetes_search     (Qdrant vector search → topK=20)

Future tools:
  ├── kubernetes_logs       (kubectl logs → recent pod logs)
  ├── kubernetes_events     (kubectl get events → cluster events)
  ├── kubernetes_metrics    (metrics-server → CPU/memory usage)
  └── kubernetes_diff       (compare current vs. desired state)
```

Just add new tool nodes to the n8n workflow and update the Agent system message with tool descriptions. The model's tool-calling capability handles the rest.

### 17.5 Enhancement Priority Matrix

| Enhancement | Effort | Impact | When to Do |
|---|---|---|---|
| Edit system prompt | 5 min | High | First — always try this |
| Add n8n tools | Hours | High | When new data sources needed |
| Upgrade base model | 30 min | Medium | When new Ollama models released |
| Adjust parameters | 5 min | Medium | If output format/length wrong |
| LoRA fine-tuning | Days | High | Only if prompting fails consistently |
| Full fine-tuning | Weeks | Highest | Almost never needed for this use case |

---

## 18. Benchmarks: Build Time and Performance

### 18.1 Development Machine Specifications

| Component | Specification |
|---|---|
| **Machine** | Apple MacBook Pro |
| **Chip** | Apple M4 Max |
| **CPU Cores** | 16 (12 Performance + 4 Efficiency) |
| **RAM** | 128 GB Unified Memory |
| **GPU** | Apple M4 Max integrated (Metal) |
| **Storage** | NVMe SSD |
| **Ollama Version** | 0.17.0 |
| **OS** | macOS Darwin 25.3.0 |

### 18.2 Model Creation Benchmarks

| Operation | Time | Notes |
|---|---|---|
| `ollama create qwen3:14b-k8s` (from existing base) | **0.040s (40ms)** | No weights copied — config layers only |
| `ollama pull qwen3:14b` (first time, fast internet) | ~3–5 min | 9.3 GB download (one-time) |
| `ollama pull nomic-embed-text` (first time) | ~30s | 274 MB download (one-time) |
| Rebuild after Modelfile edit | **0.040s** | Instant iteration cycle |
| Model load into memory (first query) | ~5–8s | Subsequent queries: instant (model stays loaded) |

### 18.3 Inference Benchmarks (Apple M4 Max, 128 GB)

| Metric | qwen3:14b-k8s | qwen3:8b-k8s |
|---|---|---|
| Prompt evaluation (1000 tokens) | ~1.2s | ~0.7s |
| Token generation speed | ~35 tok/s | ~55 tok/s |
| Typical query response time | 5–15s | 3–8s |
| Typical table output (20 rows) | ~8s | ~5s |
| Memory usage (num_ctx=32768) | ~14 GB | ~8 GB |
| Memory usage (num_ctx=8192) | ~10 GB | ~6 GB |

### 18.4 E2E Test Suite Performance

| Test Category | Count | Total Time | Avg per Test |
|---|---|---|---|
| CDC tests (Kafka + Qdrant) | 5 | ~12s | ~2.4s |
| AI query tests (embed + LLM) | 4 | ~42s | ~10.5s |
| Memory tests (Postgres) | 2 | ~19s | ~9.5s |
| Accuracy tests (kubectl compare) | 3 | ~37s | ~12.3s |
| Reset test | 1 | ~3s | 3s |
| **Total** | **15** | **~2.0 min** | |

---

## 19. Hardware Requirements: Server Specifications

### 19.1 Minimum Viable Server (Budget — Inference Only)

| Component | Specification | Est. Cost |
|---|---|---|
| **GPU** | NVIDIA RTX 3060 12GB | ~$250 used |
| **CPU** | AMD Ryzen 5 5600 (6-core) | ~$130 |
| **RAM** | 32 GB DDR4 | ~$60 |
| **Storage** | 256 GB NVMe SSD | ~$25 |
| **OS** | Ubuntu 22.04 LTS or 24.04 LTS | Free |
| **Total** | | **~$465** |

Runs `qwen3:14b` with `num_ctx=8192`. The 12GB VRAM holds the model with room for KV cache. For `num_ctx=32768`, use the recommended spec below.

### 19.2 Recommended Server (Production Inference)

| Component | Specification | Est. Cost |
|---|---|---|
| **GPU** | NVIDIA RTX 4090 24GB | ~$1,600 |
| **CPU** | AMD Ryzen 7 7700X (8-core) or Intel i7-13700K | ~$300 |
| **RAM** | 64 GB DDR5 | ~$150 |
| **Storage** | 1 TB NVMe SSD | ~$70 |
| **PSU** | 850W 80+ Gold | ~$100 |
| **OS** | Ubuntu 22.04 LTS or 24.04 LTS | Free |
| **Total** | | **~$2,220** |

Runs `qwen3:14b` with full `num_ctx=32768`. The 24GB VRAM comfortably holds model + KV cache. Fast token generation (~60 tok/s).

### 19.3 High-End Server (Inference + LoRA Fine-Tuning)

| Component | Specification | Est. Cost |
|---|---|---|
| **GPU** | NVIDIA A100 80GB or 2× RTX 4090 24GB | ~$8,000–$15,000 |
| **CPU** | AMD EPYC 7443 (24-core) or Threadripper | ~$800 |
| **RAM** | 128 GB DDR5 ECC | ~$400 |
| **Storage** | 2 TB NVMe SSD | ~$120 |
| **OS** | Ubuntu 22.04 LTS | Free |
| **Total** | | **~$9,300–$16,300** |

Required for LoRA fine-tuning of 14B models. A single A100 80GB can fine-tune with `load_in_4bit=True`. Two RTX 4090s with DeepSpeed ZeRO-3 also work.

### 19.4 Cloud Alternatives

| Provider | Instance | GPU | VRAM | $/hour | Best For |
|---|---|---|---|---|---|
| **Lambda Labs** | gpu_1x_a100_sxm4 | A100 | 80GB | ~$1.10 | Fine-tuning |
| **RunPod** | RTX 4090 | 4090 | 24GB | ~$0.44 | Inference |
| **Vast.ai** | RTX 4090 | 4090 | 24GB | ~$0.30 | Budget inference |
| **AWS** | g5.xlarge | A10G | 24GB | ~$1.00 | Production |
| **GCP** | g2-standard-4 | L4 | 24GB | ~$0.70 | Production |

### 19.5 Linux Server Setup Script

```bash
#!/bin/bash
# setup-ollama-server.sh — Run on a fresh Ubuntu 22.04/24.04 server with NVIDIA GPU

set -e

echo "=== Step 1: Install NVIDIA Drivers ==="
sudo apt update && sudo apt install -y nvidia-driver-545
# Reboot required after driver install
# sudo reboot

echo "=== Step 2: Verify GPU ==="
nvidia-smi

echo "=== Step 3: Install Ollama ==="
curl -fsSL https://ollama.com/install.sh | sh

echo "=== Step 4: Start Ollama Service ==="
sudo systemctl enable ollama
sudo systemctl start ollama

echo "=== Step 5: Pull Models ==="
ollama pull qwen3:14b
ollama pull nomic-embed-text

echo "=== Step 6: Create Custom Model ==="
cat > /tmp/Modelfile.k8s << 'EOF'
FROM qwen3:14b

SYSTEM """
/no_think
You are a concise Kubernetes cluster assistant.
STRICT OUTPUT RULES:
- Output ONLY markdown tables. Nothing else.
- For counting queries: | Namespace | Count |
- For listing queries: | Kind | Name | Namespace | Details |
- NEVER output section headers (###), bullet lists, recommendations, or verbose text.
- NEVER hallucinate or invent resource names. Only use data from tool results.
- Maximum one summary sentence after the table.
"""

PARAMETER temperature 0
PARAMETER num_ctx 32768
PARAMETER num_predict 1024
PARAMETER top_k 20
PARAMETER top_p 0.95
PARAMETER repeat_penalty 1
PARAMETER stop <|im_start|>
PARAMETER stop <|im_end|>
EOF

ollama create qwen3:14b-k8s -f /tmp/Modelfile.k8s

echo "=== Step 7: Verify ==="
ollama list
ollama run qwen3:14b-k8s "List 3 Kubernetes resource types" --verbose

echo "=== Step 8: Configure Remote Access ==="
# By default Ollama binds to localhost only.
# To allow remote access (e.g., from n8n pods):
sudo mkdir -p /etc/systemd/system/ollama.service.d
cat << 'CONF' | sudo tee /etc/systemd/system/ollama.service.d/environment.conf
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
CONF
sudo systemctl daemon-reload
sudo systemctl restart ollama

echo "=== Done! ==="
echo "Ollama API: http://$(hostname -I | awk '{print $1}'):11434"
echo "Test: curl http://localhost:11434/api/tags"
```

### 19.6 VRAM Requirements by Model Size

| Model | Quantization | VRAM (ctx=8K) | VRAM (ctx=32K) | Min GPU |
|---|---|---|---|---|
| qwen3:1.7b | Q4_K_M | 2 GB | 3 GB | Any GPU / CPU |
| qwen3:4b | Q4_K_M | 4 GB | 5 GB | RTX 3060 6GB |
| qwen3:8b | Q4_K_M | 6 GB | 8 GB | RTX 3060 12GB |
| qwen3:14b | Q4_K_M | 10 GB | 14 GB | RTX 4070 Ti 16GB |
| qwen3:32b | Q4_K_M | 20 GB | 28 GB | RTX 4090 24GB |
| qwen3:30b-a3b (MoE) | Q4_K_M | 20 GB | 26 GB | RTX 4090 24GB |

> **Apple Silicon note:** M1/M2/M3/M4 chips share unified memory between CPU and GPU. A Mac with 32GB+ unified RAM can run qwen3:14b with 32K context — Metal acceleration handles GPU offload automatically. No NVIDIA drivers needed.

---

*Document generated from the Kubernetes AI Knowledge System project. Model: qwen3:14b-k8s based on Qwen3-14B by Alibaba Cloud (Apache 2.0).*
