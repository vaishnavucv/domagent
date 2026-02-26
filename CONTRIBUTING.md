# Contributing to DOMAgent

Thank you for taking the time to contribute. This document covers how to report bugs, suggest features, and submit code changes.

---

## Table of Contents

- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Commit Message Guidelines](#commit-message-guidelines)
- [Code Style](#code-style)
- [Testing Your Changes](#testing-your-changes)

---

## Project Structure

```
chrome-extension/
├── domagent-extension/
│   ├── chrome/          <- Chrome extension (MV3, chrome.debugger API)
│   └── firefox/         <- Firefox extension (MV3, content script relay)
└── domagent-mcp/        <- Node.js MCP server (WebSocket bridge)
```

Each component is independent. Changes to `domagent-mcp/` affect both browsers. Changes to `chrome/` or `firefox/` only affect that browser.

---

## Getting Started

### Prerequisites

- Node.js 18 or newer
- Chrome 88+ or Firefox 109+ (for testing)
- A git client

### Local setup

```bash
git clone git@github.com:vaishnavucv/domagent.git
cd domagent

# Install MCP server dependencies
cd domagent-mcp
npm install
npm start
```

Then load the extension for the browser you want to work on:

- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → select `domagent-extension/chrome/`
- **Firefox:** `about:debugging` → Load Temporary Add-on → select `domagent-extension/firefox/manifest.json`

See the browser-specific READMEs for full setup instructions:
- [Chrome README](domagent-extension/chrome/README.md)
- [Firefox README](domagent-extension/firefox/README.md)

---

## Reporting Bugs

Before opening an issue, please:

1. Check that the MCP server is running (`npm start` in `domagent-mcp/`)
2. Check the browser extension console for errors (DevTools → Service Worker for Chrome, `about:debugging` → Inspect for Firefox)
3. Search existing issues to see if the bug has already been reported

### Opening a bug report

Open a GitHub issue and include:

- **Which component:** MCP server, Chrome extension, or Firefox extension
- **Browser and version** (e.g. Chrome 122, Firefox 123)
- **OS** (macOS, Windows, Linux)
- **Steps to reproduce** — be as specific as possible
- **Expected behaviour** — what you expected to happen
- **Actual behaviour** — what actually happened
- **Console output or error messages** — paste the full text, not a screenshot
- **Extension version** (shown on `chrome://extensions` or `about:addons`)

---

## Suggesting Features

Open a GitHub issue with the label `enhancement` and describe:

- The problem you are trying to solve
- The solution you have in mind
- Any alternative approaches you considered

Feature requests for **new MCP tools** should include:
- The tool name and description
- Input parameters
- Expected output
- Which browser(s) it should work on

---

## Submitting a Pull Request

### Before you start

For non-trivial changes, open an issue first to discuss the approach. This prevents wasted effort if the direction does not fit the project goals.

### Workflow

1. **Fork** the repository and clone your fork:

   ```bash
   git clone git@github.com:YOUR_USERNAME/domagent.git
   cd domagent
   ```

2. **Create a branch** from `main` with a descriptive name:

   ```bash
   git checkout -b fix/content-script-timeout
   # or
   git checkout -b feature/new-scroll-tool
   ```

3. **Make your changes.** Keep each commit focused on one thing (see commit guidelines below).

4. **Test your changes** (see [Testing Your Changes](#testing-your-changes)).

5. **Push your branch** and open a pull request against `main`:

   ```bash
   git push origin fix/content-script-timeout
   ```

6. In the pull request description, include:
   - What the change does and why
   - Which browser(s) it affects
   - How you tested it
   - Any screenshots or console output showing the fix/feature working

### Pull request checklist

- [ ] Changes work in the target browser(s)
- [ ] MCP server starts without errors after the change
- [ ] Extension loads without errors in the browser console
- [ ] Commit messages follow the guidelines below
- [ ] No `console.log` debug statements left in production code (use `console.error` for intentional logs, consistent with existing code)

---

## Commit Message Guidelines

Keep commit messages short, clear, and in plain English. No emoji. No periods at the end.

### Format

```
<type>: <short description>
```

### Types

| Type | When to use |
|------|-------------|
| `add` | Adding a new file or feature |
| `fix` | Fixing a bug |
| `update` | Updating existing code or content |
| `remove` | Removing code or files |
| `refactor` | Code restructuring with no behaviour change |
| `docs` | Documentation changes only |

### Examples

```
add scroll tool to MCP server and both extensions
fix content script timeout on slow-loading pages
update Firefox manifest to allow all_urls host permission
remove unused debug logging from background.js
docs: add Firefox installation guide to README
refactor: simplify tab resolution logic in Chrome background script
```

### What to avoid

- Vague messages: `fix bug`, `update stuff`, `changes`
- Emoji in commit messages
- Very long subject lines (keep under 72 characters)

---

## Code Style

There is no automated linter configured yet. Follow the patterns already present in the file you are editing.

### General rules

- **Indentation:** 2 spaces (no tabs)
- **Quotes:** Single quotes for strings in JavaScript
- **Semicolons:** None (the existing codebase omits them)
- **Comments:** Use plain English; comment the *why*, not the *what*
- **Error handling:** Swallow errors silently only when explicitly safe to do so; always leave a comment explaining why

### Extension-specific

- **Chrome `background.js`** — this is a MV3 service worker; avoid state that does not survive service-worker suspension without being saved to `chrome.storage.session`
- **Firefox `background.js`** — persistent background script; no service-worker restrictions, but use the `api` shim (`const api = typeof browser !== 'undefined' ? browser : chrome`) for all API calls
- **`content.js`** — runs in page context; do not assume access to extension APIs; use `window.postMessage` or the background script message channel for anything that needs extension privileges

### MCP server (`domagent-mcp/`)

- Keep `server.js` focused on the WebSocket bridge and CDP relay
- Keep `index.js` focused on MCP tool registration and schema
- New MCP tools go in `index.js`; the underlying browser command implementation goes in `server.js`

---

## Testing Your Changes

There is no automated test suite currently. Test manually using the following steps:

### MCP server

```bash
cd domagent-mcp && npm start
```

Confirm it prints:
```
DOMAgent Bridge running on ws://127.0.0.1:18792/extension
```

### Chrome extension

1. Load unpacked from `domagent-extension/chrome/`
2. Open `chrome://extensions` → confirm no errors on the extension card
3. Open the Service Worker console: click "Service worker" link on the extension card
4. Open any `https://` page — badge should show `ON`
5. Confirm the MCP server logs: `Extension connected`

### Firefox extension

1. Load from `about:debugging` → select `domagent-extension/firefox/manifest.json`
2. Click **Inspect** on the extension to open its console
3. Open any `https://` page — badge should show `ON`
4. Confirm the MCP server logs: `Extension connected`

### End-to-end

Configure an MCP client (Claude Desktop, etc.) to use:

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

Then test each MCP tool (`navigate`, `click`, `type_text`, `get_screenshot`, etc.) to confirm your changes do not break existing behaviour.

---

## Questions

If you are unsure about anything, open a GitHub issue and ask. There is no such thing as a dumb question.
