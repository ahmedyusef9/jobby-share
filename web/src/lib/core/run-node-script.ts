import { spawn } from "node:child_process";

/**
 * Run a Node script with process.execPath + spawn.
 * Avoid execFile("node", …) — Turbopack traces that as a dynamic import and
 * fails production `next build` (Docker standalone).
 */
export function runNodeScript(
  scriptPath: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const max = opts.maxBuffer ?? 8 * 1024 * 1024;
    const killer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs);
    const take = (buf: string, chunk: Buffer) => {
      const next = buf + chunk.toString();
      return next.length > max ? next.slice(-max) : next;
    };
    child.stdout?.on("data", (c) => {
      stdout = take(stdout, c);
    });
    child.stderr?.on("data", (c) => {
      stderr = take(stderr, c);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(killer);
      resolve({ code: 1, stdout, stderr: stderr || err.message });
    });
  });
}
