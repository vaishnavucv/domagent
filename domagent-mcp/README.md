# domagent — MCP Server

> The MCP (Model Context Protocol) server for DOMAgent. Lets AI agents control your real Chrome or Firefox browser through a local WebSocket bridge.

## Install

```bash
npm install -g domagent
```

Or run without installing:

```bash
npx domagent
```

## What it does

`domagent` is a local server that:
- Starts a WebSocket listener on `ws://127.0.0.1:18792/extension`
- Waits for the browser extension (Chrome or Firefox) to connect
- Exposes browser actions as MCP tools to any AI agent that supports the Model Context Protocol

The browser extension and the MCP server work together — the extension relays commands from the server into the real browser tab.

## Requirements

- Node.js 18 or newer
- The **DOMAgent browser extension** installed in Chrome or Firefox  
  → [Chrome install guide](../domagent-extension/chrome/README.md)  
  → [Firefox install guide](../domagent-extension/firefox/README.md)

## Configure your AI agent

Add `domagent` as an MCP server in your agent's config file.

### Claude Desktop (`claude_desktop_config.json`)

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

If you installed globally (`npm install -g domagent`):

```json
{
  "mcpServers": {
    "domagent": {
      "command": "domagent"
    }
  }
}
```

### Other MCP-compatible agents

Any agent that supports MCP stdio transport can use:

```
command: npx domagent
transport: stdio
```

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `navigate` | Open a URL — reuses the automation tab (no duplicate tabs) |
| `use_current_tab` | Adopt the user's active tab — no new tab created |
| `click` | Click an element by CSS selector |
| `type_text` | Type into an input field by CSS selector |
| `get_text` | Get the text content of an element |
| `evaluate_script` | Execute arbitrary JavaScript in the page |
| `get_screenshot` | Capture a PNG screenshot of the current page |
| `get_interactive_elements` | List all interactive elements with selectors and bounding boxes |
| `clear_overlays` | Remove all visual overlay boxes from the page |

## Quick start (3 steps)

**Step 1** — Start the MCP server:
```bash
npx domagent
```
You should see:
```
DOMAgent Bridge running on ws://127.0.0.1:18792/extension
```

**Step 2** — Load the browser extension:
- Chrome: `chrome://extensions` → Developer mode → Load unpacked → select `domagent-extension/chrome/`
- Firefox: `about:debugging` → Load Temporary Add-on → select `domagent-extension/firefox/manifest.json`

**Step 3** — Add to your AI agent config (see above) and start chatting.

## Configuration

By default the server binds to `127.0.0.1:18792`. To change this, edit the host/port/path in the browser extension's Options page (right-click the extension icon → Options).

The server accepts one WebSocket connection at a time — the browser extension.

## Source

Full source, browser extensions, and documentation:  
https://github.com/vaishnavucv/domagent
