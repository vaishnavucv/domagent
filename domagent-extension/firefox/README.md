# DOMAgent — Firefox Extension

> Let AI agents control your real Firefox browser through a content-script relay. No headless browsers. No separate drivers. Your existing tabs, sessions, and cookies — all intact.

---

## What This Extension Does

The DOMAgent Firefox extension is a **local bridge** between the MCP server running on your machine and the Firefox browser. Because Firefox does **not** support the `chrome.debugger` / `browser.debugger` API used by the Chrome extension, this version uses a **content script relay** instead:

1. `background.js` connects to the local MCP server via WebSocket
2. Commands from the AI agent arrive at `background.js`
3. `background.js` forwards each command to the tab's `content.js` via `browser.tabs.sendMessage()`
4. `content.js` executes the action directly inside the page context and returns the result

### How a command flows

```
AI Agent
  │  stdio (MCP protocol)
  ▼
MCP Server  (domagent-mcp/index.js + server.js)
  │  WebSocket  ws://127.0.0.1:18792/extension
  ▼
Firefox Extension  (background.js — persistent background script)
  │  browser.tabs.sendMessage()
  ▼
Content Script  (content.js — injected into every page)
  │  DOM APIs / JavaScript in page context
  ▼
Firefox Tab  (your real, logged-in browser)
```

### What each command does under the hood

| MCP Tool | What happens in Firefox |
|----------|-------------------------|
| `navigate` | `browser.tabs.create` / `browser.tabs.update` + `Browser.ensureTab` in background.js |
| `use_current_tab` | `browser.tabs.query({active:true})` → adopts focused tab as automation target |
| `click` | content.js receives `{method:'click', params:{selector}}` → dispatches `MouseEvent` on element |
| `type_text` | content.js sets element `.value` via prototype setter + fires `input`/`change` events |
| `get_screenshot` | content.js calls `browser.tabs.captureVisibleTab()` (via background message) |
| `evaluate_script` | content.js wraps expression in `eval()` / `Function()` and returns result |
| `get_interactive_elements` | content.js queries DOM, draws overlay boxes, returns element list |
| `clear_overlays` | content.js removes all `.__da-*` overlay elements from the page |
| `get_text` | content.js reads `.innerText` of matched element |

### Why your real browser instead of headless?

| Headless browser | DOMAgent (real browser) |
|-----------------|------------------------|
| No existing session — must log in again | All your cookies and sessions are present |
| Invisible — can't watch what happens | You see every action as it happens |
| Slow setup (Playwright/Puppeteer spin-up) | Instant — extension is already loaded |
| Separate process, separate profile | Same Firefox profile you use every day |
| Shows "automated software" banner in CDP tools | No debug banner at all in Firefox |

---

## Extension Files

```
firefox/
├── manifest.json      ← MV3 manifest (tabs + storage + content_scripts)
├── background.js      ← Persistent background script: WS relay, tab management
├── content.js         ← Content script injected into all pages: executes commands
├── options.html       ← Settings UI (host, port, WS path)
├── options.js         ← Saves/restores settings in browser.storage.local
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

> **Key difference from Chrome:** Firefox uses a **persistent background script** (not a Service Worker), and includes `content.js` injected into every page as the command executor.

---

## How Firefox Differs from Chrome

| Feature | Chrome extension | Firefox extension |
|---------|-----------------|-------------------|
| Background context | **Service Worker** (may be suspended when idle) | **Persistent background script** (always running) |
| Tab DOM access | `chrome.debugger` API → CDP protocol | `browser.tabs.sendMessage()` → content script |
| Debug banner on tabs | ✅ Yes (suppressible with flag) | ❌ None — tabs look completely normal |
| Minimum browser version | Chrome 88+ | **Firefox 109+** |
| Extension ID | Auto-generated | `domagent@local` (fixed in `gecko` settings) |
| Session storage used | `chrome.storage.session` | `browser.storage.session` (falls back gracefully) |
| `browser.*` vs `chrome.*` | Uses `chrome.*` | Uses `browser.*` (Promise-based); background.js uses an `api` shim that picks the right one |

---

## How to Manually Load This Extension in Firefox

Firefox has two installation methods for local (unsigned) extensions:

| Method | Persistence | Works on |
|--------|------------|---------|
| **Temporary load** via `about:debugging` | Removed when Firefox closes | All Firefox editions |
| **Permanent install** via XPI | Survives restarts | Firefox Developer Edition / Nightly only |

---

### Method A — Temporary Load (All Firefox Editions)

This is the quickest way to get started. Repeat after every Firefox restart.

> **Start the MCP server first** (`cd domagent-mcp && npm install && npm start`)

#### Step 1 — Open the debugging page

In the Firefox address bar, go to:

```
about:debugging#/runtime/this-firefox
```

Or: **☰ (hamburger menu)** → **More tools** → **Remote Debugging** → **This Firefox**

---

#### Step 2 — Load the extension

Click **"Load Temporary Add-on…"**

In the file picker, navigate to:

```
/path/to/chrome-extension/domagent-extension/firefox/
```

Select the **`manifest.json`** file inside the `firefox/` folder.

> ⚠️ For Firefox you select the **file** (`manifest.json`), not the folder. This is the opposite of how Chrome works.

Click **"Open"**.

---

#### Step 3 — Confirm the extension loaded

Under **Temporary Extensions** you should now see:

- **Name:** DOMAgent
- **Version:** 0.1.0
- Buttons: **Reload**, **Inspect**, **Remove**

---

#### Step 4 — Pin the icon to the toolbar

1. Click the **🧩 (Extensions) icon** or **☰ menu** → **Extensions**
2. Find **DOMAgent**
3. Click the **gear ⚙️** → **"Pin to Toolbar"**

The DOMAgent icon appears in the Firefox toolbar. Its badge shows:

| Badge | Meaning |
|-------|---------|
| `ON` (orange) | Extension active and attached to this tab |
| `…` (amber) | Connecting to MCP server |
| `!` (red) | Connection error — MCP server not running |
| *(empty)* | Not yet attached to this tab |

---

#### Step 5 — Verify the connection

1. Confirm `npm start` printed: `DOMAgent Bridge running on ws://127.0.0.1:18792/extension`
2. Open any `http://` or `https://` page — the extension auto-attaches via content script
3. The MCP server terminal should print: `Extension connected`
4. The toolbar badge should show `ON`

---

### Method B — Permanent Install (Firefox Developer Edition / Nightly)

Standard Firefox enforces extension signature verification, which blocks unsigned local extensions from being installed permanently. **Firefox Developer Edition** and **Firefox Nightly** allow bypassing this.

#### Step 1 — Download Firefox Developer Edition or Nightly

- **Developer Edition:** https://www.mozilla.org/firefox/developer/
- **Nightly:** https://www.mozilla.org/firefox/nightly/

Install and open it.

---

#### Step 2 — Disable signature enforcement

In the address bar navigate to:

```
about:config
```

Accept the risk warning. Search for:

```
xpinstall.signatures.required
```

Double-click the entry to set it to **`false`**.

> This preference only has effect in Developer Edition and Nightly — it is locked to `true` in standard Firefox releases.

---

#### Step 3 — Package the extension as an XPI

An XPI file is just a ZIP archive with the `.xpi` extension. Run this in your terminal:

```bash
cd /path/to/chrome-extension/domagent-extension/firefox/

zip -r domagent-firefox.xpi \
  manifest.json \
  background.js \
  content.js \
  options.html \
  options.js \
  icons/
```

---

#### Step 4 — Install the XPI

In Firefox Developer Edition or Nightly:

1. Open **☰** → **Add-ons and Themes** (or press `Ctrl+Shift+A` / `⌘+Shift+A`)
2. Click the **gear icon ⚙️** → **"Install Add-on From File…"**
3. Select the `domagent-firefox.xpi` you just created
4. Click **"Add"** in the confirmation popup

DOMAgent is now **permanently installed** and persists across restarts.

---

### Step 6 — Configure the connection (if needed)

Defaults work without changes when the MCP server runs on its default port. To customize:

1. **Right-click** the DOMAgent toolbar icon
2. Select **"Manage Extension"** → **"Preferences"** tab

   — or —

   Go to `about:addons` → click **DOMAgent** → **Preferences** tab

3. Adjust:

| Field | Default | Description |
|-------|---------|-------------|
| Host | `127.0.0.1` | IP/hostname of the MCP server |
| Port | `18792` | Port the MCP server WebSocket listens on |
| WS Path | `/extension` | WebSocket endpoint path |

4. Click **Save**. The background script reconnects automatically.

---

## Tab Management

Same single-automation-tab design as the Chrome extension:

| Event | Behaviour |
|-------|-----------|
| First `navigate` call | Creates one new tab; this becomes the automation tab |
| Later `navigate` calls | Reuses that same tab — navigates it to the new URL |
| `use_current_tab` call | Adopts whichever tab is currently focused (no new tab) |
| Tab closed by user | Automation tab reference cleared; next navigate creates a fresh one |
| Your other tabs | Never touched or hijacked |
| Firefox restart (temporary install) | Extension removed; must reload from `about:debugging` |
| Firefox restart (permanent install) | Extension persists; automation tab restored from `browser.storage.session` |

---

## Toolbar Icon — Toggle Automation

Clicking the DOMAgent icon in the Firefox toolbar **toggles** the extension's attachment to the current tab:

- **If attached** → detaches content script listener from that tab (tab goes back to normal)
- **If detached** → re-attaches and connects to the MCP server

---

## No Debug Banner

Unlike Chrome (which shows a yellow bar when the debugger API is active), **Firefox shows no banner at all**. Because DOMAgent uses a content script relay instead of the `debugger` API, the tab looks completely normal from the user's point of view.

---

## Updating the Extension

**Temporary install:**
1. Go to `about:debugging#/runtime/this-firefox`
2. Find **DOMAgent** under Temporary Extensions
3. Click **"Reload"**

**Permanent install (Developer Edition/Nightly):**
- Re-package and reinstall the XPI (Step 3–4 above), or
- Click **"Reload"** from `about:debugging`

---

## Removing the Extension

**Temporary install:** Close Firefox. The extension is automatically unloaded.

**Permanent install:**
1. Go to `about:addons`
2. Find **DOMAgent**
3. Click **⋯** → **"Remove"** → Confirm

---

## Visual Indicators

When the AI agent interacts with the page, `content.js` injects brief visual cues:

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
| Extension disappears after restart | Temporary install | Use Method B (permanent) with Firefox Developer Edition |
| "The add-on could not be installed" | Signature enforcement on | Use Developer Edition and set `xpinstall.signatures.required` to `false` |
| File picker shows no `manifest.json` | Wrong directory | Navigate into `domagent-extension/firefox/` and select `manifest.json` |
| Badge shows `!` (red) | MCP server not running | Run `npm start` in `domagent-mcp/` |
| Badge stuck on `…` (amber) | Server running but wrong port/host | Open Options and verify host/port match |
| Commands do nothing on a page | Content script not injected yet | Refresh the tab after loading the extension |
| `Content script error: …` in console | Content script crashed | Open `about:debugging` → click **Inspect** on DOMAgent → check Console tab |
| Cannot connect to `ws://127.0.0.1:18792` | CSP or wrong port | Verify the port in Options matches the MCP server output |

---

## Technical Reference

| Property | Value |
|----------|-------|
| Manifest version | MV3 |
| Background context | **Persistent background script** (`background.js`) — never suspended |
| DOM access method | **Content script relay** (`content.js` injected at `document_idle` into `<all_urls>`) |
| Command routing | `browser.tabs.sendMessage(tabId, {method, params})` → `content.js` |
| Permissions | `tabs`, `activeTab`, `storage` |
| Host permissions | `http://127.0.0.1/*`, `http://localhost/*`, `<all_urls>` |
| Default WS endpoint | `ws://127.0.0.1:18792/extension` |
| Extension ID (Gecko) | `domagent@local` |
| Minimum Firefox version | **109.0** |
| `browser.*` compat shim | `const api = typeof browser !== 'undefined' ? browser : chrome` |
| Session persistence | `browser.storage.session` (cleared on browser quit; graceful fallback on older Firefox) |
