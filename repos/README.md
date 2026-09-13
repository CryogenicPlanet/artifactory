# Reference sources

Read-only source snapshots cloned from upstream `main` on 2026-09-10. Nested `.git` metadata is removed so these files can be committed directly with chirp rather than becoming gitlinks. Upstream licenses are retained. Do not install dependencies here or import these sources into chirp.

| Directory | Upstream | Revision |
| --- | --- | --- |
| `effect/` | https://github.com/Effect-TS/effect.git | `716e0c00942b42d36631b3114b1deb9a4a944ce3` |
| `pi-mono/` | https://github.com/earendil-works/pi.git | `08dc60bc52d89d6823a9738cc90b1916e5e446e5` |

Effect's snapshot is version `4.0.0-rc.113`, matching the installed runtime. Start with `effect/packages/effect/src/` and `pi-mono/packages/coding-agent/examples/extensions/` for reference patterns.

To commit complete pristine snapshots, stage these directories with `git add -f repos/effect repos/pi-mono`; some upstream-tracked fixtures match ignore rules. No commit has been created by the clone step.

To update, clone upstream into a temporary directory, record its revision, and replace the corresponding snapshot excluding `.git`. Review the diff before committing. These are source snapshots, not git submodules or initialized git subtrees.
