# DOMAgent

> **A browser extension and MCP server that lets AI agents control your real browser. No headless browsers, no puppets. Works with Chrome and Firefox.**

The agent connects to the MCP server running on your machine, and the MCP server relays commands to the browser via the extension. Every action (click, type, screenshot, navigate, etc.) happens in your real, already-open browser window.

[![npm version](https://img.shields.io/npm/v/domagent)](https://www.npmjs.com/package/domagent)
[![npm downloads](https://img.shields.io/npm/dm/domagent)](https://www.npmjs.com/package/domagent)

```bash
npx domagent
```

---

## Why DOMAgent?

| Without DOMAgent | With DOMAgent |
|---|---|
| Headless browser: invisible, no session | Your real browser: logged in, cookies intact |
| Slow Puppeteer/Playwright spin-up | Instant: extension already loaded |
| Can't interact with your open tabs | Can adopt any tab you already have open |
| Complex DevTools setup | One-click install and `npm start` |

---

## Architecture

```
┌──────────────────┐  WebSocket   ┌──────────────────┐   stdio    ┌──────────────┐
│  Browser         │◄────────────►│   MCP Server      │◄──────────►│  AI Agent    │
│  Extension       │  (JSON-RPC)  │  (index.js        │   MCP      │ (Claude,     │
│  (background.js) │              │  + server.js)     │            │  Ollama, …)  │
└──────────────────┘              └──────────────────┘            └──────────────┘
```

```
.
├── domagent-extension/
│   ├── chrome/                  ← Chrome extension
│   │   ├── background.js        ← Service worker (CDP via debugger API)
│   │   ├── manifest.json
│   │   ├── options.html / options.js
│   │   └── icons/
│   └── firefox/                 ← Firefox extension
│       ├── background.js        ← Background script (content-script relay)
│       ├── content.js           ← Content script injected into pages
│       ├── manifest.json
│       ├── options.html / options.js
│       └── icons/
└── domagent-mcp/                ← Node.js MCP server (runs locally)
    ├── index.js                 ← MCP server entry point
    ├── server.js                ← WebSocket bridge implementation
    └── package.json
```

---

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `navigate` | Open a URL, reuses the automation tab (no duplicate tabs) |
| `use_current_tab` | Adopt the user's active tab, no new tab created |
| `click` | Click an element by CSS selector (shows orange visual indicator) |
| `type_text` | Type into an input field by CSS selector (shows blue visual indicator) |
| `get_text` | Get the text content of an element |
| `evaluate_script` | Execute arbitrary JavaScript in the page |
| `get_screenshot` | Capture a PNG screenshot of the current page |
| `get_interactive_elements` | List all visible interactive elements with selectors and bounding boxes |
| `clear_overlays` | Remove all visual overlay boxes from the page |

---

## Tab Management

The extension uses a **single automation tab** design so your other tabs are never hijacked:

1. **First `navigate` call** will create one new tab, and pin it as the automation tab
2. **Subsequent `navigate` calls** will reuse that same tab (it navigates to the new URL)
3. **`use_current_tab`** will adopt whatever tab you have focused (no new tab)
4. **All commands** (click, type, screenshot, etc.) will always target the automation tab via session ID
5. **Your other tabs** are never touched

---

## Quick Start

### 1. Start the MCP Server

```bash
cd domagent-mcp
npm install
npm start
```

The server starts a WebSocket on `ws://127.0.0.1:18792/extension` and waits for the browser extension to connect.

### 2. Load the Extension

- **Chrome**: See [`domagent-extension/chrome/README.md`](domagent-extension/chrome/README.md)
- **Firefox**: See [`domagent-extension/firefox/README.md`](domagent-extension/firefox/README.md)

### 3. Connect your AI Agent

Configure your AI agent to use the MCP server via **stdio** transport.

**Recommended — use the npm package (no path needed):**

```json
{
  "mcpServers": {
    "domagent": {
      "command": "npx",
      "args": ["domagent"]
    }
  }
}
```

**Alternative — run from source:**

```json
{
  "mcpServers": {
    "domagent": {
      "command": "node",
      "args": ["/absolute/path/to/domagent-mcp/index.js"]
    }
  }
}
```

---

## Extension Options

Right-click the extension icon and select **Options** to configure the WebSocket connection:

| Setting | Default |
|---------|---------|
| Host | `127.0.0.1` |
| Port | `18792` |
| WS Path | `/extension` |

---

## Visual Indicators

When the automation clicks or types, a brief visual indicator appears:

- 🟠 **Orange dot**: click action
- 🔵 **Blue dot**: type action
- 🟡 **Yellow dashed box**: highlighted interactive element
- 🟢 **Green dashed box**: highlighted typeable element

Indicators pulse and fade automatically without interfering with the page.

---

## How Chrome vs Firefox Differ

| Feature | Chrome | Firefox |
|---------|--------|---------|
| DOM access method | `chrome.debugger` API (CDP) | Content script relay |
| Background context | Service Worker | Persistent background script |
| Debug banner | Yes (suppressible with flag) | No banner |
| Min version | Any modern Chrome | Firefox 109+ |

---

## Browser-Specific Guides

| Browser | README |
|---------|--------|
| � Chrome | [`domagent-extension/chrome/README.md`](domagent-extension/chrome/README.md) |
| 🦊 Firefox | [`domagent-extension/firefox/README.md`](domagent-extension/firefox/README.md) |
