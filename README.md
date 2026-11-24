# Flow MCP Bridge

Lets MCP clients (Claude Desktop, Claude Code, etc.) call Google Flow's
`generate.image / video / text` through an open Flow applet in your browser.

```
MCP client ──stdio──> mcp-server/server.js ─┐
MCP client ──stdio──> mcp-server/server.js ─┤ hub election on ws://127.0.0.1:8765
MCP client ──stdio──> mcp-server/server.js ─┘
                                            │
                                   extension background.js
                                            │ runtime port
                                   applet-bridge.js (isolated)
                                            │ postMessage
                                   applet-main.js (MAIN world)
                                            │ FLOW_PORT
                                   flow.google.com host (real generation)
```

Why this shape: the applet runs in a cross-origin iframe on
`*.scf.usercontent.goog`, so flow.google.com page scripts can't reach its
`FLOW_PORT`. Extension content scripts can be injected directly into that frame.

## Running several agents / chats at once

Every MCP client starts its **own** `server.js` process, but only one process
can own the bridge port and only one WebSocket reaches the extension. The
processes therefore elect a hub:

- **hub** — won the race to bind `127.0.0.1:8765`. It holds the browser link and
  routes requests for everyone else.
- **peer** — found the port taken, so it attaches to the hub and multiplexes its
  requests through it.

Requests are tagged per origin, so answers always return to the client that
asked. If the hub's process exits, the surviving peers race for the port again,
the winner becomes the new hub, and the extension reconnects on its own —
in-flight calls at that moment fail with a "retry the call" error rather than
hanging.

`flow_status` reports which role the current process has, how many MCP clients
share the bridge, and which applets are open.

> If you upgrade from 0.1.x, **restart every running MCP client**. An old
> 0.1.x process still holding port 8765 does not speak the new protocol; new
> processes will log that the port is held by something they can't talk to and
> back off until it's gone.

## Suspended tabs

Browsers freeze background tabs after a few minutes, and **a frozen tab runs no
code at all** — so a request posted into it is never answered and the MCP call
hangs until it times out. That is why reaching the tab "wakes it up".

The extension handles this itself:

- It **pings the applet** and requires a prompt answer before sending work.
  Silence means the tab is suspended (this also catches a discarded, crashed or
  broken page — they all look the same from outside).
- It **wakes the tab** by activating it. `tabs.active` is per window, so if the
  Flow tab sits in **its own window** this takes no focus from what you are
  doing. Focusing the window is a separate, opt-in last resort.
- If it cannot wake it, the call **fails immediately with the reason** instead
  of hanging for the full timeout.
- While a long video is generating, it re-checks and wakes the tab if it falls
  asleep mid-job.

`flow_status` reports `awakeApplets`, and the popup shows an "Asleep" state with
a **Wake now** button. Auto-wake is on by default.

The surest prevention is still to keep the Flow tab in **its own visible
window** — a visible tab is never frozen. Chrome's Settings → Performance →
"Always keep these sites active" is worth adding for `flow.google.com` too,
though Chrome documents that as exempting sites from *discarding*, not
explicitly from freezing.

## Why an error sometimes says more than Flow's own message

Flow's applet SDK flattens backend failures. A prompt refused on policy grounds
arrives at the SDK as nothing more specific than:

```
Video generation service unavailable. Please try again.
```

The host only forwards a raw message for SDK *validation* errors; for a backend
rejection it looks the status code up in a table, and when that lookup misses it
falls back to that generic string. Flow's own UI still shows the real reason —
"...harmful content related to minors", "You've reached your usage limit", and
so on — which is why the screen and the tool disagree.

`host-notices.js` closes that gap. It watches the Flow tab for the text Flow
puts on screen (ARIA live regions and snackbar-style containers, not
Flow-specific class names, which change) and the worker attaches what appeared
**while that request was running** to the failing request:

```
Video generation service unavailable. Please try again.

Flow showed: "This prompt might violate our policies about generating harmful
content related to minors. Please try a different prompt or send feedback."
```

It is a heuristic: it reads what Flow already displayed, bounded by the
request's own start time so an unrelated toast is never blamed, and the text
stays on your machine. Buttons and links are stripped before the text is read,
so a notification's "Close" action is never mistaken for the reason, and the
longest candidate wins rather than the most recent, because a notification
renders in pieces. If Flow restructures its notifications the extra line
simply stops appearing — the original error is never replaced.

## Browser support

| | Chrome / Edge | Firefox | Safari |
| --- | --- | --- | --- |
| minimum | 121 | 128 | 18.4 |

The floors come from the features this extension cannot work without:
`world: "MAIN"` (Chrome 111, Firefox 128, Safari 18) and
`match_origin_as_fallback` (Chrome 99, Firefox 128, Safari 18.4), both needed to
reach Flow's sandboxed applet iframe; plus `storage.session` and, on Chrome,
121 for tolerating the Firefox-style `background.scripts` key in one manifest.

Everything else is deliberately portable: the sleep detection uses only
`runtime.connect` messaging, and waking uses `tabs.update`, which exists
everywhere. Chrome-only extras (`tabs.frozen`, the Page Lifecycle
`freeze`/`resume` events) are used as hints when present and nothing depends on
them.

**Safari is unverified.** The manifest features are supported on 18.4, but a
Safari build must be packaged in a macOS app via Xcode, and whether Safari
permits an extension to open `ws://127.0.0.1` has not been tested.

## Setup

1. **Extension**: `chrome://extensions` → Developer mode → Load unpacked → `extension/`.
2. **MCP server**: `cd mcp-server && npm install`
3. **Register with your MCP client**, e.g. Claude Desktop `claude_desktop_config.json`:
   ```json
   { "mcpServers": { "flow": { "command": "node", "args": ["/ABS/PATH/mcp-server/server.js"] } } }
   ```
   or Claude Code: `claude mcp add flow -- node /ABS/PATH/mcp-server/server.js`
4. Open **any applet** at flow.google.com and keep that tab open. That's the
   channel requests go through.
5. Click the extension's toolbar icon, or call `flow_status`.

## The extension popup

The toolbar icon is a live status light; click it for the full panel:

- **Status pill / banner** — ready, working, asleep, no applet, or disconnected,
  each with the specific thing to fix.
- **Counters** — MCP clients sharing the bridge, open Flow applets, requests in
  flight right now.
- **Connection** — socket, hub process id, and the running request tally.
- **MCP clients** — every attached agent / chat, which one is the hub, its pid,
  uptime and current load.
- **Flow applets** — each open applet frame with its tab title, whether it is
  awake or suspended, success/failure counts, a **Wake now** button and a button
  to jump to that tab.
- **Activity** — the recent calls with durations and error text.
- **Developed by Devmuhnnad** — links to the project's author on GitHub.

The badge shows in-flight work when busy, the applet count when idle, `z` when
the Flow tab is suspended, `0` when no applet is open, and `!` when no MCP
server is reachable.

## Tools

- `flow_status` — bridge health, applets, and MCP clients sharing the bridge
- `flow_upload_media` — **path** to a local image or video → Flow `mediaId`
- `flow_generate_image` — prompt, aspectRatio, modelDisplayName, referenceImageMediaIds
- `flow_generate_video` — prompt + frames, references, source video, audio refs, duration, resolution
- `flow_generate_text` — prompt, systemInstruction, thinkingLevel, and image/video/audio context files
- `flow_get_media_url` — mediaId → URL

Requests are spread across all open applets, least-busy first, so several agents
can work at once.

### Uploading

`flow_upload_media` takes a **file path on the machine running the server**, not
base64 — the server reads and encodes the file itself. **Images and video only**
(see below):

```
flow_upload_media { path: "C:/shots/ref.png" }  →  { mediaId, name, mimeType, bytes }
```

The returned `mediaId` is what the generate tools want for
`referenceImageMediaIds`, `firstFrameImageMediaId`, `lastFrameImageMediaId` and
`sourceVideoMediaId`. Type is taken from the extension, falling back to
magic-byte sniffing, and `mimeType` overrides both. `mode: "save"` sends
`FLOW_SAVE` instead of `FLOW_UPLOAD`. Both reach the *same* host handler and
return a media id; the only difference is that `save` shows a
"Saving to gallery…" toast in the Flow tab.

Files travel base64-encoded over the WebSocket and through the extension, which
gets unreliable when large, so uploads are capped at
`FLOW_MCP_MAX_UPLOAD_MB` (32 MB).

**Audio cannot be uploaded** — confirmed by testing, and the host code says why.
Its upload handler branches `video/*` to `upload_video` and *everything else* to
`upload_image`, so an audio file is submitted as an image and refused by the
backend; its telemetry only knows the types `IMAGE` and `VIDEO`. The tool now
rejects non-image/video files up front with that explanation. Consequences:

- For audio on a video, `audioReferenceMediaIds` has to use a `voices/<name>`
  preset or audio already present in your Flow project — you cannot bring your
  own audio file in through this bridge.
- `flow_generate_text` still accepts audio files, because it sends them inline
  as base64 rather than uploading them.

### Video options that aren't in the Flow UI

- **`sourceVideoMode: "extend"`** with `sourceVideoMediaId` continues an
  existing video past its end (the host calls this `EXTEND_VIDEO`; in the UI it
  is the Scenebuilder "extend clip" action, not reachable from the prompt box).
  The host rejects it without a source video, or combined with
  `firstFrameImageMediaId` / `lastFrameImageMediaId`.
- **`sourceVideoMode: "edit"`** edits the source video instead (`EDIT_VIDEO`).
- Passing `sourceVideoMediaId` with **no** mode is also valid — it becomes an
  ordinary video reference.
- **`audioReferenceMediaIds`** accepts audio media ids *or* named voice presets
  written `voices/<name>` (Flow strips the prefix itself). Note you cannot
  upload your own audio to get an id — see the upload section.
- **`resolution` accepts only `360p` or `720p`** through this API. Flow knows
  `1080p` and `4k`, but the applet-facing validator rejects them.
- `durationSeconds` must be a positive whole number.
- An unrecognised `aspectRatio` does not error — it silently becomes landscape.
- Flow also has an experimental generator (`FLOW_GEN_VIDEO_EXPERIMENTAL`). It is
  deliberately **not** exposed here: its quota table entry is empty
  (`case "EXPERIMENTAL": break;`) and an ordinary account's model catalog holds
  no experimental models, so the backend rejects every request with a generic
  "Video generation service unavailable". Use the normal video tool.

### Model names

`modelDisplayName` is a misnomer: the host assigns it to `videoModelFamilyId`
and resolves it, **case-insensitively and with emoji stripped**, against

1. the family **id**, then
2. the family **display name**, then
3. the family's **aliases**.

If none match, your string is passed to the backend unchanged (so a typo fails
server-side, not locally). These were the families available in one capture —
the list comes from the server per account, so treat it as an example, not a
constant:

| Display name | Family id | Aliases |
| --- | --- | --- |
| Veo 3.1 - Quality | `veo_3_1_quality` | |
| Veo 3.1 - Fast | `veo_3_1_fast` | |
| Veo 3.1 - Lite | `veo_3_1_lite` | |
| Omni 1.2 Flash | `macaron_cookie` | |
| Omni 1.1 Flash | `abra` | `Omni Flash` |
| Veo 3.1 - Upsampler 1080P | `veo_3_1_upsampler_1080p` | |
| Veo 3.1 - Upsampler 4K | `veo_3_1_upsampler_4k` | |
| Omni - Upsampler 360p | `omni_upsampler_360p` | |
| 🍌 Nano Banana Pro | `nano_banana_pro` | |
| 🍌 Nano Banana 2.1 | `beluga_display` | `Nano Banana 2` |
| 🍌 Nano Banana 2 Lite | `harbor_seal` | |

To read the current list for your own account, open the Flow tab and look at the
model dropdown — those labels are the display names.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLOW_MCP_WS_PORT` | `8765` | Bridge port. If you change it, change `DEFAULT_PORT` in `extension/background.js` to match. |
| `FLOW_MCP_CLIENT_NAME` | `flow-mcp` | Label shown for this client in the popup. |
| `FLOW_MCP_BRIDGE_WAIT_MS` | `15000` | How long a call waits for Chrome / an applet before failing. |
| `FLOW_MCP_MAX_UPLOAD_MB` | `32` | Largest file `flow_upload_media` will send. |

`server.js --port <n>` also works.

## Debugging
- Applet frame: DevTools → Console context dropdown → pick the `scf.usercontent.goog`
  frame; `window.FLOW_PORT` should exist.
- Extension: `chrome://extensions` → "service worker" link → look for `[flow-mcp]` logs.
- MCP server logs go to stderr, prefixed `[flow-mcp]`, and name the elected role.
- If a failure's cause is unclear, check the Flow tab itself: the host logs the
  original error object as a console warning before flattening it.

This uses Flow's internal applet messaging, which is not a public API and can
change without notice.
