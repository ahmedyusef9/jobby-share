#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { accountForTenantStrict } from "../../scripts/accounts.mjs";
import { acquireRunLock, beginScan, endScan } from "../../scripts/scan-quota.mjs";
import { parseScanLine, takeLines } from "../../scripts/scan-parse.mjs";
import { createRecorder, isProductive } from "../../scripts/scan-progress.mjs";
import { migrateDefaultTenant, platformRoot, jobProviderEnv, tenantChildEnv, tenantRoot, workerTenantId } from "./tenant-root.mjs";

/**
 * @param {string} scriptRel
 * @param {string[]} args
 * @param {Record<string,string>} extra
 * @param {{record: (e: object) => void} | null} recorder
 *   Fold the child's progress lines into a scan record as they arrive
 *   (JOBBY-BL-054). A queued scan used to report nothing at all between "started"
 *   and "done", which is why it was impossible to tell work from grinding.
 */
function runNode(scriptRel, args = [], extra = {}, recorder = null) {
  migrateDefaultTenant();
  fs.mkdirSync(path.join(tenantRoot(), ".home"), { recursive: true });
  return new Promise((resolve, reject) => {
    const script = path.join(platformRoot(), scriptRel);
    const child = spawn(process.execPath, [script, ...args], {
      cwd: tenantRoot(),
      env: tenantChildEnv(extra),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";

    // The scanner writes human progress to stdout, or to stderr in --json mode,
    // so both streams are parsed. `ctx` carries the current ATS between lines.
    const ctx = {};
    const buffers = { stdout: "", stderr: "" };
    const feed = (which, chunk) => {
      if (!recorder) return;
      const { lines, rest } = takeLines(buffers[which], chunk);
      buffers[which] = rest;
      for (const line of lines) {
        const event = parseScanLine(line, ctx);
        if (event) recorder.record(event);
      }
    };

    child.stdout?.on("data", (c) => {
      const text = c.toString();
      out += text;
      feed("stdout", text);
    });
    child.stderr?.on("data", (c) => {
      const text = c.toString();
      err += text;
      feed("stderr", text);
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${scriptRel} exited ${code}: ${err.slice(-500) || out.slice(-500)}`));
    });
  });
}

export async function executeScan(job) {
  const args = job.data.args || [];
  const tenant = workerTenantId();
  const account = await accountForTenantStrict(tenant);
  let eventId = job.data.scanEventId || null;
  if (eventId) {
    await acquireRunLock(tenant, { wait: true });
  } else {
    const reserved = await beginScan(account, tenant, { waitForLock: true });
    eventId = reserved.eventId;
  }
  console.log("[worker] scan", args.join(" "));
  const started = Date.now();
  const recorder = createRecorder(tenantRoot(), {
    scanId: String(job.id ?? eventId ?? started),
    tenantId: tenant,
    kind: "scan",
    startedAt: started,
  });
  try {
    const result = await runNode("scan.mjs", args, {}, recorder);
    const final = recorder.finish("ok");
    // The one line that answers "is it working or grinding?" without opening a UI.
    console.log(
      `[worker] scan done job=${job.id} discovered=${final.counts.discovered} ` +
        `companies=${final.counts.companiesScanned} unreachable=${final.counts.unreachable} ` +
        `productive=${isProductive(final)}`,
    );
    await endScan(tenant, eventId, { outcome: "ok", durationMs: Date.now() - started });
    return result;
  } catch (err) {
    recorder.finish("failed", { error: String(err?.message ?? err).slice(0, 400) });
    await endScan(tenant, eventId, { outcome: "failed", durationMs: Date.now() - started });
    throw err;
  }
}

export async function executePipeline(job) {
  /*
   * Same lock and accounting as a scan (JOBBY-BL-050).
   *
   * The fallback below is not a lighter version of scanning — it is `scan.mjs`
   * with no arguments, the full sweep. Without this the pipeline kind was a way
   * around both the daily cap and the one-at-a-time rule.
   */
  const tenant = workerTenantId();
  const account = await accountForTenantStrict(tenant);
  let eventId = job.data.scanEventId || null;
  if (eventId) {
    await acquireRunLock(tenant, { wait: true });
  } else {
    const reserved = await beginScan(account, tenant, { waitForLock: true });
    eventId = reserved.eventId;
  }

  // Whether the LLM pipeline can run is a question about *this tenant's* key,
  // not about the server's environment. Scanning is zero-token and always runs.
  const provider = jobProviderEnv("openrouter");

  /*
   * How many evaluations one queued run may buy (JOBBY-BL-055).
   *
   * The key is the tenant's, so this is not the operator's bill — but an
   * unbounded run is still a job that holds the worker for hours and hands
   * somebody a surprise invoice from a single click. The cheap filter stage
   * inside the runner enforces it; this only names the number.
   */
  const budget = process.env.JOBBY_EVAL_BUDGET?.trim() || "25";
  const started = Date.now();
  const recorder = createRecorder(tenantRoot(), {
    scanId: String(job.id ?? eventId ?? started),
    tenantId: tenant,
    kind: "pipeline",
    startedAt: started,
  });
  try {
    let result;
    if (provider.OPENROUTER_API_KEY) {
      console.log(`[worker] pipeline via openrouter-runner (eval budget ${budget})`);
      result = await runNode(
        "openrouter-runner.mjs",
        ["pipeline"],
        { ...provider, JOBBY_EVAL_BUDGET: budget },
        recorder,
      );
    } else {
      console.log("[worker] pipeline: tenant has no OpenRouter key — running scan only");
      result = await runNode("scan.mjs", [], {}, recorder);
    }
    const final = recorder.finish("ok");
    // What the run refused to buy is the number worth logging: an evaluation
    // count alone cannot tell a cheap run from a narrow one.
    if (final.prefilter) {
      const p = final.prefilter;
      console.log(
        `[worker] pipeline done job=${job.id} pending=${p.pending} evaluated=${p.selected} ` +
          `dropped=${p.dropped} deferred=${p.deferred} budget=${p.budget}`,
      );
    }
    await endScan(tenant, eventId, { outcome: "ok", durationMs: Date.now() - started });
    return result;
  } catch (err) {
    recorder.finish("failed", { error: String(err?.message ?? err).slice(0, 400) });
    await endScan(tenant, eventId, { outcome: "failed", durationMs: Date.now() - started });
    throw err;
  }
}
