import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { MissingTenantContextError, runWithTenant, tenantId } from "./context.mjs";
import { defaultTenantId, tenantIdFromSubject } from "./ids.mjs";
import { ensureDefaultTenantMigrated } from "./migrate.mjs";
import {
  assertInsideTenant,
  platformRoot,
  rejectMismatchedTenantId,
  tenantFile,
  tenantRoot,
} from "./paths.mjs";

const origRoot = process.env.CAREER_OPS_ROOT;

afterEach(() => {
  if (origRoot === undefined) delete process.env.CAREER_OPS_ROOT;
  else process.env.CAREER_OPS_ROOT = origRoot;
});

test("tenantRoot without context throws", () => {
  process.env.CAREER_OPS_ROOT = os.tmpdir();
  assert.throws(() => tenantRoot(), MissingTenantContextError);
  assert.throws(() => tenantId(), /without request context/);
});

test("two concurrent sessions read different cv.md", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jobby-tenant-"));
  process.env.CAREER_OPS_ROOT = base;
  const aDir = path.join(base, "tenants", "alpha");
  const bDir = path.join(base, "tenants", "beta");
  fs.mkdirSync(aDir, { recursive: true });
  fs.mkdirSync(bDir, { recursive: true });
  fs.writeFileSync(path.join(aDir, "cv.md"), "cv-a");
  fs.writeFileSync(path.join(bDir, "cv.md"), "cv-b");

  const [a, b] = await Promise.all([
    runWithTenant({ tenantId: "alpha" }, () => fs.readFileSync(tenantFile("cv.md"), "utf8")),
    runWithTenant({ tenantId: "beta" }, () => fs.readFileSync(tenantFile("cv.md"), "utf8")),
  ]);
  assert.equal(a, "cv-a");
  assert.equal(b, "cv-b");
  assert.notEqual(a, b);
});

test("../ traversal in a path param is rejected", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jobby-tenant-"));
  process.env.CAREER_OPS_ROOT = base;
  runWithTenant({ tenantId: "alpha" }, () => {
    fs.mkdirSync(tenantRoot(), { recursive: true });
    const escaped = path.resolve(tenantRoot(), "..", "..", "etc", "passwd");
    assert.throws(() => assertInsideTenant(escaped), /escapes tenant root/);
    assert.throws(() => tenantFile("..", "beta", "cv.md"), /escapes tenant root/);
  });
});

test("path tenantId mismatching session returns 403", () => {
  process.env.CAREER_OPS_ROOT = os.tmpdir();
  runWithTenant({ tenantId: "alpha" }, () => {
    try {
      rejectMismatchedTenantId("beta");
      assert.fail("expected throw");
    } catch (err) {
      assert.equal(/** @type {{ status?: number }} */ (err).status, 403);
    }
    rejectMismatchedTenantId(null);
    rejectMismatchedTenantId("alpha");
  });
});

test("migrate moves user-layer files into tenants/default", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jobby-migrate-"));
  fs.writeFileSync(path.join(base, "cv.md"), "mine");
  fs.mkdirSync(path.join(base, "data"));
  fs.writeFileSync(path.join(base, "data", "pipeline.md"), "- [ ] url");
  fs.writeFileSync(path.join(base, "doctor.mjs"), "system");

  const first = ensureDefaultTenantMigrated(base);
  assert.equal(first.moved, true);
  const dest = path.join(base, "tenants", defaultTenantId());
  assert.equal(fs.readFileSync(path.join(dest, "cv.md"), "utf8"), "mine");
  assert.ok(fs.existsSync(path.join(dest, "data", "pipeline.md")));
  assert.ok(fs.existsSync(path.join(base, "doctor.mjs")));
  assert.ok(!fs.existsSync(path.join(base, "cv.md")));

  const second = ensureDefaultTenantMigrated(base);
  assert.equal(second.moved, false);
});

test("tenantIdFromSubject is stable and path-safe", () => {
  const a = tenantIdFromSubject("github", "12345");
  const b = tenantIdFromSubject("github", "12345");
  const c = tenantIdFromSubject("google", "12345");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^t_[a-f0-9]{16}$/);
});

test("careerOpsRoot is not exported", () => {
  const src = fs.readFileSync(new URL("../career-ops.ts", import.meta.url), "utf8");
  assert.equal(/export function careerOpsRoot/.test(src), false);
  assert.match(src, /tenantRoot\(\)/);
});

test("platformRoot is the volume, tenantRoot is nested", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jobby-plat-"));
  process.env.CAREER_OPS_ROOT = base;
  assert.equal(platformRoot(), path.resolve(base));
  runWithTenant({ tenantId: "alpha" }, () => {
    assert.equal(tenantRoot(), path.resolve(base, "tenants", "alpha"));
  });
});
