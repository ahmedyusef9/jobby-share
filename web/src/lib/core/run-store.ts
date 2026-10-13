// In-memory store of detached runs, so a run outlives the HTTP request that
// started it.
//
// Why: the worker used to be wired directly into the response stream, and the
// stream's cancel() (which fires on ANY client disconnect — reload, navigation,
// tab close) killed the child. Reloading the page mid-evaluation therefore threw
// away the work with no report written. Here the child streams into a record that
// nobody owns, and connections come and go as subscribers.
//
// Snapshots are also written under `.career-ops-web/runs/{runId}.json` so a page
// refresh (or Next.js HMR that wipes this module Map) can still replay the log.

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tenantId, tenantRoot } from "@/lib/tenant";

export type RunEvent = { type: string } & Record<string, unknown>;

/** What a late subscriber needs to rebuild the UI. Kept compact rather than
 *  replaying every raw event: the client renders tool/status steps and assistant
 *  text as two separate fields, so folding text into one accumulator bounds memory
 *  without changing what can be displayed. */
type Snapshot = {
  steps: RunEvent[];
  text: string;
  terminal: RunEvent | null;
};

/** Why a run was stopped from outside. Without this the exit looks identical to a
 *  crash, and a deliberate stop gets reported as a possible install/auth failure. */
export type StopReason = "cancelled" | "timeout";

type RunRecord = {
  id: string;
  /**
   * WHOSE run this is (JOBBY-BL-047).
   *
   * This Map is one object shared by every request in the Node process, keyed by
   * run id alone. Run ids are `run-{Date.now()}-{seq}` — guessable — so without
   * an owner any signed-in user could poll another tenant's live run and read the
   * model's output, or stop it.
   */
  tenantId: string;
  kind: string;
  child: ChildProcess | null;
  snapshot: Snapshot;
  finished: boolean;
  createdAt: number;
  endedAt?: number;
  stopReason?: StopReason;
  subscribers: Set<(ev: RunEvent | null) => void>;
  persistTimer?: ReturnType<typeof setTimeout> | null;
};

export type PersistedRun = {
  id: string;
  kind: string;
  finished: boolean;
  createdAt: number;
  endedAt?: number;
  snapshot: Snapshot;
};

const MAX_STEPS = 500;
const MAX_TEXT_CHARS = 16_000;
/** How long a finished run stays in memory so a reload can still collect its
 *  result. Disk snapshots outlive this. */
const RETAIN_FINISHED_MS = 15 * 60_000;
/** Disk retention: delete run/job snapshots older than this (7 days). */
const DISK_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Cap total files under runs/ (json + md). Oldest mtime wins. */
const DISK_MAX_FILES = 120;

const runs = new Map<string, RunRecord>();

/**
 * A run, but only if it belongs to the caller's tenant.
 *
 * Every exported lookup goes through this rather than `runs.get()`, so a new
 * accessor cannot forget the check. Reads the ambient tenant, which withTenant
 * has already resolved from the verified session.
 */
function owned(id: string): RunRecord | undefined {
  const run = runs.get(id);
  if (!run) return undefined;
  return run.tenantId === tenantId() ? run : undefined;
}
let seq = 0;
let gcCounter = 0;

function runsDir(): string {
  return path.join(tenantRoot(), ".career-ops-web", "runs");
}

function snapshotPath(id: string): string {
  const safe = id.replace(/[^a-z0-9_-]/gi, "");
  return path.join(runsDir(), `${safe}.json`);
}

/** Prune old run logs so `.career-ops-web/runs` does not grow forever. */
export function gcPersistedRuns(): { deleted: number } {
  const dir = runsDir();
  let deleted = 0;
  try {
    if (!fs.existsSync(dir)) return { deleted: 0 };
    const now = Date.now();
    const entries = fs
      .readdirSync(dir)
      .filter((n) => /\.(json|md)$/i.test(n))
      .map((name) => {
        const full = path.join(dir, name);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          /* skip */
        }
        return { name, full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const e of entries) {
      const tooOld = e.mtime > 0 && now - e.mtime > DISK_MAX_AGE_MS;
      const overCap = entries.indexOf(e) >= DISK_MAX_FILES;
      if (!tooOld && !overCap) continue;
      try {
        fs.unlinkSync(e.full);
        deleted += 1;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return { deleted };
}

function writeSnapshot(run: RunRecord): void {
  try {
    fs.mkdirSync(runsDir(), { recursive: true });
    const payload: PersistedRun = {
      id: run.id,
      kind: run.kind,
      finished: run.finished,
      createdAt: run.createdAt,
      endedAt: run.endedAt,
      snapshot: run.snapshot,
    };
    fs.writeFileSync(snapshotPath(run.id), JSON.stringify(payload));
    // Opportunistic GC every ~25 writes
    gcCounter += 1;
    if (gcCounter % 25 === 0) gcPersistedRuns();
  } catch {
    /* disk full / race — live subscribers still work */
  }
}

function schedulePersist(run: RunRecord): void {
  if (run.persistTimer) return;
  run.persistTimer = setTimeout(() => {
    run.persistTimer = null;
    writeSnapshot(run);
  }, 800);
}

/** Load a run snapshot from disk (finished or interrupted mid-flight). */
export function loadPersistedRun(id: string): PersistedRun | null {
  try {
    const raw = fs.readFileSync(snapshotPath(id), "utf8");
    const data = JSON.parse(raw) as PersistedRun;
    if (!data?.id || !data.snapshot) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * If memory lost a *finished* run (HMR / GC) but disk has it, hydrate so
 * subscribe() can replay. Unfinished disk-only runs stay for poll() — we cannot
 * resume an orphaned child after HMR.
 */
export function hydrateFromDisk(id: string): boolean {
  if (owned(id)) return true;
  // loadPersistedRun reads this tenant's own runs/ directory, so anything it
  // returns belongs to the caller by construction.
  const disk = loadPersistedRun(id);
  if (!disk?.finished) return false;
  runs.set(id, {
    id: disk.id,
    tenantId: tenantId(),
    kind: disk.kind || "evaluate",
    child: null,
    snapshot: disk.snapshot,
    finished: true,
    createdAt: disk.createdAt || Date.now(),
    endedAt: disk.endedAt ?? Date.now(),
    subscribers: new Set(),
  });
  return true;
}

/** Prefer live memory, else disk — used by the poll API (Workers refresh). */
export function getRunStatus(id: string): PersistedRun | null {
  const mem = owned(id);
  if (mem) {
    return {
      id: mem.id,
      kind: mem.kind,
      finished: mem.finished,
      createdAt: mem.createdAt,
      endedAt: mem.endedAt,
      snapshot: mem.snapshot,
    };
  }
  return loadPersistedRun(id);
}

/** Tail helper for poll responses — last N lines of assistant text. */
export function tailText(text: string, maxLines = 80): string {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
}

export function newRunId(): string {
  seq += 1;
  return `run-${Date.now()}-${seq}`;
}

export function createRun(id: string, kind: string, child: ChildProcess | null): void {
  const run: RunRecord = {
    id,
    tenantId: tenantId(),
    kind,
    child,
    snapshot: { steps: [], text: "", terminal: null },
    finished: false,
    createdAt: Date.now(),
    subscribers: new Set(),
  };
  runs.set(id, run);
  writeSnapshot(run);
}

export function hasRun(id: string): boolean {
  if (owned(id)) return true;
  return hydrateFromDisk(id);
}

/**
 * Buffer an event into the snapshot and fan it out to any live subscribers.
 *
 * Deliberately NOT owner-checked: this is a writer, called by the server with an
 * id it minted itself, from child-process callbacks that run after the request
 * has ended — where there is no ambient tenant to compare against. The reader
 * side is where a client-supplied id arrives, and that is what `owned()` guards.
 */
export function emit(id: string, ev: RunEvent): void {
  const run = runs.get(id);
  if (!run) return;

  const { snapshot } = run;
  if (ev.type === "text") {
    snapshot.text = (snapshot.text + String(ev.text ?? "")).slice(-MAX_TEXT_CHARS);
  } else if (ev.type === "tool" || ev.type === "status") {
    snapshot.steps.push(ev);
    // Drop from the front: a long run's recent steps are the informative ones.
    if (snapshot.steps.length > MAX_STEPS) snapshot.steps.splice(0, snapshot.steps.length - MAX_STEPS);
  } else if (ev.type === "done" || ev.type === "error") {
    snapshot.terminal = ev;
  }

  schedulePersist(run);

  for (const send of run.subscribers) {
    try {
      send(ev);
    } catch {
      /* a broken subscriber must not stop the others or the run */
    }
  }
}

/** Mark the run over and close out every subscriber. Internal writer; see emit(). */
export function endRun(id: string): void {
  const run = runs.get(id);
  if (!run || run.finished) return;

  run.finished = true;
  run.endedAt = Date.now();
  if (run.persistTimer) {
    clearTimeout(run.persistTimer);
    run.persistTimer = null;
  }
  writeSnapshot(run);

  for (const send of run.subscribers) {
    try {
      send(null);
    } catch {
      /* ignore */
    }
  }
  run.subscribers.clear();

  setTimeout(() => runs.delete(id), RETAIN_FINISHED_MS).unref?.();
}

/**
 * Attach to a run. Replays the snapshot first so a reattaching client rebuilds
 * the same view, then receives live events. `onEvent(null)` signals the end.
 * Returns an unsubscribe that does NOT touch the child — detaching is not cancelling.
 */
export function subscribe(id: string, onEvent: (ev: RunEvent | null) => void): () => void {
  hydrateFromDisk(id);
  const run = owned(id);
  if (!run) return () => {};

  // `replay: true` lets the client reset its buffers before re-applying state,
  // so a reattach cannot double-count steps it already rendered.
  onEvent({ type: "replay", id });
  for (const step of run.snapshot.steps) onEvent(step);
  if (run.snapshot.text) onEvent({ type: "text", text: run.snapshot.text });

  if (run.finished) {
    if (run.snapshot.terminal) onEvent(run.snapshot.terminal);
    // Disk hydrates always finish; if no terminal, synthesize done so the
    // client settles instead of hanging on an open stream.
    else onEvent({ type: "done" });
    onEvent(null);
    return () => {};
  }

  run.subscribers.add(onEvent);
  return () => {
    run.subscribers.delete(onEvent);
  };
}

/**
 * Stop a run on purpose — a user cancel or the time cap. Detaching never does
 * this. The reason is recorded so the exit handler can describe what happened
 * instead of guessing at a cause.
 */
export function killRun(id: string, reason: StopReason = "cancelled"): boolean {
  const run = owned(id);
  if (!run || run.finished || !run.child) return false;
  run.stopReason = reason;
  try {
    run.child.kill("SIGTERM");
  } catch {
    return false;
  }
  return true;
}

export function getStopReason(id: string): StopReason | undefined {
  return owned(id)?.stopReason;
}
