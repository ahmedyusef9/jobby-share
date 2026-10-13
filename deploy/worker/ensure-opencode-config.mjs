/**
 * Write a slim OpenCode config so the in-container CLI uses OmniRoute
 * (same gateway as host ~/.config/opencode/opencode.json) without Mac MCP.
 *
 * D-010 is enforced by `mayUseEngine`: members never spawn OpenCode. Skipping
 * this file on AUTH_SINGLE_TENANT=0 left the operator's Score jobs unconfigured,
 * so OpenCode fell through to google/gemini-3-pro-image-preview and died with
 * "Missing Authentication header".
 */
import fs from "node:fs";
import path from "node:path";

export function ensureOpencodeConfig() {
  const baseURL = (
    process.env.JOBBY_OMNIROUTE_BASE_URL ||
    process.env.OMNIROUTE_BASE_URL ||
    ""
  ).trim();
  const apiKey = (process.env.JOBBY_OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || "").trim();
  if (!baseURL || !apiKey) return { ok: false, reason: "JOBBY_OMNIROUTE_BASE_URL / JOBBY_OMNIROUTE_API_KEY unset" };
  if (/localhost|127\.0\.0\.1/.test(baseURL)) {
    return { ok: false, reason: `refusing loopback OmniRoute URL (${baseURL}) inside the container` };
  }

  const model = process.env.OPENCODE_MODEL?.trim() || "omniroute/auto/best-coding";
  const dir = "/root/.config/opencode";
  fs.mkdirSync(dir, { recursive: true });
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    model,
    provider: {
      omniroute: {
        name: "OmniRoute",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL, apiKey },
        models: {
          "auto/best-coding": { name: "auto/best-coding" },
          "auto/best-coding-fast": { name: "auto/best-coding-fast" },
          "auto/best-reasoning": { name: "auto/best-reasoning" },
          "auto/best-fast": { name: "auto/best-fast" },
          "auto/best-chat": { name: "auto/best-chat" },
          "auto/best-free": { name: "auto/best-free" },
        },
      },
    },
  };
  fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify(cfg, null, 2));
  return { ok: true, model };
}
