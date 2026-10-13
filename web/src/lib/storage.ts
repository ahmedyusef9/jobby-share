/**
 * localStorage keys — single source of truth for the rebrand.
 * Every component should import from here instead of hardcoding keys.
 *
 * Migration: read() tries the new `jobby:*` key first, then falls back to the
 * legacy `career-ops:*` key once (and re-writes under the new key). This gives
 * existing users a seamless upgrade without data loss.
 */

import { ANON_SCOPE, inheritChain, legacyKey, storageKey } from "./storage-keys.mjs";

function tenantScope(): string {
  if (typeof document === "undefined") return ANON_SCOPE;
  return document.documentElement.dataset.tenant || ANON_SCOPE;
}

/**
 * Read from localStorage.
 *
 * Pre-tenancy keys are adopted ONLY by the default tenant — see storage-keys.mjs.
 * Every other account starts empty, because inheriting the browser's previous
 * occupant is a cross-tenant leak, not a migration.
 */
export function lsRead<T = string>(name: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const scope = tenantScope();
    const k = storageKey(name, scope);
    const raw = window.localStorage.getItem(k);
    if (raw !== null) return parseMaybeJson(raw) as T;

    for (const older of inheritChain(name, scope)) {
      const found = window.localStorage.getItem(older);
      if (found === null) continue;
      window.localStorage.setItem(k, found);
      return parseMaybeJson(found) as T;
    }
    return null;
  } catch {
    return null;
  }
}

export function lsReadJson<T>(name: string, fallback: T): T {
  const raw = lsRead(name);
  if (raw === null) return fallback;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

export function lsWrite(name: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(name, tenantScope()), value);
  } catch {
    /* quota */
  }
}

export function lsWriteJson(name: string, value: unknown): void {
  lsWrite(name, JSON.stringify(value));
}

export function lsRemove(name: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(name, tenantScope()));
    window.localStorage.removeItem(legacyKey(name));
  } catch {
    /* ignore */
  }
}

function parseMaybeJson(raw: string): unknown {
  const trimmed = raw.trim();
  // Only parse JSON objects, arrays, and quoted strings. Bare `1` / `true` /
  // `null` must stay strings — JSON.parse("1") === 1 breaks `lsRead(k) === "1"`.
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}
