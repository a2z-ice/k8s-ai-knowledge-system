#!/usr/bin/env bash
#
# cleanup.sh — Tear down the Kubernetes AI Knowledge System
#
# Usage:
#   ./scripts/cleanup.sh [OPTIONS]
#
# Options:
#   --wipe-data   PERMANENTLY delete ./data/ subdirs (Kafka, Qdrant, n8n state)
#   --yes         Skip confirmation prompt
#   -h, --help    Show this help text
#
# What this script removes:
#   • kind cluster 'k8s-ai' (all pods, services, PVs)
#   • k8s-watcher:latest Docker image (local)
#   • Docker image cached layers for k8s-watcher
#
# What this script does NOT remove by default:
#   • ./data/  — Kafka/Qdrant/n8n persistent data (preserved for re-use)
#   • Ollama models — these take a long time to re-download
#   • npm node_modules
#   • /etc/hosts entries

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GREEN}[$(date +%H:%M:%S)] ✓${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date +%H:%M:%S)] ⚠${NC} $*"; }
die()  { echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC} $*" >&2; exit 1; }
step() { echo -e "\n${BOLD}${CYAN}━━━ $* ━━━${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLUSTER_NAME="k8s-ai"
WIPE_DATA=false
AUTO_YES=false

# ── parse args ───────────────────────────────────────────────────────────────
for arg in "$@"; do
  case $arg in
    --wipe-data) WIPE_DATA=true ;;
    --yes|-y)    AUTO_YES=true ;;
    -h|--help)   sed -n '3,21p' "$0"; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

cd "${PROJECT_ROOT}"

# ── confirmation ─────────────────────────────────────────────────────────────
echo
echo -e "${BOLD}${RED}  Kubernetes AI Knowledge System — Cleanup${NC}"
echo
echo -e "  This will remove:"
echo -e "    • kind cluster '${CLUSTER_NAME}'"
echo -e "    • k8s-watcher:latest Docker image"

if [[ "${WIPE_DATA}" == "true" ]]; then
  echo -e "    ${RED}• ./data/n8n/    (n8n SQLite DB, credentials, workflows)${NC}"
  echo -e "    ${RED}• ./data/qdrant/  (all Qdrant vectors)${NC}"
  echo -e "    ${RED}• ./data/kafka/   (all Kafka log segments)${NC}"
  echo
  echo -e "  ${RED}${BOLD}WARNING: --wipe-data will permanently delete all persistent data.${NC}"
  echo -e "  ${RED}You will need to re-run the full setup to recover.${NC}"
fi

echo
if [[ "${AUTO_YES}" != "true" ]]; then
  read -r -p "  Proceed? [y/N] " CONFIRM
  [[ "${CONFIRM}" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }
fi

# ── step 1: delete kind cluster ──────────────────────────────────────────────
step "Deleting kind cluster"

if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  log "Deleting cluster '${CLUSTER_NAME}' …"
  kind delete cluster --name "${CLUSTER_NAME}"
  ok "Cluster '${CLUSTER_NAME}' deleted"
else
  ok "Cluster '${CLUSTER_NAME}' does not exist — nothing to delete"
fi

# ── step 2: remove docker image ──────────────────────────────────────────────
step "Removing k8s-watcher Docker image"

if docker image inspect k8s-watcher:latest &>/dev/null 2>&1; then
  docker rmi k8s-watcher:latest
  ok "Image k8s-watcher:latest removed"
else
  ok "Image k8s-watcher:latest not found — nothing to remove"
fi

# ── step 3: wipe data directories (optional) ────────────────────────────────
if [[ "${WIPE_DATA}" == "true" ]]; then
  step "Wiping persistent data directories"

  for dir in data/n8n data/qdrant data/kafka; do
    TARGET="${PROJECT_ROOT}/${dir}"
    if [[ -d "${TARGET}" ]]; then
      log "Removing ${dir}/ …"
      rm -rf "${TARGET}"
      ok "  ${dir}/ removed"
    else
      ok "  ${dir}/ already absent"
    fi
  done
fi

# ── done ─────────────────────────────────────────────────────────────────────
echo
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}  Cleanup complete!${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
if [[ "${WIPE_DATA}" == "false" ]]; then
  echo -e "  ${CYAN}./data/ directories were preserved.${NC}"
  echo -e "  Re-running setup will mount existing Kafka/Qdrant/n8n data."
  echo -e "  To wipe data on next cleanup: ./scripts/cleanup.sh --wipe-data"
fi
echo
echo -e "  To set up from scratch:   ${BOLD}./scripts/setup.sh${NC}"
echo -e "  To set up (keep data):    ${BOLD}./scripts/setup.sh --keep-cluster${NC}"
echo
