/**
 * Download a CV PDF and let the user pick the save location.
 *
 * Chromium/Edge: File System Access API (`showSaveFilePicker`) → real Save dialog.
 * The picker MUST run before any `fetch`, or the click is no longer a user
 * gesture and Chrome silently skips the dialog.
 * Safari/Firefox: falls back to a normal attachment download (browser Downloads).
 */

export type DownloadCvOpts = {
  /** Company slug match for /api/cv-pdf (newest tailored PDF). */
  company?: string;
  /** Exact repo-relative path e.g. output/cv-….pdf from the worker verdict. */
  file?: string;
  /** Suggested filename in the Save dialog. */
  suggestedName?: string;
  /** Prefer the OS Save dialog when available (default true). */
  pickLocation?: boolean;
};

type SaveHandle = {
  createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
};

function pickerWindow(): Window & {
  showSaveFilePicker?: (o: {
    suggestedName?: string;
    id?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<SaveHandle>;
} {
  return window as Window & {
    showSaveFilePicker?: (o: {
      suggestedName?: string;
      id?: string;
      types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<SaveHandle>;
  };
}

/** Open the OS Save dialog. Call this synchronously from a click. */
export async function pickPdfSaveLocation(suggestedName: string): Promise<SaveHandle | "unavailable"> {
  const w = pickerWindow();
  if (typeof w.showSaveFilePicker !== "function") return "unavailable";
  return w.showSaveFilePicker({
    suggestedName,
    id: "jobby-cv-pdf",
    types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
  });
}

async function writeBlob(handle: SaveHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

function fallbackDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function apiUrl(opts: DownloadCvOpts, asAttachment: boolean): string {
  const qs = new URLSearchParams();
  if (opts.file) qs.set("file", opts.file);
  else if (opts.company) qs.set("company", opts.company);
  if (asAttachment) qs.set("download", "1");
  return `/api/cv-pdf?${qs}`;
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const m = header.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
  if (!m) return fallback;
  try {
    return decodeURIComponent(m[1].replace(/"/g, "").trim()) || fallback;
  } catch {
    return m[1].replace(/"/g, "").trim() || fallback;
  }
}

/** Pull `output/cv-….pdf` out of worker text / summary when present. */
export function extractCvPdfPath(text: string): string | null {
  const m = text.match(/\b(output\/cv-[^\s*'\"<>]+\.pdf)\b/i);
  return m ? m[1] : null;
}

export async function downloadCvPdf(
  opts: DownloadCvOpts,
): Promise<{ ok: boolean; error?: string; mode?: "picker" | "download" }> {
  if (!opts.company && !opts.file) {
    return { ok: false, error: "company or file required" };
  }

  const suggested =
    opts.suggestedName ||
    (opts.file ? opts.file.split("/").pop() : undefined) ||
    (opts.company ? `cv-${opts.company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf` : "cv.pdf");

  const pick = opts.pickLocation !== false;
  let handle: SaveHandle | null = null;
  if (pick) {
    try {
      const picked = await pickPdfSaveLocation(suggested);
      if (picked !== "unavailable") handle = picked;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ok: false, error: "cancelled" };
      }
    }
  }

  const res = await fetch(apiUrl(opts, true));
  if (!res.ok) {
    const msg = (await res.text().catch(() => "")) || `HTTP ${res.status}`;
    return { ok: false, error: msg.slice(0, 160) };
  }
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get("Content-Disposition"), suggested);

  if (handle) {
    await writeBlob(handle, blob);
    return { ok: true, mode: "picker" };
  }

  fallbackDownload(blob, name);
  return { ok: true, mode: "download" };
}

/** Fetch any PDF URL and open Save As (or attachment download). */
export async function savePdfFromUrl(
  url: string,
  suggestedName = "cv.pdf",
): Promise<{ ok: boolean; error?: string; mode?: "picker" | "download" }> {
  let handle: SaveHandle | null = null;
  try {
    const picked = await pickPdfSaveLocation(suggestedName);
    if (picked !== "unavailable") handle = picked;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: "cancelled" };
    }
  }

  const res = await fetch(url);
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get("Content-Disposition"), suggestedName);

  if (handle) {
    await writeBlob(handle, blob);
    return { ok: true, mode: "picker" };
  }

  fallbackDownload(blob, name);
  return { ok: true, mode: "download" };
}
