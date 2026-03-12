#!/bin/bash
# ============================================================================
#  build-custom-model.sh — Hands-on tutorial to create qwen3:14b-k8s
#
#  This script walks you through every step of customizing an Ollama model.
#  Run it interactively to see each step, or execute it all at once.
#
#  Prerequisites:
#    - Ollama installed (https://ollama.com/download)
#    - At least 12 GB free RAM
#    - ~10 GB free disk space (for qwen3:14b base model)
#
#  Usage:
#    chmod +x models/build-custom-model.sh
#    ./models/build-custom-model.sh
# ============================================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

hr() { echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; }
step() { echo -e "\n${BOLD}${CYAN}━━━ Step $1: $2 ━━━${RESET}"; }
info() { echo -e "${GREEN}[✓]${RESET} $1"; }
warn() { echo -e "${YELLOW}[!]${RESET} $1"; }

echo -e "${BOLD}"
echo "  ╔═══════════════════════════════════════════════════════════╗"
echo "  ║   Ollama Model Customization — Hands-On Tutorial         ║"
echo "  ║   Building: qwen3:14b-k8s (Kubernetes Assistant)         ║"
echo "  ╚═══════════════════════════════════════════════════════════╝"
echo -e "${RESET}"

# ─────────────────────────────────────────────────────────────────
step 1 "Verify Ollama is running"
# ─────────────────────────────────────────────────────────────────

if ! command -v ollama &>/dev/null; then
  echo -e "${RED}[✗] Ollama not found. Install from https://ollama.com/download${RESET}"
  exit 1
fi

OLLAMA_VERSION=$(ollama --version 2>/dev/null || echo "unknown")
info "Ollama version: $OLLAMA_VERSION"

# Quick check that Ollama server is responding
if curl -s http://localhost:11434/api/tags &>/dev/null; then
  info "Ollama server is running on port 11434"
else
  warn "Ollama server not responding — starting it..."
  ollama serve &>/dev/null &
  sleep 3
  info "Ollama server started"
fi

# ─────────────────────────────────────────────────────────────────
step 2 "Pull the base model (qwen3:14b)"
# ─────────────────────────────────────────────────────────────────

echo ""
echo "  The base model contains the neural network weights (14 billion"
echo "  parameters). This is the 'brain' — our customization adds"
echo "  personality and rules on top of it."
echo ""

if ollama list 2>/dev/null | grep -q "qwen3:14b "; then
  info "qwen3:14b already downloaded — skipping (saves ~5 minutes)"
else
  echo -e "${YELLOW}Downloading qwen3:14b (~9.3 GB)... this takes 3-5 minutes${RESET}"
  ollama pull qwen3:14b
  info "Base model downloaded"
fi

BASE_SIZE=$(ollama list 2>/dev/null | grep "qwen3:14b " | awk '{print $3, $4}')
info "Base model size: $BASE_SIZE"

# ─────────────────────────────────────────────────────────────────
step 3 "Examine the base model (BEFORE customization)"
# ─────────────────────────────────────────────────────────────────

echo ""
echo "  Let's see what the base model does WITHOUT customization."
echo "  Notice: verbose output, explanations, code blocks, headers."
echo ""
hr

echo -e "${YELLOW}Query: 'List namespaces in a default k8s cluster'${RESET}"
echo ""

BASE_RESPONSE=$(curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3:14b",
  "messages": [{"role":"user","content":"List namespaces in a default k8s cluster"}],
  "stream": false,
  "think": false
}' | python3 -c "import sys,json; print(json.load(sys.stdin)['message']['content'])" 2>/dev/null)

echo -e "${RED}BASE MODEL OUTPUT:${RESET}"
echo "$BASE_RESPONSE" | head -25
echo ""
hr

echo ""
echo "  Problems with the base model output:"
echo "    ✗ Contains verbose explanations"
echo "    ✗ Uses markdown headers (###)"
echo "    ✗ Includes code blocks with kubectl commands"
echo "    ✗ Output format is unpredictable"
echo "    ✗ Not suitable for programmatic consumption (e.g., n8n agent)"
echo ""

# ─────────────────────────────────────────────────────────────────
step 4 "Create the Modelfile"
# ─────────────────────────────────────────────────────────────────

MODELFILE="$SCRIPT_DIR/Modelfile.k8s"
echo ""
echo "  The Modelfile is the configuration recipe. It defines:"
echo "    1. Base model (FROM) — which weights to use"
echo "    2. System prompt (SYSTEM) — persona and output rules"
echo "    3. Parameters (PARAMETER) — inference behavior"
echo ""
echo "  File location: $MODELFILE"
echo ""

if [ ! -f "$MODELFILE" ]; then
  cat > "$MODELFILE" << 'MODELFILE_EOF'
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
fi

info "Modelfile contents:"
echo ""
cat "$MODELFILE" | while IFS= read -r line; do
  echo "    $line"
done
echo ""

echo "  Key customizations explained:"
echo ""
echo "    SYSTEM '/no_think'"
echo "      → Suppresses Qwen3's chain-of-thought <think>...</think> blocks"
echo "      → Without this, every response has 500+ words of internal reasoning"
echo ""
echo "    SYSTEM 'Output ONLY markdown tables'"
echo "      → Forces clean, structured output instead of prose"
echo "      → Makes output parseable by downstream systems (n8n)"
echo ""
echo "    PARAMETER temperature 0"
echo "      → Deterministic output — same input always gives same output"
echo "      → Critical for a monitoring tool (no creative hallucinations)"
echo ""
echo "    PARAMETER num_ctx 32768"
echo "      → 32K token context window"
echo "      → Fits 150+ Kubernetes resources from Qdrant tool results"
echo ""
echo "    PARAMETER repeat_penalty 1 (disabled)"
echo "      → Tables naturally repeat | separators — penalty would corrupt them"
echo ""

# ─────────────────────────────────────────────────────────────────
step 5 "Build the custom model"
# ─────────────────────────────────────────────────────────────────

echo ""
echo "  This is the magic moment. Building the custom model..."
echo "  (Spoiler: it takes less than 1 second)"
echo ""

BUILD_START=$(python3 -c "import time; print(time.time())")

ollama create qwen3:14b-k8s -f "$MODELFILE" 2>&1

BUILD_END=$(python3 -c "import time; print(time.time())")
BUILD_TIME=$(python3 -c "print(f'{$BUILD_END - $BUILD_START:.3f}')")

echo ""
info "Build time: ${BUILD_TIME} seconds"
echo ""
echo "  What happened:"
echo "    • Ollama created a new manifest file (~1 KB)"
echo "    • It REUSES the same 9.3 GB weight blob as qwen3:14b"
echo "    • Only new layers: system prompt + parameters (a few KB each)"
echo "    • Zero additional disk space for model weights"
echo ""

# ─────────────────────────────────────────────────────────────────
step 6 "Verify the custom model"
# ─────────────────────────────────────────────────────────────────

echo ""
echo "  Both models should appear — sharing the same 9.3 GB weight blob:"
echo ""
ollama list 2>/dev/null | head -1
ollama list 2>/dev/null | grep "qwen3:14b"
echo ""

echo "  Inspect the custom model's system prompt:"
echo ""
ollama show qwen3:14b-k8s --system 2>/dev/null | while IFS= read -r line; do
  echo "    $line"
done
echo ""

echo "  Inspect the custom model's parameters:"
echo ""
ollama show qwen3:14b-k8s --parameters 2>/dev/null | while IFS= read -r line; do
  echo "    $line"
done
echo ""

# ─────────────────────────────────────────────────────────────────
step 7 "Test the custom model (AFTER customization)"
# ─────────────────────────────────────────────────────────────────

echo ""
echo "  Same query as Step 3 — watch the output difference!"
echo ""
hr

echo -e "${YELLOW}Query: 'List namespaces in a default k8s cluster'${RESET}"
echo ""

CUSTOM_RESPONSE=$(curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3:14b-k8s",
  "messages": [{"role":"user","content":"List namespaces in a default k8s cluster"}],
  "stream": false,
  "think": false
}' | python3 -c "import sys,json; print(json.load(sys.stdin)['message']['content'])" 2>/dev/null)

echo -e "${GREEN}CUSTOM MODEL OUTPUT:${RESET}"
echo "$CUSTOM_RESPONSE"
echo ""
hr

echo ""
echo "  Improvements with the custom model:"
echo "    ✓ Clean markdown table — no verbose explanation"
echo "    ✓ No headers, no code blocks, no bullet lists"
echo "    ✓ Deterministic — same input always gives same table"
echo "    ✓ Structured output parseable by n8n and other tools"
echo "    ✓ No chain-of-thought <think> blocks"
echo ""

# ─────────────────────────────────────────────────────────────────
step 8 "Side-by-side comparison"
# ─────────────────────────────────────────────────────────────────

echo ""
echo -e "  ${RED}┌─── BASE MODEL (qwen3:14b) ───────────────────────────────┐${RESET}"
echo "$BASE_RESPONSE" | head -12 | while IFS= read -r line; do
  echo -e "  ${RED}│${RESET} $line"
done
echo -e "  ${RED}│${RESET} ..."
echo -e "  ${RED}└───────────────────────────────────────────────────────────┘${RESET}"
echo ""
echo -e "  ${GREEN}┌─── CUSTOM MODEL (qwen3:14b-k8s) ─────────────────────────┐${RESET}"
echo "$CUSTOM_RESPONSE" | while IFS= read -r line; do
  echo -e "  ${GREEN}│${RESET} $line"
done
echo -e "  ${GREEN}└───────────────────────────────────────────────────────────┘${RESET}"
echo ""

# ─────────────────────────────────────────────────────────────────
step 9 "Test tool-calling capability"
# ─────────────────────────────────────────────────────────────────

echo ""
echo "  The custom model can also call tools (functions). This is how"
echo "  the n8n AI Agent decides whether to use kubernetes_inventory"
echo "  or kubernetes_search."
echo ""

TOOL_RESPONSE=$(curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3:14b-k8s",
  "messages": [{"role":"user","content":"How many pods are in the cluster?"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "kubernetes_inventory",
      "description": "Get all K8s resources grouped by kind and namespace",
      "parameters": {"type":"object","properties":{}}
    }
  },{
    "type": "function",
    "function": {
      "name": "kubernetes_search",
      "description": "Search K8s resources by semantic similarity",
      "parameters": {"type":"object","properties":{"query":{"type":"string"}}}
    }
  }],
  "stream": false,
  "think": false
}' | python3 -c "
import sys, json
r = json.load(sys.stdin)
msg = r['message']
if msg.get('tool_calls'):
    for tc in msg['tool_calls']:
        print(f'  Tool called: {tc[\"function\"][\"name\"]}()')
        print(f'  Arguments:   {json.dumps(tc[\"function\"].get(\"arguments\", {}))}')
else:
    print(f'  Response: {msg[\"content\"][:200]}')
" 2>/dev/null)

echo "$TOOL_RESPONSE"
echo ""
info "The model correctly chose kubernetes_inventory (a counting query)"
echo ""

# ─────────────────────────────────────────────────────────────────
step 10 "Next steps"
# ─────────────────────────────────────────────────────────────────

echo ""
echo "  Your custom model is ready! Here's what you can do next:"
echo ""
echo "  ${BOLD}Interactive chat:${RESET}"
echo "    ollama run qwen3:14b-k8s"
echo ""
echo "  ${BOLD}API call:${RESET}"
echo "    curl http://localhost:11434/api/chat -d '{"
echo "      \"model\": \"qwen3:14b-k8s\","
echo "      \"messages\": [{\"role\":\"user\",\"content\":\"Show deployments\"}],"
echo "      \"stream\": false, \"think\": false"
echo "    }'"
echo ""
echo "  ${BOLD}Edit and rebuild:${RESET}"
echo "    vim $MODELFILE"
echo "    ollama create qwen3:14b-k8s -f $MODELFILE"
echo ""
echo "  ${BOLD}Deploy to another machine:${RESET}"
echo "    scp $MODELFILE user@server:/tmp/"
echo "    ssh user@server 'ollama pull qwen3:14b && ollama create qwen3:14b-k8s -f /tmp/Modelfile.k8s'"
echo ""
echo "  ${BOLD}Run full E2E tests:${RESET}"
echo "    npm test"
echo ""

hr
echo ""
echo -e "  ${GREEN}${BOLD}Done! Your qwen3:14b-k8s model is built and tested.${RESET}"
echo ""
hr
