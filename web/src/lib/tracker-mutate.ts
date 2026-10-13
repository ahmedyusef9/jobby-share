/**
 * Tracker writes shared by the web routes and MCP (D-030). New rows still go
 * through TSV + merge-tracker.mjs — never a hand-edit of applications.md.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readApplications, rootScript, tenantScriptEnv, trackerCanDelete } from "@/lib/career-ops";
import { tenantRoot } from "@/lib/tenant";
import { canonicalizeStatus } from "@/lib/core/states";
import { acquireTrackerWrite, isTrackerWriting, releaseTrackerWrite } from "@/lib/core/run-registry";
import { atomicWrite } from "@/lib/core/safe-write";
import { normalizeTrackerScore, urlFromNotes } from "../../../scripts/tracker-score.mjs";

export { normalizeTrackerScore, urlFromNotes };

const ADD_ALLOWED = new Set(["Applied", "Discarded", "SKIP", "Evaluated", "Rejected"]);

function scrubCell(s: string): string {
  return s.replace(/[|\r\n\t*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "role";
}

function nextTrackerNum(root: string): number {
  let max = 0;
  for (const a of readApplications()) {
    const n = parseInt(a.n, 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  try {
    for (const f of fs.readdirSync(path.join(root, "reports"))) {
      const n = parseInt(f, 10);
      if (Number.isFinite(n)) max = Math.max(max, n);
    }
  } catch {
    /* no reports dir */
  }
  const addDir = path.join(root, "batch", "tracker-additions");
  try {
    for (const f of fs.readdirSync(addDir)) {
      if (!f.endsWith(".tsv")) continue;
      const n = parseInt(f, 10);
      if (Number.isFinite(n)) max = Math.max(max, n);
    }
  } catch {
    /* no additions dir */
  }
  return max + 1;
}

function notesHasUrl(notes: string, url: string): boolean {
  if (!url || !notes) return false;
  return notes.includes(url);
}

export function findExistingApplication(company: string, role: string, url: string) {
  const c = company.trim().toLowerCase();
  const r = role.trim().toLowerCase();
  for (const a of readApplications()) {
    if (url && notesHasUrl(a.notes, url)) return a;
    if (a.company.trim().toLowerCase() === c && a.role.trim().toLowerCase() === r) return a;
  }
  return null;
}

function columnIndex(lines: string[], name: string, fallback: number): number {
  for (const l of lines) {
    if (!l.trim().startsWith("|")) continue;
    const cells = l.split("|").map((c) => c.trim().toLowerCase());
    const idx = cells.findIndex((cell) => cell === name);
    if (idx > 0) return idx;
    if (/^:?-{2,}:?$/.test(cells[1] ?? "")) break;
  }
  return fallback;
}

function statusColumnIndex(lines: string[]): number {
  return columnIndex(lines, "status", 6);
}

function scoreColumnIndex(lines: string[]): number {
  return columnIndex(lines, "score", 5);
}

function notesColumnIndex(lines: string[]): number {
  return columnIndex(lines, "notes", -1);
}

/**
 * Patch status / score / notes on an existing tracker row by number.
 */
export function patchApplicationRow(
  n: string,
  patch: { status?: string; score?: string; notes?: string; appendNotes?: boolean },
): { ok: true; n: string; status?: string; score?: string } {
  const file = path.join(tenantRoot(), "data", "applications.md");
  let md: string;
  try {
    md = fs.readFileSync(file, "utf8");
  } catch {
    const err = new Error("tracker not found");
    (err as { status?: number }).status = 404;
    throw err;
  }
  const lines = md.split("\n");
  const statusIdx = statusColumnIndex(lines);
  const scoreIdx = scoreColumnIndex(lines);
  let notesIdx = notesColumnIndex(lines);
  const want = String(parseInt(n, 10));
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const parts = lines[i].split("|");
    if (parts.length < 8) continue;
    const rowN = String(parseInt(parts[1].trim(), 10));
    if (rowN !== want) continue;
    if (notesIdx < 0 || notesIdx >= parts.length - 1) notesIdx = parts.length - 2;
    if (patch.status) {
      if (statusIdx >= parts.length - 1) continue;
      parts[statusIdx] = ` ${patch.status} `;
    }
    if (patch.score != null && patch.score !== "") {
      if (scoreIdx < parts.length - 1) parts[scoreIdx] = ` ${patch.score} `;
    }
    if (patch.notes != null && patch.notes !== "") {
      const prev = (parts[notesIdx] ?? "").trim();
      const next = patch.appendNotes && prev && !prev.includes(patch.notes) ? `${prev} · ${patch.notes}` : patch.notes;
      // Notes get a wider cap than other cells: appended provenance tags
      // ([scored-by: …]) must survive, or score idempotency breaks (#53).
      parts[notesIdx] = ` ${next.replace(/[|\r\n\t*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400)} `;
    }
    lines[i] = parts.join("|");
    atomicWrite(file, lines.join("\n"));
    return {
      ok: true,
      n: want,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.score ? { score: patch.score } : {}),
    };
  }
  const err = new Error("row not found");
  (err as { status?: number }).status = 404;
  throw err;
}

function rewriteStatus(n: string, status: string): boolean {
  try {
    patchApplicationRow(n, { status });
    return true;
  } catch {
    return false;
  }
}

function runMerge(root: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(process.execPath, [rootScript("merge-tracker")], {
        cwd: root,
        env: tenantScriptEnv(),
      });
    } catch (e) {
      resolve({ code: 1, out: "", err: e instanceof Error ? e.message : "failed to start merge-tracker" });
      return;
    }
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 60_000);
    child.on("error", (e) => {
      clearTimeout(killer);
      resolve({ code: 1, out, err: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, out, err });
    });
  });
}

export type AddApplicationInput = {
  company?: string;
  role?: string;
  url?: string;
  status?: string;
  notes?: string;
  score?: string | number;
};

export type UpdateJobInput = {
  n?: string;
  url?: string;
  company?: string;
  role?: string;
  status?: string;
  notes?: string;
  score?: string | number;
  appendNotes?: boolean;
};

export async function addManualApplication(input: AddApplicationInput) {
  const company = scrubCell(String(input.company ?? ""));
  const role = scrubCell(String(input.role ?? ""));
  const url = String(input.url ?? "").trim();
  const extraNotes = scrubCell(String(input.notes ?? ""));
  const score = normalizeTrackerScore(input.score);
  const canon = canonicalizeStatus(String(input.status ?? "Applied"));

  if (!company || !role) {
    const err = new Error("company and role required");
    (err as { status?: number }).status = 400;
    throw err;
  }
  if (!canon || !ADD_ALLOWED.has(canon)) {
    const err = new Error(`status must be one of: ${[...ADD_ALLOWED].join(", ")}`);
    (err as { status?: number }).status = 400;
    throw err;
  }
  if (url && !/^https?:\/\//i.test(url)) {
    const err = new Error("url must be http(s)");
    (err as { status?: number }).status = 400;
    throw err;
  }
  if (isTrackerWriting()) {
    const err = new Error("The tracker is busy — try again in a moment.");
    (err as { status?: number }).status = 409;
    throw err;
  }

  const existing = findExistingApplication(company, role, url);
  if (existing) {
    const noteParts = [url && !notesHasUrl(existing.notes, url) ? `url=${url}` : "", extraNotes].filter(Boolean);
    const notesPatch = noteParts.length ? noteParts.join(" · ") : "";
    const needsStatus = existing.status !== canon;
    const needsNotes = Boolean(notesPatch);
    const needsScore = Boolean(score) && existing.score !== score;
    if (!needsStatus && !needsNotes && !needsScore) {
      return { ok: true, n: existing.n, status: canon, score: existing.score, created: false, updated: false };
    }
    patchApplicationRow(existing.n, {
      ...(needsStatus ? { status: canon } : {}),
      ...(needsScore ? { score } : {}),
      ...(needsNotes ? { notes: notesPatch, appendNotes: true } : {}),
    });
    return {
      ok: true,
      n: existing.n,
      status: canon,
      score: score || existing.score,
      created: false,
      updated: true,
    };
  }

  const root = tenantRoot();
  const token = acquireTrackerWrite();
  try {
    const num = nextTrackerNum(root);
    const numStr = String(num).padStart(3, "0");
    const date = new Date().toISOString().slice(0, 10);
    const noteParts = [url ? `url=${url}` : "", extraNotes].filter(Boolean);
    const notes = noteParts.join(" · ") || "manual add (no evaluation)";
    // TSV: status before score (merge-tracker swaps into applications.md order)
    const line = [num, date, company, role, canon, score || "N/A", "❌", "—", notes].join("\t") + "\n";
    const dir = path.join(root, "batch", "tracker-additions");
    fs.mkdirSync(dir, { recursive: true });
    const tsvPath = path.join(dir, `${numStr}-${slugify(company)}.tsv`);
    fs.writeFileSync(tsvPath, line, "utf8");

    const merge = await runMerge(root);
    if (merge.code !== 0) {
      try {
        fs.unlinkSync(tsvPath);
      } catch {
        /* leave for debug */
      }
      const err = new Error(merge.err.trim().split("\n")[0] || merge.out.trim() || "merge-tracker failed");
      (err as { status?: number }).status = 500;
      throw err;
    }

    const after = findExistingApplication(company, role, url);
    return {
      ok: true,
      n: after?.n ?? String(num),
      status: canon,
      score: score || "N/A",
      created: true,
      updated: false,
    };
  } finally {
    releaseTrackerWrite(token);
  }
}

/** Update an existing tracker row by n, url, or company+role. */
export function updateJobPosting(input: UpdateJobInput) {
  const nRaw = String(input.n ?? "").trim();
  const url = String(input.url ?? "").trim();
  const company = scrubCell(String(input.company ?? ""));
  const role = scrubCell(String(input.role ?? ""));
  const score = normalizeTrackerScore(input.score);
  const notes = scrubCell(String(input.notes ?? ""));
  let status = "";
  if (input.status != null && String(input.status).trim()) {
    const canon = canonicalizeStatus(String(input.status));
    if (!canon || !ADD_ALLOWED.has(canon)) {
      const err = new Error(`status must be one of: ${[...ADD_ALLOWED].join(", ")}`);
      (err as { status?: number }).status = 400;
      throw err;
    }
    status = canon;
  }
  if (!nRaw && !url && !(company && role)) {
    const err = new Error("n, url, or company+role required");
    (err as { status?: number }).status = 400;
    throw err;
  }
  if (!status && !score && !notes) {
    const err = new Error("status, score, or notes required");
    (err as { status?: number }).status = 400;
    throw err;
  }

  let target = nRaw ? readApplications().find((a) => String(parseInt(a.n, 10)) === String(parseInt(nRaw, 10))) : null;
  if (!target && (url || (company && role))) {
    target = findExistingApplication(company || "—", role || "—", url);
  }
  if (!target) {
    const err = new Error("row not found");
    (err as { status?: number }).status = 404;
    throw err;
  }

  return patchApplicationRow(target.n, {
    ...(status ? { status } : {}),
    ...(score ? { score } : {}),
    ...(notes ? { notes, appendNotes: Boolean(input.appendNotes) } : {}),
  });
}

export function searchApplications(opts: {
  query?: string;
  status?: string;
  company?: string;
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
}) {
  const q = String(opts.query ?? "").trim().toLowerCase();
  const status = String(opts.status ?? "").trim().toLowerCase();
  const company = String(opts.company ?? "").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const from = String(opts.from ?? "").trim();
  const to = String(opts.to ?? "").trim();
  const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  let rows = readApplications();
  if (status) rows = rows.filter((a) => a.status.toLowerCase() === status);
  if (company) rows = rows.filter((a) => a.company.toLowerCase().includes(company));
  if (q) {
    rows = rows.filter((a) =>
      `${a.company} ${a.role} ${a.notes} ${a.score} ${a.status}`.toLowerCase().includes(q),
    );
  }
  if (from && validDate(from)) rows = rows.filter((a) => a.date && a.date >= from);
  if (to && validDate(to)) rows = rows.filter((a) => a.date && a.date <= to);
  const matched = rows.length;
  const page = rows.slice(offset, offset + limit);
  return {
    matched,
    shown: page.length,
    offset,
    rows: page,
  };
}

export function trackerStatusCounts() {
  const counts: Record<string, number> = {};
  for (const a of readApplications()) {
    const k = a.status || "—";
    counts[k] = (counts[k] || 0) + 1;
  }
  return { total: readApplications().length, byStatus: counts };
}

export function updateApplicationStatus(ns: string[], status: string) {
  if (/[|\r\n*]/.test(status)) {
    const err = new Error("invalid status (table-breaking characters)");
    (err as { status?: number }).status = 400;
    throw err;
  }
  const canon = canonicalizeStatus(status);
  if (!canon) {
    const err = new Error(`not a canonical status: ${status}`);
    (err as { status?: number }).status = 400;
    throw err;
  }
  const want = [...new Set(ns.map((n) => String(parseInt(n, 10))).filter((n) => n && !Number.isNaN(Number(n))))];
  if (!want.length) {
    const err = new Error("no valid application numbers");
    (err as { status?: number }).status = 400;
    throw err;
  }

  const file = path.join(tenantRoot(), "data", "applications.md");
  let md: string;
  try {
    md = fs.readFileSync(file, "utf8");
  } catch {
    const err = new Error("tracker not found");
    (err as { status?: number }).status = 404;
    throw err;
  }

  const lines = md.split("\n");
  const statusIdx = statusColumnIndex(lines);
  const remaining = new Set(want);
  const updated: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const parts = lines[i].split("|");
    if (parts.length < 8) continue;
    const rowN = String(parseInt(parts[1].trim(), 10));
    if (!rowN || Number.isNaN(Number(rowN)) || !remaining.has(rowN)) continue;
    if (statusIdx >= parts.length - 1) continue;
    parts[statusIdx] = ` ${canon} `;
    lines[i] = parts.join("|");
    remaining.delete(rowN);
    updated.push(rowN);
    if (remaining.size === 0) break;
  }
  if (!updated.length) {
    const err = new Error("row not found");
    (err as { status?: number }).status = 404;
    throw err;
  }
  atomicWrite(file, lines.join("\n"));
  return { ok: true, status: canon, updated, missing: [...remaining] };
}

export async function deleteApplication(n: string, dryRun = false) {
  if (!/^\d+$/.test(n)) {
    const err = new Error("a numeric application number is required");
    (err as { status?: number }).status = 400;
    throw err;
  }
  if (!trackerCanDelete()) {
    const err = new Error("Removing a tracker row needs a newer career-ops.");
    (err as { status?: number }).status = 400;
    throw err;
  }
  if (isTrackerWriting()) {
    const err = new Error("The tracker is busy — try again in a moment.");
    (err as { status?: number }).status = 409;
    throw err;
  }

  const args = [rootScript("tracker"), "delete", "--num", n];
  if (dryRun) args.push("--dry-run");

  const result = await new Promise<{ code: number | null; err: string }>((resolve) => {
    let err = "";
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: tenantRoot(), env: tenantScriptEnv() });
    } catch (e) {
      resolve({ code: 1, err: e instanceof Error ? e.message : "failed to start tracker.mjs" });
      return;
    }
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.stdout.on("data", () => {
      /* drain */
    });
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 30_000);
    child.on("error", (e) => {
      clearTimeout(killer);
      resolve({ code: 1, err: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, err });
    });
  });

  if (result.code !== 0) {
    const err = new Error(result.err.trim().split("\n")[0] || "delete failed");
    (err as { status?: number }).status = /No application numbered/i.test(result.err) ? 404 : 400;
    throw err;
  }
  return { ok: true, dryRun };
}
