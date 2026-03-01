# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x (current) | Yes |

---

## Scope

DOMAgent consists of two components. Security reports are accepted for both:

- **Browser extension** (`domagent-extension/chrome/` and `domagent-extension/firefox/`) — the extension that runs inside your browser
- **MCP server** (`domagent-mcp/`) — the local Node.js server that bridges AI agents to the browser

---

## Security Model

Understanding DOMAgent's threat model helps you make an informed report:

### By design (not vulnerabilities)

- **The MCP server binds only to `127.0.0.1`** — it is a local-only server, not exposed to the network
- **The extension communicates only with `127.0.0.1:18792`** — no external network calls are made
- **Full browser access is intentional** — the extension attaches the debugger to browser tabs; this is the core feature and requires an explicit user action (loading the extension)
- **Arbitrary JavaScript execution (`evaluate_script`) is intentional** — this is an MCP tool exposed to AI agents; the user must configure and trust the agent

### What we do consider vulnerabilities

- A remote origin (non-`127.0.0.1`) being able to send commands to the MCP server or extension
- The extension leaking tab contents, cookies, or credentials to any external host
- A malicious web page being able to communicate with the extension background script without user intent
- A path or prototype pollution issue in the MCP server that allows arbitrary code execution outside the intended scope
- The WebSocket endpoint accepting connections from untrusted origins
- Insecure defaults in the options page that expose the server beyond localhost

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues privately so we can prepare a fix before public disclosure.

### How to report

**GitHub private vulnerability reporting (preferred):**

1. Go to the repository on GitHub
2. Click the **Security** tab
3. Click **"Report a vulnerability"**
4. Fill in the details and submit

**Email (alternative):**

Send a report to the repository owner via the email address on their GitHub profile.

### What to include

A good report includes:

- A clear description of the vulnerability
- Which component is affected (MCP server, Chrome extension, or Firefox extension)
- Steps to reproduce the issue
- The potential impact (what an attacker could do)
- Your suggested fix, if you have one (optional but appreciated)

---

## Response Timeline

| Stage | Target time |
|-------|------------|
| Initial acknowledgement | Within 3 business days |
| Confirmation of vulnerability | Within 7 business days |
| Fix or mitigation available | Within 30 days for critical issues |
| Public disclosure | After a fix is released and users have time to update |

---

## Disclosure Policy

We follow **coordinated disclosure**:

1. Reporter notifies us privately
2. We confirm, investigate, and develop a fix
3. We release the fix
4. We publicly acknowledge the reporter (unless they prefer anonymity)
5. Reporter may publish their research after the fix is released

---

## Out of Scope

The following are not considered security vulnerabilities for this project:

- Issues that require the attacker to have already installed a malicious extension in the same browser
- Issues that require physical access to the machine
- Self-XSS (a user injecting JavaScript into their own browser via the `evaluate_script` tool is the intended use)
- Vulnerabilities in third-party dependencies — please report those upstream; we will update our dependencies in response
- Missing security headers on the local HTTP server (`127.0.0.1`) — it is local-only by design

---

## Acknowledgements

We appreciate the work of security researchers who help keep this project safe. Confirmed vulnerability reporters will be credited in the release notes unless they prefer to remain anonymous.
