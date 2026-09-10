import { greeting } from "./kernel/greet";
export default function app() {
  return { fetch: (_req: Request) => new Response(greeting), shutdown: async () => {} };
}
