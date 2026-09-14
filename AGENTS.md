# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## chatgpt-cdp-cli project notes

- Commands: `bun install`, `bun test`, `bun run typecheck`, `bun run build` (dist bundles + compiled binary). No runtime dependencies; Node >= 22 or Bun.
- **Behavior is frozen to the prototype**: the original single-file prototype lives in git history (`chatgpt-cdp.mjs`, commit "Add original chatgpt-cdp.mjs prototype as reference") and is the behavioral source of truth. Do not change command names/arguments/output shapes; UI-driving invariants (completion detection, composer dual form, project URL form, virtualized thread) are documented verbatim in module header comments — keep them in place.
- `dist/` is **checked in** on purpose (prebuilt for npx from npm and GitHub with no install-time build). Rebuild and commit it whenever `src/` changes: `bun run build:js && git add dist`.
- Architecture map and command reference: `README.md`. Module layout: `src/` (cli / api / refs / discovery / cdp/{session,connection,tabs} / pages/{composer,navigation,projects,search,messages,effort}).
- npm name is `chatgpt-cdp-cli` (`chatgpt-cli` was already taken on npm by an unrelated package).


## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
