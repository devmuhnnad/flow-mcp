// Reading local files into the { base64, mimeType } shape Flow's applet SDK
// wants, plus the argument checks the Flow host enforces.
//
// Tool callers pass file paths, never base64: the server runs on the same
// machine as the files, and a megabyte of base64 in a tool call is unusable.
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_UPLOAD_MB = Number(process.env.FLOW_MCP_MAX_UPLOAD_MB || 32);

const BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

/** Identify a file from its leading bytes when the extension is unhelpful. */
function sniff(buf) {
  const starts = (...bytes) => bytes.every((b, i) => buf[i] === b);
  const ascii = (off, s) => buf.slice(off, off + s.length).toString('latin1') === s;

  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav';
  if (ascii(4, 'ftyp')) {
    const brand = buf.slice(8, 12).toString('latin1');
    if (brand.startsWith('qt')) return 'video/quicktime';
    if (brand.startsWith('M4A')) return 'audio/mp4';
    return 'video/mp4';
  }
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (ascii(0, 'fLaC')) return 'audio/flac';
  if (ascii(0, 'ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

/**
 * Read a local file as { base64, mimeType, name, bytes }.
 * `label` names the argument in error messages.
 */
export async function readMediaFile(filePath, { mimeType, label = 'path', maxMb = MAX_UPLOAD_MB } = {}) {
  const resolved = path.resolve(filePath);

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error(`${label}: no such file - ${resolved}`);
  }
  if (!stat.isFile()) throw new Error(`${label}: not a file - ${resolved}`);

  const limit = maxMb * 1024 * 1024;
  if (stat.size > limit) {
    throw new Error(
      `${label}: ${(stat.size / 1048576).toFixed(1)}MB exceeds the ${maxMb}MB limit. ` +
      'The file travels base64-encoded through the WebSocket and the extension, which is unreliable above that. ' +
      'Raise FLOW_MCP_MAX_UPLOAD_MB if you want to try anyway.',
    );
  }
  if (stat.size === 0) throw new Error(`${label}: file is empty - ${resolved}`);

  const buf = await fs.readFile(resolved);
  const type = mimeType || BY_EXT[path.extname(resolved).toLowerCase()] || sniff(buf);
  if (!type) {
    throw new Error(
      `${label}: could not tell the media type of ${resolved}. Pass mimeType explicitly.`,
    );
  }

  return {
    base64: buf.toString('base64'),
    mimeType: type,
    name: path.basename(resolved),
    bytes: stat.size,
  };
}

/**
 * Flow's upload handler branches on the mime type: `video/*` goes to
 * upload_video and *everything else* to upload_image. There is no audio path,
 * so an audio file is submitted as an image and rejected by the backend
 * (its own telemetry only knows FLOW_UPLOAD_TYPE IMAGE and VIDEO). Fail here
 * with a reason instead of relaying an opaque rejection.
 */
export function checkUploadable(mimeType, filePath) {
  if (mimeType.startsWith('image/') || mimeType.startsWith('video/')) return;
  const kind = mimeType.split('/')[0] || 'that';
  throw new Error(
    `Flow does not accept ${kind} uploads (${mimeType} - ${filePath}). Its applet upload handler has only an ` +
    'image path and a video path; anything else is sent as an image and refused. ' +
    (kind === 'audio'
      ? 'For audio in a video, use audioReferenceMediaIds with a "voices/<name>" preset or audio already in your Flow project. ' +
        'Audio files can still be passed to flow_generate_text, which takes them inline rather than uploading them.'
      : 'Convert it to an image or video first.'),
  );
}

/** Read several files into the inline media shape FLOW_GEN_TEXT accepts. */
export async function readInlineMedia(paths, label) {
  if (!paths?.length) return undefined;
  const out = [];
  for (const p of paths) {
    const { base64, mimeType } = await readMediaFile(p, { label });
    // The host drops any entry without a string `base64`, so send exactly this.
    out.push({ base64, mimeType });
  }
  return out;
}

// ---------------------------------------------------------------- validation

/**
 * The only two the Flow host accepts from an applet. Its parser also knows
 * 1080p and 4k, but the applet-facing validator rejects them.
 */
export const VIDEO_RESOLUTIONS = ['360p', '720p'];

export const SOURCE_VIDEO_MODES = ['edit', 'extend'];

/**
 * The host trims and lowercases these before validating, so accept the same
 * spellings it does and hand on the canonical one. Used as the schema's
 * preprocessor, which keeps the declared enum and what we accept in step.
 */
export const normalizeChoice = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v);

/**
 * Rules spanning several arguments, which a JSON Schema cannot express.
 * Single-argument validation (allowed values, integer duration) belongs to the
 * tool's schema - duplicating it here would only create a second, divergent
 * source of truth. Values arrive already normalized by the schema.
 */
export function checkVideoArgs(a) {
  const mode = a.sourceVideoMode;
  // sourceVideoMediaId on its own is fine: with no mode the host treats it as
  // a plain video reference rather than an edit or an extend.
  if (!mode) return;

  if (!a.sourceVideoMediaId) {
    throw new Error(`sourceVideoMode "${mode}" requires sourceVideoMediaId.`);
  }
  if (mode === 'extend' && (a.firstFrameImageMediaId || a.lastFrameImageMediaId)) {
    throw new Error(
      'sourceVideoMode "extend" cannot be combined with firstFrameImageMediaId or lastFrameImageMediaId. ' +
      'Extend continues from the end of the source video, so frame images make no sense there.',
    );
  }
}
