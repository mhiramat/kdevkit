---
trigger: always_on
---

# Git Commit Rules

## Commit Granularity

When committing changes to Git:

- **Split commits by feature or milestone** rather than bundling unrelated changes or an entire multi-part phase into a single monolithic commit.
- Group each commit into a coherent, self-contained logical unit (for example: core domain logic + its tests, transport/client layer + its tests, UI/controller wiring + manifest updates, documentation updates).
- Keep each commit buildable and reviewable on its own, with a clear commit message summarizing the specific feature or milestone it introduces.
- Avoid mixing unrelated bug fixes, refactors, or documentation rewrites into a feature commit unless they are directly required by that feature.

## Commit Message Style

- **Write commit messages in English.**
- **Prefix the commit title with the target submodule tag** (e.g., `scripts:`, `extension:`, `backend:`, `configs:`, `docs:`).
- **Wrap lines at 80 characters or fewer** and include a descriptive commit body of **at least 3-4 lines** explaining the motivation and key changes.
- **Add a `Fixes:` trailer when fixing a bug introduced by an earlier commit**, formatted as:
  `Fixes: <abbrev-commit-hash> ("<commit title>")`
  (e.g., `Fixes: 30f4b2646b6f ("scripts: Recreate broken backend virtualenv in setup_kconfig_backend.sh")`).
