import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { runWithTenant, tenantId } from "@/lib/tenant";
import { rejectMismatchedTenantId } from "@/lib/tenant";
import { accountForTenantStrict, sessionStillValid } from "@/lib/accounts";

function httpError(err: unknown): NextResponse | null {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : "error";
  if (status === 401) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (status === 403) return NextResponse.json({ error: "tenant mismatch" }, { status: 403 });
  if (status === 400) return NextResponse.json({ error: message || "bad path" }, { status: 400 });
  if (status === 404 || status === 409 || status === 503) {
    return NextResponse.json({ error: message }, { status });
  }
  if (err instanceof Error && err.name === "MissingTenantContextError") {
    return NextResponse.json({ error: "missing tenant context" }, { status: 500 });
  }
  return null;
}

function tenantFromRequest(req: Request | undefined, params: Record<string, string> | undefined) {
  if (params?.tenantId) rejectMismatchedTenantId(params.tenantId);
  if (!req) return;
  try {
    const url = new URL(req.url);
    rejectMismatchedTenantId(url.searchParams.get("tenantId"));
  } catch {
    /* ignore */
  }
}

type AnyHandler = (...args: never[]) => unknown | Promise<unknown>;

/** Bind ALS from the verified session. tenantId is never taken from the client. */
export function withTenant<H extends AnyHandler>(handler: H): H {
  const wrapped = async (...args: unknown[]) => {
    const session = await auth();
    const id = session?.tenantId;
    if (!session?.user || !id) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const account = await accountForTenantStrict(id);
    if (!(await sessionStillValid(id, session.sv, account))) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const req = args[0] instanceof Request ? args[0] : undefined;
    const ctx = args[1] as { params?: Promise<Record<string, string>> } | undefined;
    try {
      return await runWithTenant({ tenantId: id, account }, async () => {
        const params = ctx?.params ? await ctx.params : undefined;
        tenantFromRequest(req, params);
        return handler(...(args as never[]));
      });
    } catch (err) {
      const res = httpError(err);
      if (res) return res;
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return NextResponse.json({ error: "upstream timeout" }, { status: 503 });
      }
      throw err;
    }
  };
  return wrapped as unknown as H;
}

export async function withTenantPage<T>(render: () => T | Promise<T>): Promise<T> {
  const session = await auth();
  if (!session?.user || !session.tenantId) redirect("/signin");
  const account = await accountForTenantStrict(session.tenantId);
  if (!(await sessionStillValid(session.tenantId, session.sv, account))) redirect("/signin");
  return runWithTenant({ tenantId: session.tenantId, account }, () => render());
}

export { tenantId };
