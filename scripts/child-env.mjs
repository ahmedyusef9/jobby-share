/**
 * Allowlisted environment for spawned children (BL-021).
 *
 * Parent process.env holds platform secrets (REDIS_URL, AUTH_SECRET, every
 * tenant's provider keys once they are loaded). Spreading it into an AI CLI
 * or a career-ops script hands those to a process that reads untrusted JD text.
 *
 * Copy only PATH/HOME/LANG-class keys, plus explicit extras (tenant id, the
 * one provider key this job needs). Never copy NODE_OPTIONS.
 */
export const CHILD_ENV_BASE_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "USERPROFILE",
  "LOGNAME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LANGUAGE",
  "TZ",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "NODE_PATH",
]);

/** Provider / CLI-config keys a child may receive — only for that CLI, never all of them. */
export const CLI_PROVIDER_KEYS = Object.freeze({
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR", "JOBBY_CLAUDE_MODEL"],
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "JOBBY_CODEX_MODEL", "CODEX_HOME"],
  cursor: ["JOBBY_CURSOR_MODEL"],
  gemini: ["GEMINI_API_KEY", "GEMINI_MODEL", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"],
  ollama: [
    "JOBBY_OLLAMA_BASE_URL",
    "JOBBY_OLLAMA_MODEL",
    "JOBBY_OLLAMA_NUM_CTX",
    "OPENCODE_CONFIG",
    "OPENCODE_PURE",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  ],
  opencode: [
    "OPENCODE_MODEL",
    "OPENCODE_CONFIG",
    "JOBBY_OMNIROUTE_BASE_URL",
    "OMNIROUTE_BASE_URL",
    "JOBBY_OMNIROUTE_API_KEY",
    "OMNIROUTE_API_KEY",
    "OPENROUTER_API_KEY",
  ],
  openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_API_URL", "OPENROUTER_TIMEOUT_MS", "CAREER_OPS_MODEL", "JOBBY_ALLOW_API_KEY"],
  copilot: ["GH_TOKEN", "GITHUB_TOKEN"],
  qwen: ["DASHSCOPE_API_KEY", "OPENAI_API_KEY"],
  antigravity: [],
});

/**
 * @param {Record<string, string | undefined>} [extra]
 * @param {NodeJS.ProcessEnv} [from]
 * @returns {NodeJS.ProcessEnv}
 */
export function pickChildEnv(extra = {}, from = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const key of CHILD_ENV_BASE_KEYS) {
    const v = from[key];
    if (v !== undefined && v !== "") env[key] = v;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue;
    const s = String(value);
    if (s === "") continue;
    env[key] = s;
  }
  return env;
}

/**
 * @param {string} cliId
 * @param {NodeJS.ProcessEnv} [from]
 * @returns {Record<string, string>}
 */
export function providerEnvFor(cliId, from = process.env) {
  /** @type {Record<string, string>} */
  const extra = {};
  const keys = CLI_PROVIDER_KEYS[cliId] || [];
  for (const key of keys) {
    const v = from[key];
    if (v !== undefined && String(v).trim() !== "") extra[key] = v;
  }
  return extra;
}
