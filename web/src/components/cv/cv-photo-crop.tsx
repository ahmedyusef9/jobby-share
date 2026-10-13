"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { X } from "lucide-react";
import { clampPan, coverScale, cropPhotoToBlob, photoFrame } from "@/lib/cv/resize-photo";

const STYLES = [
  { id: "rounded", label: "Rounded" },
  { id: "circle", label: "Circle" },
  { id: "square", label: "Square" },
] as const;

type Props = {
  src: string;
  style: string;
  onCancel: () => void;
  onApply: (cropped: Blob, style: string) => void;
};

/**
 * Drag to move, slider/wheel to zoom. The window is the CV photo frame.
 */
export function CvPhotoCrop({ src, style: initialStyle, onCancel, onApply }: Props) {
  const [frameStyle, setFrameStyle] = useState(initialStyle);
  const frame = photoFrame(frameStyle);
  const viewW = 240;
  const viewH = Math.round((viewW * frame.height) / frame.width);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = src;
  }, [src]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [frameStyle]);

  const displayScale = useMemo(() => {
    if (!natural.w) return 1;
    return coverScale(natural.w, natural.h, viewW, viewH) * zoom;
  }, [natural, viewW, viewH, zoom]);

  function setZoomClamped(next: number) {
    const z = Math.max(1, Math.min(3, next));
    setZoom(z);
    setPan((p) => clampPan(p.x, p.y, natural.w, natural.h, viewW, viewH, z));
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current || !natural.w) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    setPan(clampPan(drag.current.panX + dx, drag.current.panY + dy, natural.w, natural.h, viewW, viewH, zoom));
  }

  function onPointerUp() {
    drag.current = null;
  }

  async function apply() {
    if (!natural.w) return;
    setBusy(true);
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const square = frameStyle === "circle" || frameStyle === "square";
      const cropped = await cropPhotoToBlob({
        bitmap,
        frameW: viewW,
        frameH: viewH,
        zoom,
        panX: pan.x,
        panY: pan.y,
        outW: square ? 400 : 320,
        outH: 400,
      });
      bitmap.close();
      onApply(cropped, frameStyle);
    } finally {
      setBusy(false);
    }
  }

  const offsetX = (viewW - natural.w * displayScale) / 2 + pan.x;
  const offsetY = (viewH - natural.h * displayScale) / 2 + pan.y;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-foreground">Place the photo</h2>
            <p className="mt-1 text-xs text-muted">Drag to move. Scroll or use the slider to zoom.</p>
          </div>
          <button type="button" onClick={onCancel} className="text-faint hover:text-foreground" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setFrameStyle(s.id)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] max-sm:min-h-[44px] ${
                frameStyle === s.id
                  ? "border-brand bg-brand/10 text-brand"
                  : "border-border text-muted hover:border-brand/40 hover:text-brand"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div
          className="relative mx-auto mt-4 cursor-grab overflow-hidden bg-black/80 active:cursor-grabbing"
          style={{
            width: viewW,
            height: viewH,
            borderRadius: frame.radius,
            touchAction: "none",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={(e) => {
            e.preventDefault();
            setZoomClamped(zoom * (e.deltaY > 0 ? 0.94 : 1.06));
          }}
        >
          {natural.w > 0 && (
            <img
              src={src}
              alt=""
              draggable={false}
              className="pointer-events-none absolute max-w-none select-none"
              style={{
                width: natural.w * displayScale,
                height: natural.h * displayScale,
                left: offsetX,
                top: offsetY,
              }}
            />
          )}
        </div>

        <label className="mt-4 flex items-center gap-3 text-xs text-muted">
          Zoom
          <input
            type="range"
            min={1}
            max={3}
            step={0.02}
            value={zoom}
            onChange={(e) => setZoomClamped(Number(e.target.value))}
            className="flex-1 accent-brand"
          />
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || !natural.w}
            onClick={() => void apply()}
            className="inline-flex items-center justify-center rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground disabled:opacity-50 max-sm:min-h-[44px]"
          >
            {busy ? "Applying…" : "Use this crop"}
          </button>
          <button type="button" onClick={onCancel} className="text-xs text-muted hover:text-foreground">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
