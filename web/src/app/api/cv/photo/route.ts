import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { withTenant } from "@/lib/tenant/http";
import { tenantRoot } from "@/lib/tenant";
import { atomicWriteBytes, atomicWriteWithBackup } from "@/lib/core/safe-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PHOTO_REL = "config/cv-photo.jpg";
const SOURCE_REL = "config/cv-photo-source.jpg";
const MAX_BYTES = 2 * 1024 * 1024;
const STYLES = new Set(["rounded", "circle", "square"]);

function profilePath(root: string): string {
  return path.join(root, "config", "profile.yml");
}

function photoAbs(root: string): string {
  return path.join(root, PHOTO_REL);
}

function sourceAbs(root: string): string {
  return path.join(root, SOURCE_REL);
}

function readProfile(root: string): { photo: string; style: string } {
  try {
    const raw = yaml.load(fs.readFileSync(profilePath(root), "utf8")) as {
      candidate?: { photo?: string; photo_style?: string };
    };
    const photo = String(raw?.candidate?.photo ?? "").trim();
    const style = String(raw?.candidate?.photo_style ?? "rounded").trim() || "rounded";
    return { photo, style: STYLES.has(style) ? style : "rounded" };
  } catch {
    return { photo: "", style: "rounded" };
  }
}

function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function looksLikePng(bytes: Uint8Array): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function looksLikeWebp(bytes: Uint8Array): boolean {
  const ascii = (start: number, n: number) =>
    String.fromCharCode(...bytes.slice(start, start + n));
  return bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
}

function patchPhotoLines(yml: string, photo: string, style: string): string {
  let out = yml;
  if (/^[ \t]*photo:\s*.*$/m.test(out)) {
    out = out.replace(/^[ \t]*photo:\s*.*$/m, (line) => {
      const indent = line.match(/^[ \t]*/)?.[0] ?? "  ";
      return `${indent}photo: ${JSON.stringify(photo)}`;
    });
  } else {
    out = out.replace(/^(candidate:\s*\n)/m, `$1  photo: ${JSON.stringify(photo)}\n`);
  }
  if (/^[ \t]*photo_style:\s*.*$/m.test(out)) {
    out = out.replace(/^[ \t]*photo_style:\s*.*$/m, (line) => {
      const indent = line.match(/^[ \t]*/)?.[0] ?? "  ";
      return `${indent}photo_style: ${style}`;
    });
  } else {
    out = out.replace(/^[ \t]*photo:\s*.*$/m, (line) => {
      const indent = line.match(/^[ \t]*/)?.[0] ?? "  ";
      return `${line}\n${indent}photo_style: ${style}`;
    });
  }
  return out;
}

function writeProfilePhoto(root: string, photo: string, style: string): void {
  const file = profilePath(root);
  if (!fs.existsSync(file)) throw new Error("config/profile.yml is missing");
  const next = patchPhotoLines(fs.readFileSync(file, "utf8"), photo, style);
  atomicWriteWithBackup(file, next);
}

async function handleGET(req: Request) {
  const root = tenantRoot();
  const meta = readProfile(root);
  const abs = meta.photo
    ? path.isAbsolute(meta.photo)
      ? meta.photo
      : path.join(root, meta.photo)
    : photoAbs(root);
  const present = Boolean(meta.photo) && fs.existsSync(abs);
  const sourcePath = sourceAbs(root);
  const hasSource = fs.existsSync(sourcePath);

  const raw = new URL(req.url).searchParams.get("raw") === "1";
  const wantSource = new URL(req.url).searchParams.get("source") === "1";
  if (raw || wantSource) {
    const file = wantSource && hasSource ? sourcePath : abs;
    if (!fs.existsSync(file)) return new Response("no photo", { status: 404 });
    const buf = fs.readFileSync(file);
    const type = looksLikePng(buf)
      ? "image/png"
      : looksLikeWebp(buf)
        ? "image/webp"
        : "image/jpeg";
    return new Response(new Uint8Array(buf), {
      headers: { "Content-Type": type, "Cache-Control": "no-store" },
    });
  }

  return Response.json({
    present,
    style: meta.style,
    path: present ? PHOTO_REL : "",
    hasSource,
  });
}

async function handlePOST(req: Request) {
  const root = tenantRoot();
  const ctype = req.headers.get("content-type") || "";
  let style = readProfile(root).style;
  let bytes: Uint8Array | null = null;
  let sourceBytes: Uint8Array | null = null;

  if (ctype.includes("application/json")) {
    const body = (await req.json()) as { style?: string };
    if (body.style && STYLES.has(body.style)) style = body.style;
  } else {
    const form = await req.formData();
    const styleField = String(form.get("style") || "").trim();
    if (STYLES.has(styleField)) style = styleField;
    const file = form.get("file");
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_BYTES) {
        return Response.json({ error: "Photo is too large (max 2 MB after resize)." }, { status: 413 });
      }
      bytes = new Uint8Array(await file.arrayBuffer());
      if (!looksLikeJpeg(bytes) && !looksLikePng(bytes) && !looksLikeWebp(bytes)) {
        return Response.json({ error: "Use a JPEG, PNG, or WebP photo." }, { status: 400 });
      }
    }
    const source = form.get("source");
    if (source instanceof File && source.size > 0 && source.size <= 8 * 1024 * 1024) {
      const srcBytes = new Uint8Array(await source.arrayBuffer());
      if (looksLikeJpeg(srcBytes) || looksLikePng(srcBytes) || looksLikeWebp(srcBytes)) {
        sourceBytes = srcBytes;
      }
    }
  }

  if (bytes) {
    atomicWriteBytes(photoAbs(root), bytes);
    if (sourceBytes) atomicWriteBytes(sourceAbs(root), sourceBytes);
    writeProfilePhoto(root, PHOTO_REL, style);
  } else {
    const current = readProfile(root);
    if (!current.photo) {
      return Response.json({ error: "Upload a photo first, or this stays off the CV." }, { status: 400 });
    }
    writeProfilePhoto(root, current.photo, style);
  }

  return Response.json({ ok: true, present: true, style, path: PHOTO_REL });
}

async function handleDELETE() {
  const root = tenantRoot();
  const meta = readProfile(root);
  writeProfilePhoto(root, "", meta.style);
  const abs = photoAbs(root);
  try {
    fs.unlinkSync(abs);
  } catch {
    /* already gone */
  }
  try {
    fs.unlinkSync(sourceAbs(root));
  } catch {
    /* already gone */
  }
  if (meta.photo && meta.photo !== PHOTO_REL) {
    const extra = path.isAbsolute(meta.photo) ? meta.photo : path.join(root, meta.photo);
    try {
      if (extra.startsWith(path.join(root, "config") + path.sep)) fs.unlinkSync(extra);
    } catch {
      /* ignore */
    }
  }
  return Response.json({ ok: true, present: false });
}

export const GET = withTenant(handleGET);
export const POST = withTenant(handlePOST);
export const DELETE = withTenant(handleDELETE);
