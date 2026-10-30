# dsh-zolin

pnpm monorepo: `packages/zephyr` provides the Zephyr preset; `packages/model-accounts` provides profile-wide model accounts. Neither package depends on the other.

- Never change the original `D:\dsh-zephyr` checkout or a live Harness profile while developing this copy.
- Run `pnpm lint:fix` then `pnpm run ci`; `ci` includes lint, strict typechecking, both builds and Vitest tests.
- Use the unmodified default `@antfu/eslint-config` from the root; do not disable rules to hide errors. Keep shared tooling and the single lockfile at the root.
- Prefer TypeScript. Keep types explicit at JSON, credential and module-loader boundaries. Do not add runtime React or Cordis copies.
- Temporary scripts/caches/test artifacts belong in system temp and must be cleaned up.
- Install or remove package bundles only through Harness Plugin Manager. Do not hand-edit profile manifests/patches or install the monorepo root as a bundle.
- Preserve legacy preset/provider/tool/RPC/credential/replay identifiers unless an explicit migration is requested. Never activate the old combined bundle and these packages together.
- Read package-specific AGENTS.md before changing runtime code. Host output is self-contained ESM; Client output is a separately validated classic IIFE.
