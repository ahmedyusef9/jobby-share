export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureDefaultTenantMigrated } = await import("./lib/tenant/migrate.mjs");
  ensureDefaultTenantMigrated();
}
