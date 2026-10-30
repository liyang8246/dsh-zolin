# dsh-model-accounts

Independent account bundle in the dsh-zolin monorepo. Read the root AGENTS.md too.

- Keep `zephyr/accounts` grant/version 1, `zephyr-*` model routes, `zephyr_accounts`, `/api/zephyr-models`, and `zephyr-pi` replay envelopes compatible with existing profiles/sessions.
- Secrets and selections live only in the Harness credential record. No browser persistence, config, logs or tool output may contain credentials.
- Refresh under `credentials.modifyRecord` with a lock-time recheck. Once refresh starts, persist rotated tokens before respecting caller cancellation. Do not replace it with a per-instance promise cache.
- Authentication actions are user-only. Validate all JSON, token, organization, URL and module-loader boundaries; keep redirect restrictions, size limits and cancellation.
- Client React comes from Harness's module table. DSH imports are type-only; Host output bundles SDKs, Client output is an IIFE validated with `node:vm`.
- Settings and composer must subscribe to the same snapshot store. Every successful snapshot mutation publishes; old in-flight reads must not overwrite it. Keep the synchronization regression tests.
- Update models only explicitly with `pnpm models:update`; normal builds use the checked-in snapshot. Missing quota windows are unavailable, never zero usage.
- Package build/test run from this directory; shared lint, TypeScript/tooling and Vitest configuration live at the repository root. Run the root CI before delivery.
- Never reinstall into the live profile to test this copy without the user's explicit request. A source rebuild does not update the running desktop GUI.

<!-- clonedeps head -->
## Cloned Dependency Source

Read-only dependency sources are materialized under `.agents/clonedeps/repos/`. Keep this table in sync with `.agents/clonedeps/lock.json`; update the lock and run clonedeps `sync` when changing pinned references. Do not edit or execute cloned dependencies.

| Dependency | Version | Path |
| --- | --- | --- |
| `opencode` | `2.2.0` | `.agents/clonedeps/repos/opencode__510a` |

<!-- clonedeps tail -->
