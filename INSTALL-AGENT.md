# Installing Flow MCP Bridge — instructions for an AI agent

You are setting this project up on the user's machine. Work through the phases
in order. Do not skip the verification at the end.

**The one thing you cannot do:** no browser lets a script install an unpacked
extension. Phase 4 is the user's to perform. Hand it over clearly and wait for
them to confirm, rather than claiming the install is finished.

## Phase 0 — Check before you start

| Requirement | Check | If missing |
| --- | --- | --- |
| Node 18+ | `node --version` | Ask the user to install Node, then stop. |
| Git | `git --version` | Needed only if you are cloning. |
| A Chromium browser or Firefox 128+ | ask | Safari is unverified; say so. |

Ask the user **which MCP client they want this registered with** before doing
anything that writes configuration. Valid values for `--client`:

`claude-code`, `claude-desktop`, `cursor`, `vscode`, `codex`

`node install.mjs --list` shows which of those it can find on this machine. If
the user does not know, run that and offer what it found.

## Phase 1 — Get the code

If the project is not already on disk, clone it somewhere permanent (not a temp
directory — the MCP client will point at this path forever):

```
git clone https://github.com/devmuhnnad/flow-mcp.git
cd flow-mcp
```

If it is already on disk, `cd` to it and use that path.

## Phase 2 — Run the installer

```
node install.mjs --client <the client the user chose>
```

This checks Node, runs `npm install` in `mcp-server/`, registers the server
with that client (backing up any existing config first), and prints the
remaining steps. It is safe to run twice.

Read its output and relay anything it marks `!` or `X`. If it reports that it
could not write a config, do what it suggests instead of inventing your own
path — the paths in the script are platform-correct.

## Phase 3 — Restart the client

MCP clients read their server list once at startup:

- **Claude Desktop** — quit completely (not just close the window) and reopen.
- **Claude Code / Codex** — start a new session.
- **Cursor / VS Code** — reload the window.

Tell the user to do this. Tools will not appear otherwise.

## Phase 4 — Hand the browser steps to the user

Give them these verbatim, with the absolute path the installer printed:

1. Open `chrome://extensions` (Edge: `edge://extensions`; Firefox:
   `about:debugging#/runtime/this-firefox`).
2. Turn on **Developer mode** (Chromium only, top right).
3. Click **Load unpacked** and select the `extension` folder inside the project.
   On Firefox, use **Load Temporary Add-on** and pick `manifest.json` in it.
4. Go to <https://flow.google.com>, open any applet, and leave that tab open.

Two things worth telling them, because both cause confusing failures later:

- Keeping the Flow tab **in its own window** stops the browser suspending it.
  A suspended tab runs no code and cannot answer requests.
- On Firefox, a temporary add-on is removed when the browser restarts.

Then **wait**. Ask them to confirm the extension is loaded and an applet is open.

## Phase 5 — Verify, and read the result properly

Call the `flow_status` tool. A healthy install returns `"ready": true` with
`openApplets` of at least 1.

| What you see | What it means | What to tell the user |
| --- | --- | --- |
| Tool not found at all | Client never loaded the server | Phase 3 was skipped, or the client needs a full restart |
| `extensionConnected: false` | Browser side is not running | Browser closed, or the extension is not loaded/enabled |
| `openApplets: 0` | Extension is live, no applet | Open an applet tab at flow.google.com |
| `awakeApplets: 0` | Tab is suspended | Click the Flow tab once; keep it in its own window |
| `ready: true` | Working | Offer a test generation |

Finish by generating something small (an image is quickest) to prove the whole
path works end to end. Do not declare success on `flow_status` alone.

## Notes that will save you time

- **Several agents at once is fine.** Each chat starts its own server process;
  the first to bind port 8765 becomes the hub and the rest route through it.
- **Upgrading?** Restart every running MCP client afterwards. A process started
  before the change keeps serving the old tool schema, and an old 0.1.x process
  still holding port 8765 does not speak the current protocol.
- **Reloading the extension** does not re-inject content scripts into already
  open tabs. The Flow tab must be reloaded too.
- **Do not** try to automate the browser steps, drive `chrome://extensions`
  through a browser-automation tool, or tell the user it has been handled.
  Loading an unpacked extension requires a real person in the browser UI.
