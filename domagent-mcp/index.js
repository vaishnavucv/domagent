#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BridgeServer } from './server.js';

/* ─── Initialize servers ────────────────────────────────────────── */

const bridgeServer = new BridgeServer();
bridgeServer.start().catch((err) => {
    console.error("Failed to start Bridge Server:", err);
    process.exit(1);
});

const server = new Server(
    { name: "domagent-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
);

/* ─── Tool definitions ──────────────────────────────────────────── */

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "navigate",
            description:
                "Navigate to a URL in the browser. Reuses the existing automation tab " +
                "if one already exists (no duplicate tabs). Only creates a new tab the " +
                "very first time. Use this for opening websites or changing pages.",
            inputSchema: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "Full URL to navigate to (e.g. https://example.com)",
                    },
                },
                required: ["url"],
            },
        },
        {
            name: "use_current_tab",
            description:
                "Adopt the user's currently active browser tab as the automation target. " +
                "Use this when the user asks you to look at, study, read, or interact " +
                "with a page they already have open. No new tab is created.",
            inputSchema: {
                type: "object",
                properties: {},
            },
        },
        {
            name: "click",
            description:
                "Click an element on the page using a CSS selector. " +
                "Shows a yellow pulsing highlight box around the element and an orange click dot.",
            inputSchema: {
                type: "object",
                properties: {
                    selector: {
                        type: "string",
                        description: "CSS selector of the element to click.",
                    },
                },
                required: ["selector"],
            },
        },
        {
            name: "type_text",
            description:
                "Type text into an input field identified by a CSS selector. " +
                "Shows a green pulsing highlight box around the element and a blue dot.",
            inputSchema: {
                type: "object",
                properties: {
                    selector: {
                        type: "string",
                        description: "CSS selector of the input field.",
                    },
                    text: {
                        type: "string",
                        description: "The text to type into the field.",
                    },
                },
                required: ["selector", "text"],
            },
        },
        {
            name: "get_text",
            description: "Get the visible text content of an element.",
            inputSchema: {
                type: "object",
                properties: {
                    selector: {
                        type: "string",
                        description: "CSS selector of the element.",
                    },
                },
                required: ["selector"],
            },
        },
        {
            name: "evaluate_script",
            description:
                "Execute arbitrary JavaScript in the page context and return the result.",
            inputSchema: {
                type: "object",
                properties: {
                    script: {
                        type: "string",
                        description: "JavaScript code to execute.",
                    },
                },
                required: ["script"],
            },
        },
        {
            name: "get_screenshot",
            description: "Capture a PNG screenshot of the current page (base64 encoded).",
            inputSchema: {
                type: "object",
                properties: {},
            },
        },
        {
            name: "get_interactive_elements",
            description:
                "Scan the page and return all interactive elements AND text content with CSS selectors, " +
                "text, and bounding boxes. Draws visual overlays: yellow dashed boxes for clickable elements, " +
                "green dashed boxes for typeable elements (each with index badge), and cyan thin solid boxes " +
                "(50% opacity) on all text content elements (p, h1-h6, span, li, etc.). Overlays auto-remove after 4s.",
            inputSchema: {
                type: "object",
                properties: {},
            },
        },
        {
            name: "clear_overlays",
            description:
                "Remove all visual overlay boxes from the page. Use this if overlays " +
                "are cluttering the view or before taking a clean screenshot.",
            inputSchema: {
                type: "object",
                properties: {},
            },
        },
    ],
}));

/* ─── Tool execution ────────────────────────────────────────────── */

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        let result;

        switch (name) {
            case "navigate":
                await bridgeServer.navigate(args.url);
                result = `Navigated to ${args.url}`;
                break;

            case "use_current_tab": {
                const info = await bridgeServer.useCurrentTab();
                result = `Using active tab — URL: ${info.url || "unknown"}, Title: ${info.title || "unknown"}`;
                break;
            }

            case "click":
                result = await bridgeServer.click(args.selector);
                break;

            case "type_text":
                result = await bridgeServer.type(args.selector, args.text);
                break;

            case "get_text":
                result = await bridgeServer.getText(args.selector);
                break;

            case "evaluate_script":
                result = await bridgeServer.evaluate(args.script);
                if (typeof result !== "string") result = JSON.stringify(result);
                break;

            case "get_screenshot": {
                const data = await bridgeServer.getScreenshot();
                return {
                    content: [{ type: "image", data, mimeType: "image/png" }],
                };
            }

            case "get_interactive_elements":
                result = await bridgeServer.getInteractiveElements();
                if (typeof result !== "string") result = JSON.stringify(result, null, 2);
                break;

            case "clear_overlays":
                result = await bridgeServer.clearOverlays();
                break;

            default:
                throw new Error(`Unknown tool: ${name}`);
        }

        return {
            content: [{ type: "text", text: String(result) }],
        };
    } catch (error) {
        return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
        };
    }
});

/* ─── Start ─────────────────────────────────────────────────────── */

const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});
