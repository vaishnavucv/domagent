# DOMAgent — Chrome Extension

> Let AI agents control your real Chrome browser through the Chrome DevTools Protocol (CDP). No headless browsers. No separate drivers. Your existing tabs, sessions, and cookies — all intact.

---

## What This Extension Does

The DOMAgent Chrome extension is a **local bridge** between the MCP server running on your machine and the Chrome browser. It uses the **`chrome.debugger` API** to attach to browser tabs and relay Chrome DevTools Protocol (CDP) commands in real time.

### How a command flows

```
AI Agent
  │  stdio (MCP protocol)
  ▼
MCP Server  (domagent-mcp/index.js + server.js)
  │  WebSocket  ws://127.0.0.1:18792/extension
  ▼
Chrome Extension  (background.js service worker)
  │  chrome.debugger API → CDP
  ▼
Chrome Tab  (your real, logged-in browser)
```

### What each command does under the hood

| MCP Tool | CDP call inside background.js |
|----------|-------------------------------|
| `navigate` | `chrome.tabs.create` / `chrome.tabs.update` + `Browser.ensureTab` |
| `use_current_tab` | `Browser.useCurrentTab` → attaches debugger to focused tab |
| `click` | `Runtime.evaluate` → dispatches `MouseEvent` on the element |
| `type_text` | `Runtime.evaluate` → sets `.value` + fires `input`/`change` events |
| `get_screenshot` | `Page.captureScreenshot` → PNG as base64 |
| `evaluate_script` | `Runtime.evaluate` with `returnByValue: true` |
| `get_interactive_elements` | `Runtime.evaluate` → DOM scan + overlay boxes drawn |
| `clear_overlays` | `Runtime.evaluate` → removes all `.__da-*` overlay elements |
| `get_text` | `Runtime.evaluate` → reads `.innerText` of element |

### Why your real browser instead of headless?

| Headless browser | DOMAgent (real browser) |
|-----------------|------------------------|
| No existing session — must log in again | All your cookies and sessions are present |
| Invisible — can't watch what happens | You see every action as it happens |
| Slow setup (Puppeteer/Playwright spin-up) | Instant — extension is already loaded |
| Separate process, separate profile | Same Chrome profile you use every day |

---

## Extension Files

```
chrome/
├── manifest.json      ← MV3 manifest (debugger + tabs + storage permissions)
├── background.js      ← Service worker: CDP relay, tab management, WebSocket
├── content.js         ← Page-side overlay helpers (visual indicators)
├── options.html       ← Settings UI (host, port, WS path)
├── options.js         ← Saves/restores settings in chrome.storage.local
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## How to Manually Load This Extension in Chrome

> **Start the MCP server first** (`cd domagent-mcp && npm install && npm start`) so the extension has something to connect to when it loads.

### Step 1 — Open the Chrome Extensions page

In the Chrome address bar, navigate to:

```
chrome://extensions
```

Or go to: **⋮ (three-dot menu)** → **More tools** → **Extensions**

---

### Step 2 — Enable Developer Mode

In the **top-right corner** of the Extensions page, toggle **Developer mode** to **ON**.

> This reveals the **Load unpacked**, **Pack extension**, and **Update** buttons. Chrome requires Developer mode to be on for all locally-loaded extensions.

---

### Step 3 — Load the unpacked extension

Click **"Load unpacked"**.

In the file picker that opens, navigate to and **select this exact folder**:

```
/path/to/chrome-extension/domagent-extension/chrome/
```

> ⚠️ Select the `chrome/` folder itself — not `domagent-extension/`, not `manifest.json`. Chrome reads `manifest.json` from inside the folder you select.

Click **"Select Folder"** (macOS/Linux) or **"Select"** (Windows).

---

### Step 4 — Confirm the extension loaded

DOMAgent should now appear on the Extensions page showing:
- **Name:** DOMAgent
- **Version:** 0.1.0
- **Status:** Enabled (blue toggle)

If there is a red error box, the most common causes are:
- Wrong folder selected (no `manifest.json` at the root)
- Syntax error in a JS file (check the error message)

---

### Step 5 — Pin the extension icon to your toolbar

1. Click the **🧩 (Extensions) icon** in the Chrome toolbar
2. Find **DOMAgent** in the dropdown list
3. Click the **📌 (pin) icon** next to it

The DOMAgent icon will appear permanently in the toolbar showing a badge:

| Badge | Meaning |
|-------|---------|
| `ON` (orange) | Debugger attached and active on this tab |
| `…` (amber) | Connecting to MCP server |
| `!` (red) | Connection error — MCP server not running |
| *(empty)* | Extension loaded but not yet attached to this tab |

---

### Step 6 — Configure the connection (if needed)

The default settings work without any changes if you run `npm start` in `domagent-mcp/`. To change them:

1. **Right-click** the DOMAgent icon in the toolbar
2. Select **"Options"**
3. Update the fields:

| Field | Default | Description |
|-------|---------|-------------|
| Host | `127.0.0.1` | IP/hostname of the MCP server |
| Port | `18792` | Port the MCP server WebSocket listens on |
| WS Path | `/extension` | WebSocket endpoint path |

4. Click **Save**. The extension reconnects automatically.

---

### Step 7 — Verify the connection

1. Confirm `npm start` printed: `DOMAgent Bridge running on ws://127.0.0.1:18792/extension`
2. Open any `http://` or `https://` page in Chrome — the extension auto-attaches  
3. The MCP server terminal should print: `Extension connected`
4. The DOMAgent toolbar icon badge should show `ON`

---

## Tab Management

The extension uses a **single dedicated automation tab** to avoid interfering with your browsing:

| Event | Behaviour |
|-------|-----------|
| First `navigate` call | Creates one new tab; this becomes the automation tab |
| Later `navigate` calls | Reuses that same tab — navigates it to the new URL instead of opening another |
| `use_current_tab` call | Adopts whichever tab you currently have focused (no new tab created) |
| Tab closed by user | Automation tab reference cleared; next navigate creates a fresh one |
| Service worker restarted | Tab ID is recovered from `chrome.storage.session` — no duplicate tabs |
| Your other tabs | Never touched or hijacked |

---

## Toolbar Icon — Toggle Automation

Clicking the DOMAgent icon on the toolbar **toggles** debugger attachment for the current tab:

- **If attached** → detaches the debugger from that tab (tab goes back to normal)
- **If detached** → attaches the debugger and connects to the MCP server

This is useful when you want to temporarily stop automation on a specific tab.

---

## Hiding the "Automated Test Software" Banner

Chrome shows a yellow info bar at the top of debugger-attached tabs:

> *"Chrome is being controlled by automated test software."*

To suppress this banner permanently, launch Chrome with the `--silent-debugger-extension-api` flag:

**macOS:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --silent-debugger-extension-api
```

**Windows (Command Prompt):**
```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" --silent-debugger-extension-api
```

**Linux:**
```bash
google-chrome --silent-debugger-extension-api
```

> 💡 **Tip:** Create a shell alias or a desktop shortcut with this flag so you never need to type it manually.

---

## Updating the Extension

After pulling new code:

1. Go to `chrome://extensions`
2. Find **DOMAgent**
3. Click the **🔄 (reload/refresh) icon** on the extension card

You do **not** need to remove and re-add it.

---

## Removing the Extension

1. Go to `chrome://extensions`
2. Find **DOMAgent**
3. Click **"Remove"** → confirm the prompt

---

## Visual Indicators

When the AI agent interacts with the page, the extension injects brief non-blocking visual cues:

| Indicator | Colour | Trigger |
|-----------|--------|---------|
| Pulsing dot + highlight box | 🟡 Amber/yellow | `click` action on an element |
| Pulsing dot + highlight box | 🟢 Green | `type_text` action on an input |
| Dashed overlay boxes (yellow) | 🟡 | `get_interactive_elements` — clickable elements |
| Dashed overlay boxes (green) | 🟢 | `get_interactive_elements` — typeable inputs |
| Thin solid boxes (cyan) | 🔵 | `get_interactive_elements` — text content elements |

All overlays auto-fade and remove themselves after ~4 seconds.

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| Extension card shows a red error | Wrong folder selected, or JS parse error | Select the `chrome/` folder; check error message |
| Badge shows `!` (red) | MCP server not running | Run `npm start` in `domagent-mcp/` |
| Badge stuck on `…` (amber) | Server running but wrong port/host | Open Options and verify host/port match |
| Commands fail on a tab | Tab not attached | Click the toolbar icon to manually attach |
| `chrome.debugger` denied error | Another debugger tool is using the tab | Close DevTools on that tab; try again |
| Yellow debug banner | Debugger attached | Launch Chrome with `--silent-debugger-extension-api` |
| After restart, new duplicate tabs | Service worker state lost | Expected on Chrome restart; one new tab will be created |

---

## Technical Reference

| Property | Value |
|----------|-------|
| Manifest version | MV3 |
| Background context | **Service Worker** (`background.js`) — restarts when idle |
| DOM access method | **`chrome.debugger` API** → Chrome DevTools Protocol (CDP) |
| Permissions | `debugger`, `tabs`, `activeTab`, `storage` |
| Host permissions | `http://127.0.0.1/*`, `http://localhost/*` |
| Default WS endpoint | `ws://127.0.0.1:18792/extension` |
| Minimum Chrome version | Chrome 88+ (MV3 + `chrome.storage.session`) |
| Session persistence | `chrome.storage.session` (survives service-worker suspension, cleared on browser quit) |
