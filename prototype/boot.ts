// Approach B: child process blue/green behind an in-process proxy. Fresh module cache, crash isolation, memory freed.
import { watch } from "node:fs";
const entry = `${import.meta.dir}/app/main.ts`;
const ports = [4101, 4102];
let gen = 0;
type Child = { proc: ReturnType<typeof Bun.spawn>; port: number };
let current: Child | undefined;
async function start(): Promise<Child> {
  const port = ports[gen++ % 2]!;
  const proc = Bun.spawn(["bun", entry], { env: { ...process.env, PORT: String(port) }, stdout: "inherit", stderr: "pipe" });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`child exited ${proc.exitCode}: ${await new Response(proc.stderr).text()}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { proc, port }; } catch {}
    await Bun.sleep(20);
  }
  proc.kill(); throw new Error("child never became healthy");
}
current = await start();
const server = Bun.serve({
  port: 3997,
  async fetch(req) {
    if (new URL(req.url).pathname === "/_boot/status") return new Response(`gen=${gen} port=${current?.port}`);
    const url = new URL(req.url); url.hostname = "127.0.0.1"; url.port = String(current!.port);
    return fetch(new Request(url, req));
  },
});
let timer: Timer | undefined;
watch(`${import.meta.dir}/app`, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const t0 = performance.now();
    try { const next = await start(); const old = current!; current = next; setTimeout(() => old.proc.kill("SIGTERM"), 200); console.log(`swapped to ${next.port} in ${(performance.now()-t0).toFixed(1)}ms`); }
    catch (e) { console.log("start failed, keeping old:", String(e).split("\n")[0]); }
  }, 50);
});
console.log("up");
