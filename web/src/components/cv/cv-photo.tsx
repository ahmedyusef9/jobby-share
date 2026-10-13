"use client";

import { useEffect, useRef, useState } from "react";
import { Crop, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { CvPhotoCrop } from "@/components/cv/cv-photo-crop";
import { shrinkSource } from "@/lib/cv/resize-photo";

const STYLES = [
  { id: "rounded", label: "Rounded" },
  { id: "circle", label: "Circle" },
  { id: "square", label: "Square" },
] as const;

type CropSession = {
  previewUrl: string;
  sourceBlob: Blob;
};

/**
 * Optional CV headshot. Off by default — US/UK ATS often penalize photos.
 * Upload opens a zoom/pan cropper, then writes config/cv-photo.jpg + profile.yml.
 */
export function CvPhoto() {
  const inputRef = useRef<HTMLInputElement>(null);
  const cropRef = useRef<CropSession | null>(null);
  const [present, setPresent] = useState(false);
  const [style, setStyle] = useState("rounded");
  const [bust, setBust] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [crop, setCrop] = useState<CropSession | null>(null);

  function setCropSession(next: CropSession | null) {
    if (cropRef.current && cropRef.current.previewUrl !== next?.previewUrl) {
      URL.revokeObjectURL(cropRef.current.previewUrl);
    }
    cropRef.current = next;
    setCrop(next);
  }

  async function refresh() {
    const res = await fetch("/api/cv/photo");
    const data = (await res.json()) as { present?: boolean; style?: string };
    setPresent(Boolean(data.present));
    if (data.style) setStyle(data.style);
  }

  useEffect(() => {
    void refresh();
    return () => {
      if (cropRef.current) URL.revokeObjectURL(cropRef.current.previewUrl);
    };
  }, []);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError("");
    try {
      const sourceBlob = await shrinkSource(file);
      setCropSession({ previewUrl: URL.createObjectURL(sourceBlob), sourceBlob });
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not open photo");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function openAdjust() {
    setBusy(true);
    setError("");
    try {
      let res = await fetch("/api/cv/photo?source=1");
      if (!res.ok) res = await fetch("/api/cv/photo?raw=1");
      if (!res.ok) throw new Error("could not load photo");
      const sourceBlob = await res.blob();
      setCropSession({ previewUrl: URL.createObjectURL(sourceBlob), sourceBlob });
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not load photo");
    } finally {
      setBusy(false);
    }
  }

  async function applyCrop(cropped: Blob, nextStyle: string) {
    const session = cropRef.current;
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", new File([cropped], "cv-photo.jpg", { type: "image/jpeg" }));
      form.set(
        "source",
        new File([session.sourceBlob], "cv-photo-source.jpg", {
          type: session.sourceBlob.type || "image/jpeg",
        }),
      );
      form.set("style", nextStyle);
      const res = await fetch("/api/cv/photo", { method: "POST", body: form });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "upload failed");
      setStyle(nextStyle);
      setPresent(true);
      setBust(Date.now());
      setCropSession(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function onStyle(next: string) {
    setStyle(next);
    if (!present) return;
    await fetch("/api/cv/photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style: next }),
    });
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/cv/photo", { method: "DELETE" });
      if (!res.ok) throw new Error("could not remove photo");
      setPresent(false);
      setBust(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not remove photo");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border px-3 py-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      {present ? (
        <img
          src={`/api/cv/photo?raw=1&t=${bust}`}
          alt="CV photo"
          className="size-14 object-cover"
          style={{
            borderRadius: style === "circle" ? "999px" : style === "square" ? "2px" : "8px",
          }}
        />
      ) : (
        <div className="flex size-14 items-center justify-center rounded-lg bg-surface text-faint">
          <ImagePlus className="size-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">Photo on the PDF</p>
        <p className="text-[11px] text-muted">
          Optional. Fine for DACH/EU. Skip for US/UK ATS. Zoom and drag to place it in the frame — nothing leaves this machine.
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted hover:border-brand/40 hover:text-brand disabled:opacity-50 max-sm:min-h-[44px]"
          >
            {busy ? <Loader2 className="inline size-3 animate-spin" /> : present ? "Replace" : "Upload"}
          </button>
          {present && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void openAdjust()}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted hover:border-brand/40 hover:text-brand disabled:opacity-50 max-sm:min-h-[44px]"
              >
                <Crop className="size-3" /> Adjust
              </button>
              <select
                value={style}
                onChange={(e) => void onStyle(e.target.value)}
                className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted"
              >
                {STYLES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove()}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted hover:text-red-600 disabled:opacity-50 max-sm:min-h-[44px]"
              >
                <Trash2 className="size-3" /> Remove
              </button>
            </>
          )}
        </div>
        {error && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
      </div>
      {crop && (
        <CvPhotoCrop
          src={crop.previewUrl}
          style={style}
          onCancel={() => setCropSession(null)}
          onApply={(blob, nextStyle) => void applyCrop(blob, nextStyle)}
        />
      )}
    </div>
  );
}
