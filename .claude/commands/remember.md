Save a snapshot of the current session's work to persistent memory so the next session can pick up exactly where this one left off.

**Steps:**

1. Identify what was accomplished in this session:
   - What files were changed and why
   - What problems were solved
   - What decisions were made and their rationale

2. Identify what is still pending or in-progress:
   - Any incomplete tasks
   - Known issues or blockers
   - The next logical step

3. Run a quick state snapshot:
   ```bash
   # Current git diff summary (what changed this session)
   git diff --stat HEAD
   git log --oneline -5
   ```
   ```bash
   # Current system health (abbreviated)
   kubectl --context kind-k8s-ai-classic -n k8s-classic-ai get pods --no-headers 2>/dev/null | awk '{print $1, $3}'
   curl -s http://localhost:31001/collections/k8s | python3 -c "import sys,json; d=json.load(sys.stdin); print('Qdrant points:', d.get('result',{}).get('points_count','?'))" 2>/dev/null || echo "Qdrant: unreachable"
   ```

4. Update the memory file at:
   `/Users/assaduzzaman/.claude/projects/-Volumes-Other-rand-kind-vector-n8n/memory/MEMORY.md`

   Update (or add) the following sections:
   - **Implementation Status** — reflect the current completed state
   - **Key Files** — add any new important files created or significantly modified
   - **Key Calibration Decisions** — add any new design decisions made
   - **Operational Patterns** — add any new patterns discovered

   Also create or update a topic-specific file (e.g. `session-context.md`) with:
   ```markdown
   # Last Session Context

   ## Date
   <today's date>

   ## Branch
   <current git branch>

   ## What was accomplished
   - <bullet list of completed work>

   ## Pending / Next Steps
   - <bullet list of what still needs to be done>

   ## Decisions made
   - <any design/implementation decisions with rationale>
   ```

5. Confirm: output a 3-5 line summary of what was saved so the user can verify the snapshot is accurate.

**Note:** Only save stable, verified information. Do not save in-progress speculation or things that might be wrong.
