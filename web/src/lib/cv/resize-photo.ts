/** Headshot helpers: shrink, then crop to the CV photo frame. */

const JPEG_QUALITY = 0.9;
const MAX_SOURCE_EDGE = 1600;

export type PhotoStyle = "rounded" | "circle" | "square";

/** Match templates/cv-template.html .cv-photo box. */
export function photoFrame(style: string): { width: number; height: number; radius: string } {
  if (style === "circle" || style === "square") {
    return { width: 80, height: 80, radius: style === "circle" ? "999px" : "0px" };
  }
  return { width: 80, height: 100, radius: "8px" };
}

export function coverScale(imageW: number, imageH: number, frameW: number, frameH: number): number {
  return Math.max(frameW / imageW, frameH / imageH);
}

export function clampPan(
  panX: number,
  panY: number,
  imageW: number,
  imageH: number,
  frameW: number,
  frameH: number,
  zoom: number,
): { x: number; y: number } {
  const scale = coverScale(imageW, imageH, frameW, frameH) * zoom;
  const slackX = Math.max(0, (imageW * scale - frameW) / 2);
  const slackY = Math.max(0, (imageH * scale - frameH) / 2);
  return {
    x: Math.max(-slackX, Math.min(slackX, panX)),
    y: Math.max(-slackY, Math.min(slackY, panY)),
  };
}

export async function loadImageBitmap(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file);
}

/** Downscale a huge original so the cropper stays snappy. */
export async function shrinkSource(file: Blob, maxEdge = MAX_SOURCE_EDGE): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  if (scale >= 1) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Could not resize the photo in this browser.");
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvasToJpeg(canvas);
  return blob;
}

export async function cropPhotoToBlob(opts: {
  bitmap: ImageBitmap;
  frameW: number;
  frameH: number;
  zoom: number;
  panX: number;
  panY: number;
  outW: number;
  outH: number;
}): Promise<Blob> {
  const { bitmap, frameW, frameH, zoom, panX, panY, outW, outH } = opts;
  const scale = coverScale(bitmap.width, bitmap.height, frameW, frameH) * zoom;
  const offsetX = (frameW - bitmap.width * scale) / 2 + panX;
  const offsetY = (frameH - bitmap.height * scale) / 2 + panY;
  const sx = -offsetX / scale;
  const sy = -offsetY / scale;
  const sw = frameW / scale;
  const sh = frameH / scale;
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not crop the photo.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);
  return canvasToJpeg(canvas);
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("Could not encode the photo."));
      else resolve(blob);
    }, "image/jpeg", JPEG_QUALITY);
  });
}
