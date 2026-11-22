/**
 * POST /api/v1/photos — multipart `file`, `Authorization: Bearer <key>`
 * → 201 { photoId }. A documented exception to "the API is tRPC": file bytes.
 * The tenant is the API key's; the bytes go to @repo/storage and the photo is a
 * media_asset row whose id is the photoId listings.create takes.
 */
import { db } from "@repo/db";
import { resolveBearer } from "@repo/lister";
import { MAX_UPLOAD_BYTES, buildKey, storage } from "@repo/storage";

export const dynamic = "force-dynamic";

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
]);

export async function POST(req: Request) {
  const caller = await resolveBearer(req.headers);
  if (!caller) {
    return Response.json(
      { error: "A valid API key is required (Authorization: Bearer <key>)." },
      { status: 401 },
    );
  }
  if (!caller.scopes.includes("listings:write")) {
    return Response.json(
      { error: 'This API key lacks the "listings:write" scope.' },
      { status: 403 },
    );
  }

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES * 1.1) {
    return Response.json({ error: "File too large." }, { status: 413 });
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const candidate = form.get("file");
    if (candidate instanceof File) file = candidate;
  } catch {
    return Response.json({ error: "Malformed multipart body." }, { status: 400 });
  }
  if (!file) {
    return Response.json({ error: "Missing `file` field." }, { status: 400 });
  }
  const contentType = file.type || "application/octet-stream";
  if (!IMAGE_TYPES.has(contentType)) {
    return Response.json(
      { error: `Unsupported content type: ${contentType} (jpeg, png, webp, gif, heic)` },
      { status: 415 },
    );
  }
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "File too large or empty." }, { status: 413 });
  }

  const key = buildKey(caller.organizationId, file.name || "photo");
  const bytes = new Uint8Array(await file.arrayBuffer());
  await storage().put(key, bytes, contentType);
  const asset = await db.mediaAsset.create({
    data: {
      organizationId: caller.organizationId,
      key,
      filename: (file.name || "photo").slice(0, 200),
      contentType,
      sizeBytes: bytes.byteLength,
    },
    select: { id: true },
  });
  return Response.json({ photoId: asset.id }, { status: 201 });
}
