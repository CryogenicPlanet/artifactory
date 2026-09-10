// fire requests continuously for N ms, count failures and distinct bodies
const [port, ms] = [process.argv[2], Number(process.argv[3])];
const end = Date.now() + ms; let ok = 0, fail = 0; const seen = new Map<string, number>();
const worker = async () => { while (Date.now() < end) { try { const b = await (await fetch(`http://localhost:${port}/`)).text(); ok++; seen.set(b, (seen.get(b) ?? 0) + 1); } catch { fail++; } } };
await Promise.all(Array.from({ length: 16 }, worker));
console.log(JSON.stringify({ ok, fail, bodies: Object.fromEntries(seen) }));
