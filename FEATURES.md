# Claude-Mem Deploy Branch: Feature Tracking

This file tracks which feature branches have been merged into the `deploy` branch.
The `deploy` branch is the ONLY branch that should be built and deployed.

## Merged Features

| Feature Branch | Merged Date | Description |
|---------------|-------------|-------------|
| feat/flashrank-reranker | 2026-04-07 | Base branch. Flashrank cross-encoder reranking for improved search relevance. |
| feat/ignore-prompt-patterns | 2026-04-07 | CLAUDE_MEM_IGNORE_PROMPT_PATTERNS setting to filter heartbeat/automation prompts from storage. |

## Build Rules

1. **Never build from a feature branch.** Always `git checkout deploy` first.
2. The `prebuild` script in package.json enforces this automatically.
3. To add a new feature: develop on a feature branch, then `git checkout deploy && git cherry-pick <commits>` or `git merge <feature-branch>`.
4. Update this file when merging new features.
5. Feature branches can still be pushed to GitHub for PRs against upstream independently.
