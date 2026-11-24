#!/usr/bin/env node
// MCP server (stdio) that forwards tool calls to the Flow MCP Bridge extension.
// stdout is reserved for the MCP protocol - log to stderr only.
//
// Many instances of this server can run at once (one per agent / chat). They
// share a single browser link through the hub election in bridge-link.js.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BridgeLink } from './bridge-link.js';
import {
  readMediaFile,
  readInlineMedia,
  checkUploadable,
  checkVideoArgs,
  normalizeChoice,
  VIDEO_RESOLUTIONS,
  SOURCE_VIDEO_MODES,
  MAX_UPLOAD_MB,
} from './media.js';

/** An enum that accepts the same spellings the Flow host does, e.g. "720P". */
const choice = (values) => z.preprocess(normalizeChoice, z.enum(values));

const argv = process.argv.slice(2);
const argPort = (() => {
  const i = argv.indexOf('--port');
  return i >= 0 ? Number(argv[i + 1]) : undefined;
})();

const PORT = Number(argPort || process.env.FLOW_MCP_WS_PORT || 8765);
const CLIENT_NAME = process.env.FLOW_MCP_CLIENT_NAME || 'flow-mcp';
// How long a tool call waits for Chrome / an applet before giving up. Keeps
// calls from failing instantly while the browser is still starting up.
const BRIDGE_WAIT_MS = Number(process.env.FLOW_MCP_BRIDGE_WAIT_MS || 15_000);

const log = (...a) => console.error('[flow-mcp]', ...a);

const link = new BridgeLink({
  port: PORT,
  log,
  clientName: CLIENT_NAME,
  // base64 inflates by ~4/3; leave headroom on top of that.
  maxPayload: Math.max(100, MAX_UPLOAD_MB * 3) * 1024 * 1024,
}).start();

// ---------- helpers ----------

// Strip undefined so the host sees the same shape the SDK would send.
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function errorResult(e) {
  return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] };
}

function mediaResult(res, kind) {
  const content = [{
    type: 'text',
    text: JSON.stringify({ mediaId: res?.mediaId, mimeType: res?.mimeType }, null, 2),
  }];
  if (kind === 'image' && res?.base64) {
    content.push({ type: 'image', data: res.base64, mimeType: res.mimeType || 'image/png' });
  }
  return { content };
}

/** Human-readable reason the bridge cannot take work right now. */
function bridgeProblem() {
  const s = link.state;
  if (!s.extensionConnected) {
    return `Browser extension not connected on port ${s.port}. Load the Flow MCP Bridge extension in Chrome and keep Chrome running.`;
  }
  if (s.applets === 0) {
    return 'No Flow applet is open. Open any applet at flow.google.com and keep that tab open.';
  }
  if (s.appletsAwake === 0) {
    return 'The Flow tab is open but suspended by the browser, so it cannot answer. Click the tab once to wake it, ' +
      'or keep Flow in its own visible window. The extension popup can wake it and can do so automatically.';
  }
  return null;
}

/** Wait briefly for the bridge, then run the request. */
async function call(type, payload, timeoutMs) {
  await link.waitForBridge(BRIDGE_WAIT_MS);
  const problem = bridgeProblem();
  if (problem) throw new Error(problem);
  return link.request(type, payload, timeoutMs);
}

// ---------- MCP tools ----------
const server = new McpServer({ name: 'flow', version: '0.2.0' });

server.registerTool('flow_status', {
  description: 'Check the Flow bridge: whether the browser extension is connected, how many Flow applets are open, and how many MCP clients share the bridge.',
  inputSchema: {},
}, async () => {
  const s = link.state;
  const summary = {
    ready: s.extensionConnected && s.applets > 0,
    extensionConnected: s.extensionConnected,
    openApplets: s.applets,
    awakeApplets: s.appletsAwake,
    mcpClients: s.mcpClients,
    bridge: {
      // 'hub' owns the browser link for this machine; 'peer' multiplexes through it.
      thisProcessRole: s.role,
      port: s.port,
      hubPid: s.hubPid,
      inflightRequests: s.inflight,
    },
    applets: s.appletList,
    clients: s.clients,
  };
  const problem = bridgeProblem();
  if (problem) summary.problem = problem;
  return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
});

server.registerTool('flow_generate_image', {
  description: 'Generate an image in Google Flow. Returns the Flow mediaId (and the image when available).',
  inputSchema: {
    prompt: z.string().describe('Image prompt'),
    aspectRatio: z.string().optional().describe('e.g. "16:9", "9:16", "1:1". Default 16:9'),
    modelDisplayName: z.string().optional(),
    referenceImageMediaIds: z.array(z.string()).optional().describe('Flow mediaIds to use as references'),
  },
}, async (a) => {
  try {
    const res = await call('FLOW_GEN_IMAGE', clean({
      prompt: a.prompt,
      modelDisplayName: a.modelDisplayName,
      referenceImageMediaIds: a.referenceImageMediaIds,
      aspectRatio: a.aspectRatio ?? '16:9',
    }));
    return mediaResult(res, 'image');
  } catch (e) { return errorResult(e); }
});

server.registerTool('flow_upload_media', {
  description:
    'Upload a local image or video file into Flow and get back a mediaId you can pass to the generate tools ' +
    '(referenceImageMediaIds, firstFrameImageMediaId, lastFrameImageMediaId, sourceVideoMediaId). ' +
    `Give a path on this machine - the server reads the file itself. Limit ${MAX_UPLOAD_MB}MB. ` +
    'Audio cannot be uploaded: Flow has no audio upload path and rejects it.',
  inputSchema: {
    path: z.string().describe('Path to an image or video file on the machine running this MCP server'),
    name: z.string().optional().describe('Name to show in Flow. Defaults to the file name.'),
    mimeType: z.string().optional().describe('Only needed when the type cannot be inferred'),
    mode: z.enum(['upload', 'save']).optional()
      .describe('Both run the same host handler; "save" only adds a "Saving to gallery..." toast in the Flow tab.'),
  },
}, async (a) => {
  try {
    const file = await readMediaFile(a.path, { mimeType: a.mimeType, label: 'path' });
    checkUploadable(file.mimeType, a.path);
    const res = await call(
      a.mode === 'save' ? 'FLOW_SAVE' : 'FLOW_UPLOAD',
      { base64: file.base64, mimeType: file.mimeType, name: a.name ?? file.name },
      10 * 60 * 1000,
    );
    // Flow answers uploads with { id }, not { mediaId } as the generate calls do.
    const mediaId = res?.id ?? res?.mediaId;
    if (!mediaId) throw new Error(`Flow accepted the upload but returned no id: ${JSON.stringify(res)}`);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          mediaId,
          name: a.name ?? file.name,
          mimeType: file.mimeType,
          bytes: file.bytes,
        }, null, 2),
      }],
    };
  } catch (e) { return errorResult(e); }
});

server.registerTool('flow_generate_video', {
  description:
    'Generate a video in Google Flow. Can take several minutes. Returns the Flow mediaId. ' +
    'Set sourceVideoMode to "extend" with sourceVideoMediaId to continue an existing video past its end, ' +
    'or "edit" to edit one. Note resolution accepts only "360p" or "720p" through this API.',
  inputSchema: {
    prompt: z.string(),
    modelDisplayName: z.string().optional()
      .describe('Model family id, display name or alias, e.g. "veo_3_1_fast", "Veo 3.1 - Quality", "Omni Flash". Unmatched values are passed to the backend as-is.'),
    firstFrameImageMediaId: z.string().optional(),
    lastFrameImageMediaId: z.string().optional(),
    referenceImageMediaIds: z.array(z.string()).optional(),
    sourceVideoMediaId: z.string().optional()
      .describe('An existing Flow video. With sourceVideoMode it is edited or extended; without, it is a reference.'),
    sourceVideoMode: choice(SOURCE_VIDEO_MODES).optional()
      .describe('Requires sourceVideoMediaId. "extend" continues the source video (no frame images allowed); "edit" edits it.'),
    audioReferenceMediaIds: z.array(z.string()).optional()
      .describe('Audio mediaIds, or named voice presets written as "voices/<name>".'),
    aspectRatio: z.string().optional().describe('Unknown values silently fall back to landscape'),
    durationSeconds: z.number().int().positive().optional(),
    resolution: choice(VIDEO_RESOLUTIONS).optional()
      .describe('Only these two work through the applet API; Flow rejects 1080p and 4k here.'),
  },
}, async (a) => {
  try {
    checkVideoArgs(a);
    const res = await call('FLOW_GEN_VIDEO', clean(a), 15 * 60 * 1000);
    return mediaResult(res, 'video');
  } catch (e) { return errorResult(e); }
});

server.registerTool('flow_generate_text', {
  description:
    "Generate text with Flow's text model. Accepts image, video and audio files as context - " +
    'give paths on this machine and the server reads them.',
  inputSchema: {
    prompt: z.string(),
    systemInstruction: z.string().optional(),
    thinkingLevel: z.enum(['low', 'medium', 'high']).optional(),
    images: z.array(z.string()).optional().describe('Paths to image files on this machine'),
    videos: z.array(z.string()).optional().describe('Paths to video files on this machine'),
    audios: z.array(z.string()).optional().describe('Paths to audio files on this machine'),
  },
}, async (a) => {
  try {
    // FLOW_GEN_TEXT takes inline { base64, mimeType } here, not media ids.
    const [images, videos, audios] = await Promise.all([
      readInlineMedia(a.images, 'images'),
      readInlineMedia(a.videos, 'videos'),
      readInlineMedia(a.audios, 'audios'),
    ]);
    const res = await call('FLOW_GEN_TEXT', clean({
      prompt: a.prompt,
      systemInstruction: a.systemInstruction,
      thinkingLevel: a.thinkingLevel,
      images,
      videos,
      audios,
    }), 5 * 60 * 1000);
    return { content: [{ type: 'text', text: res?.text ?? '' }] };
  } catch (e) { return errorResult(e); }
});

server.registerTool('flow_get_media_url', {
  description: 'Get a URL for a Flow media item by mediaId.',
  inputSchema: { mediaId: z.string() },
}, async (a) => {
  try {
    const res = await call('FLOW_MEDIA_GET_URL', { mediaId: a.mediaId });
    return { content: [{ type: 'text', text: res?.url ?? '' }] };
  } catch (e) { return errorResult(e); }
});

// ---------- shutdown ----------
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    link.close();
    process.exit(0);
  });
}
process.on('exit', () => link.close());

await server.connect(new StdioServerTransport());
log(`MCP server running on stdio (bridge port ${PORT}, pid ${process.pid})`);
