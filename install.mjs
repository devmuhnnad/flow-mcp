#!/usr/bin/env node
// One-shot installer for the Flow MCP Bridge.
//
// Does the parts a machine can do - check Node, install dependencies, work out
// the absolute paths, register the server with an MCP client - and then prints
// the browser steps, which a person has to do by hand: no browser lets a script
// load an unpacked extension.
//
// Zero dependencies, so it runs straight after `git clone`.
//
//   node install.mjs                      # set up, then print what to do
//   node install.mjs --client claude-code # also register with that client
//   node install.mjs --list               # show detected MCP clients
//   node install.mjs --skip-install       # don't run npm install
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(ROOT, 'mcp-server');
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.js');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const MIN_NODE = 18;

// ----------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
};

// -------------------------------------------------------------------- output

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const OFF = '\x1b[0m';
const plain = !process.stdout.isTTY || flag('no-color');
const paint = (code, s) => (plain ? s : `${code}${s}${OFF}`);

const out = (s = '') => console.log(s);
const heading = (s) => { out(); out(paint(BOLD, s)); out(paint(DIM, '-'.repeat(s.length))); };
const ok = (s) => out(`  ${paint(GREEN, 'OK')}  ${s}`);
const warn = (s) => out(`  ${paint(YELLOW, '!')}   ${s}`);
const fail = (s) => out(`  ${paint(RED, 'X')}   ${s}`);
const step = (n, s) => out(`  ${paint(BOLD, n + '.')} ${s}`);

// ------------------------------------------------------------- MCP clients

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

/** Where each client keeps its MCP server list, per platform. */
function desktopConfigPath() {
  if (process.platform === 'win32') return path.join(APPDATA, 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json');
}

const CLIENTS = {
  'claude-code': {
    label: 'Claude Code (CLI)',
    kind: 'command',
    detect: () => hasCommand('claude'),
    register: registerClaudeCode,
    manual: () => `claude mcp add flow -- node ${quote(SERVER_ENTRY)}`,
  },
  'claude-desktop': {
    label: 'Claude Desktop',
    kind: 'json',
    file: desktopConfigPath(),
    key: 'mcpServers',
    detect() { return fs.existsSync(path.dirname(this.file)); },
    restart: 'Quit Claude Desktop completely and reopen it.',
  },
  cursor: {
    label: 'Cursor',
    kind: 'json',
    file: path.join(HOME, '.cursor', 'mcp.json'),
    key: 'mcpServers',
    detect() { return fs.existsSync(path.dirname(this.file)); },
    restart: 'Reload Cursor.',
  },
  vscode: {
    label: 'VS Code (workspace .vscode/mcp.json)',
    kind: 'json',
    file: path.join(process.cwd(), '.vscode', 'mcp.json'),
    key: 'servers',
    detect: () => false, // opt in explicitly; it writes into the current folder
    restart: 'Reload the VS Code window.',
  },
  codex: {
    label: 'Codex CLI',
    kind: 'toml',
    file: path.join(HOME, '.codex', 'config.toml'),
    detect() { return fs.existsSync(path.dirname(this.file)); },
    restart: 'Start a new Codex session.',
  },
};

const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);

function hasCommand(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [cmd], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
}

/** The JSON an MCP client needs for this server. */
const serverSpec = () => ({ command: 'node', args: [SERVER_ENTRY] });

function jsonSnippet(key) {
  return JSON.stringify({ [key]: { flow: serverSpec() } }, null, 2);
}

const tomlSnippet = () =>
  `[mcp_servers.flow]\ncommand = "node"\nargs = [${JSON.stringify(SERVER_ENTRY)}]`;

// ------------------------------------------------------------------- actions

function checkNode() {
  heading('1. Node');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE) {
    fail(`Node ${process.versions.node} is too old; this needs Node ${MIN_NODE} or newer.`);
    process.exit(1);
  }
  ok(`Node ${process.versions.node}`);
}

function installDeps() {
  heading('2. Dependencies');
  if (flag('skip-install')) { warn('skipped (--skip-install)'); return; }
  if (!fs.existsSync(path.join(SERVER_DIR, 'package.json'))) {
    fail(`mcp-server/package.json not found. Is ${ROOT} the repository root?`);
    process.exit(1);
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  out(paint(DIM, `  running: npm install  (in ${SERVER_DIR})`));
  const res = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: SERVER_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    fail('npm install failed. Fix the error above and re-run.');
    process.exit(1);
  }
  ok('dependencies installed');
}

function registerClaudeCode() {
  if (!hasCommand('claude')) {
    warn('the `claude` CLI is not on PATH; run this yourself once it is:');
    out(`      ${CLIENTS['claude-code'].manual()}`);
    return false;
  }
  const res = spawnSync('claude', ['mcp', 'add', 'flow', '--', 'node', SERVER_ENTRY], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    warn('`claude mcp add` failed; add it by hand with:');
    out(`      ${CLIENTS['claude-code'].manual()}`);
    return false;
  }
  ok('registered with Claude Code');
  return true;
}

/** Merge our entry into a client's JSON config, keeping everything else. */
function registerJson(client) {
  const file = client.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const exists = fs.existsSync(file);
  let config = {};
  if (exists) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw) {
      try {
        config = JSON.parse(raw);
      } catch {
        fail(`${file} is not valid JSON. Add this entry by hand instead:`);
        out(indent(jsonSnippet(client.key)));
        return false;
      }
    }
  }

  config[client.key] ??= {};
  const existing = config[client.key].flow;
  // Check before touching anything, so re-running leaves no stray backups.
  if (existing && JSON.stringify(existing) === JSON.stringify(serverSpec())) {
    ok(`already registered in ${file}`);
    return true;
  }
  if (exists) {
    const backup = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, backup);
    ok(`backed up existing config to ${backup}`);
  }
  if (existing) warn('replacing the existing "flow" entry');

  config[client.key].flow = serverSpec();
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  ok(`registered in ${file}`);
  return true;
}

const indent = (s) => s.split('\n').map((l) => '      ' + l).join('\n');

function registerClient(name) {
  const client = CLIENTS[name];
  heading(`3. Register with ${client.label}`);

  let done = false;
  if (client.kind === 'command') done = client.register();
  else if (client.kind === 'json') done = registerJson(client);
  else {
    // TOML is not safe to rewrite blindly, so show the lines to add.
    warn(`add these lines to ${client.file}:`);
    out(indent(tomlSnippet()));
    done = false;
  }
  if (done && client.restart) out(`      ${paint(DIM, client.restart)}`);
  return done;
}

function printAllClientConfigs() {
  heading('3. Register with your MCP client');
  out('  No client chosen. Re-run with --client <name>, or copy the right snippet:');
  for (const [name, client] of Object.entries(CLIENTS)) {
    out();
    out(`  ${paint(BOLD, client.label)}  ${paint(DIM, `--client ${name}`)}`);
    if (client.kind === 'command') out(indent(client.manual()));
    else if (client.kind === 'toml') out(indent(`# ${client.file}\n${tomlSnippet()}`));
    else out(indent(`// ${client.file}\n${jsonSnippet(client.key)}`));
  }
}

function printBrowserSteps() {
  heading('4. Load the extension (this part is yours)');
  out('  No browser allows a script to install an unpacked extension, so:');
  out();
  step(1, 'Open your browser\'s extensions page:');
  out(`       Chrome/Brave  ${paint(BOLD, 'chrome://extensions')}`);
  out(`       Edge          ${paint(BOLD, 'edge://extensions')}`);
  out(`       Firefox       ${paint(BOLD, 'about:debugging#/runtime/this-firefox')}`);
  step(2, 'Turn on "Developer mode" (Chromium only - top right).');
  step(3, 'Click "Load unpacked" and pick this exact folder:');
  out();
  out(`       ${paint(BOLD, EXTENSION_DIR)}`);
  out();
  out(paint(DIM, '       On Firefox use "Load Temporary Add-on" and pick manifest.json inside it.'));
  step(4, 'Open an applet at https://flow.google.com and leave that tab open.');
  out(paint(DIM, '       Keeping it in its own window stops the browser suspending it.'));
}

function printVerify(registered) {
  heading('5. Check it works');
  if (!registered) out('  Register the server with your client first, then:');
  out('  Start a new chat/session and ask the agent to call the `flow_status` tool.');
  out();
  out('  Expect: ' + paint(GREEN, '"ready": true') + ', with openApplets at least 1.');
  out();
  out('  If not:');
  out('    - "extensionConnected": false  -> the browser or extension is not running');
  out('    - "openApplets": 0             -> open an applet tab at flow.google.com');
  out('    - "awakeApplets": 0            -> the tab is suspended; click it once');
}

// ---------------------------------------------------------------------- main

function listClients() {
  heading('Detected MCP clients');
  for (const [name, client] of Object.entries(CLIENTS)) {
    const found = client.detect();
    const where = client.file ? paint(DIM, `  ${client.file}`) : '';
    out(`  ${found ? paint(GREEN, 'found') : paint(DIM, '  -  ')}  ${name.padEnd(15)} ${client.label}${where}`);
  }
  out();
  out('  Register one with: node install.mjs --client <name>');
}

function main() {
  out();
  out(paint(BOLD, '  Flow MCP Bridge installer'));
  out(paint(DIM, `  ${ROOT}`));

  if (flag('help')) {
    out('\n  node install.mjs [--client <name>] [--list] [--skip-install]');
    out(`\n  clients: ${Object.keys(CLIENTS).join(', ')}`);
    return;
  }
  if (flag('list')) { listClients(); return; }

  checkNode();
  installDeps();

  const name = option('client');
  let registered = false;
  if (name) {
    if (!CLIENTS[name]) {
      fail(`Unknown client "${name}". Known: ${Object.keys(CLIENTS).join(', ')}`);
      process.exit(1);
    }
    registered = registerClient(name);
  } else {
    printAllClientConfigs();
  }

  printBrowserSteps();
  printVerify(registered);
  out();
}

main();
