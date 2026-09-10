# prototype: hot-reloading bootloader

Proof for SPEC.md §7.1. `boot.ts` owns the public port and proxies to a child Bun process running `app/main.ts`.
Any change under `app/` spawns a new child on the other internal port, waits for `/health`, flips traffic, and SIGTERMs the old one.

```
bun boot.ts                     # http://localhost:3997
bun hammer.ts 3997 3000         # in another shell: 16 clients for 3s, prints {ok, fail, bodies}
sed -i '' 's/v1/v2/' app/kernel/greet.ts   # while hammering: swap, zero failures
echo 'broken' > app/kernel/greet.ts        # rejected, old child keeps serving
```
