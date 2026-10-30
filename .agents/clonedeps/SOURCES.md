# 上游源码快照

固定的上游源码位于 `.agents/clonedeps/repos/`，只读用于查证，不在其中运行代码。
版本与提交固定在 [lock.json](lock.json)；增删或升级依赖后更新 lock 并重新同步：

```sh
uv run .agents/skills/clonedeps/scripts/clonedeps.py sync --root . --agents .agents/clonedeps/SOURCES.md
```

<!-- clonedeps head -->
## Cloned Dependency Source

Read-only dependency source repositories are available under `.agents/clonedeps/repos/` for inspection. Do not edit these clones. Keep this list in sync with `.agents/clonedeps/lock.json`: when a dependency is added, removed or upgraded, update the lock file and run `sync`.

| Dependency | Version | Path |
| --- | --- | --- |
| `@deepseek-ai/dsh-root` | `0.2.1-rc.5` | `.agents/clonedeps/repos/@deepseek-ai__dsh-root__b830` |
| `codex-monorepo` | `0.166.0` | `.agents/clonedeps/repos/codex-monorepo__6ff1` |
| `opencode` | `2.2.0` | `.agents/clonedeps/repos/opencode__510a` |
| `pi-monorepo` | `0.0.3` | `.agents/clonedeps/repos/pi-monorepo__abe5` |

<!-- clonedeps tail -->
