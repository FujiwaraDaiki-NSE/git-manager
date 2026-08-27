/**
 * backend へのプロキシ。
 *
 * backend はポートを公開しないため、ブラウザからの /api/* は必ずここを通る。
 * next.config の rewrites を使わないのは、行き先がビルド時に固定されてしまい
 * compose の環境変数で切り替えられなくなるため。
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const backendOrigin = () => process.env.BACKEND_ORIGIN ?? "http://backend:8000";

async function proxy(req: Request, path: string[]): Promise<Response> {
  const search = new URL(req.url).search;
  const target = `${backendOrigin()}/api/${path.join("/")}${search}`;

  const headers: Record<string, string> = {};
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  if (req.headers.get("accept")) headers["accept"] = req.headers.get("accept")!;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { error: "backend に接続できません" },
      { status: 502 }
    );
  }

  // SSE をそのまま流すため body を触らずに返す
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

export async function GET(req: Request, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx.params.path);
}

export async function POST(req: Request, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx.params.path);
}
