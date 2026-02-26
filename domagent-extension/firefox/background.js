/* ─── Firefox DOMAgent Background Script ────────────────────────────
 *
 * Firefox does NOT support the chrome.debugger API.
 * Instead, this extension uses a content script relay:
 *   1. background.js connects to the local MCP bridge via WebSocket
 *   2. Commands are forwarded to the active tab's content script
 *   3. content.js executes them in the page context and returns results
 *
 * The MCP bridge (domagent-mcp) speaks the same protocol on both sides —
 * only the tab-side execution mechanism differs from Chrome.
 * ─────────────────────────────────────────────────────────────────── */

/* ─── Constants ──────────────────────────────────────────────────── */

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 18792
const DEFAULT_PATH = '/extension'

const AUTOMATION_TAB_KEY = '__daAutomationTab'

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

/* ─── State ──────────────────────────────────────────────────────── */

let relayWs = null
let relayConnectPromise = null
let nextSession = 1

const tabs = new Map()        // tabId → { state, sessionId, targetId, attachOrder }
const tabBySession = new Map() // sessionId → tabId
const pending = new Map()     // msgId → { resolve, reject }
const manuallyDetached = new Set()
const pendingAutomationSetup = new Set()

let automationTab = null      // { tabId, sessionId, targetId }

/* ─── browser.* compat shim ───────────────────────────────────────
 * Firefox exposes `browser.*` (Promises). Chrome-forked code uses
 * `chrome.*` (callbacks). We alias browser → chrome so the shared
 * logic below works unchanged.
 */
const api = typeof browser !== 'undefined' ? browser : chrome

/* ─── Automation tab persistence ─────────────────────────────────── */

async function persistAutomationTab() {
  try {
    if (automationTab) {
      await api.storage.session.set({ [AUTOMATION_TAB_KEY]: { tabId: automationTab.tabId } })
    } else {
      await api.storage.session.remove(AUTOMATION_TAB_KEY)
    }
  } catch { /* session storage may not exist in older Firefox */ }
}

async function restoreAutomationTab() {
  if (automationTab) return
  try {
    const stored = await api.storage.session.get(AUTOMATION_TAB_KEY)
    const saved = stored?.[AUTOMATION_TAB_KEY]
    if (!saved?.tabId) return

    const tab = await api.tabs.get(saved.tabId).catch(() => null)
    if (!tab) { await api.storage.session.remove(AUTOMATION_TAB_KEY).catch(() => { }); return }

    const attached = await attachTab(saved.tabId, { skipAttachedEvent: true }).catch(() => null)
    if (!attached) { await api.storage.session.remove(AUTOMATION_TAB_KEY).catch(() => { }); return }

    automationTab = { tabId: saved.tabId, sessionId: attached.sessionId, targetId: attached.targetId }
  } catch { /* ignore */ }
}

/* ─── Settings ───────────────────────────────────────────────────── */

async function getRelaySettings() {
  const stored = await api.storage.local.get(['host', 'port', 'path'])
  let port = Number.parseInt(String(stored.port || ''), 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) port = DEFAULT_PORT
  return {
    host: stored.host || DEFAULT_HOST,
    port,
    path: stored.path || DEFAULT_PATH,
  }
}

/* ─── Badge helpers ──────────────────────────────────────────────── */

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void api.action.setBadgeText({ tabId, text: cfg.text }).catch(() => { })
  void api.action.setBadgeBackgroundColor({ tabId, color: cfg.color }).catch(() => { })
  void api.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => { })
}

/* ─── WebSocket relay (to MCP server) ───────────────────────────── */

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const settings = await getRelaySettings()
    const httpBase = `http://${settings.host}:${settings.port}`
    const wsUrl = `ws://${settings.host}:${settings.port}${settings.path}`

    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      throw new Error(`Bridge server not reachable at ${httpBase} (${String(err)})`)
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = () => { clearTimeout(t); reject(new Error('WebSocket connect failed')) }
      ws.onclose = (ev) => { clearTimeout(t); reject(new Error(`WebSocket closed (${ev.code})`)) }
    })

    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
    ws.onclose = () => onRelayClosed('closed')
    ws.onerror = () => onRelayClosed('error')
  })()

  try {
    await relayConnectPromise
  } finally {
    relayConnectPromise = null
  }
}

function onRelayClosed(reason) {
  relayWs = null

  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Bridge disconnected (${reason})`))
  }

  for (const tabId of tabs.keys()) {
    setBadge(tabId, 'connecting')
    void api.action.setTitle({ tabId, title: 'DOMAgent: disconnected (start your local bridge server)' }).catch(() => { })
  }

  tabs.clear()
  tabBySession.clear()
  pendingAutomationSetup.clear()
  automationTab = null
}

function sendToRelay(payload) {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) throw new Error('Bridge not connected')
  relayWs.send(JSON.stringify(payload))
}

/* ─── Relay message handling ─────────────────────────────────────── */

async function onRelayMessage(text) {
  let msg
  try { msg = JSON.parse(text) } catch { return }

  if (msg?.method === 'ping') {
    try { sendToRelay({ method: 'pong' }) } catch { /* ignore */ }
    return
  }

  if (typeof msg?.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(String(msg.error))) : p.resolve(msg.result)
    return
  }

  if (typeof msg?.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/* ─── One-time help page ─────────────────────────────────────────── */

async function maybeOpenHelpOnce() {
  try {
    const stored = await api.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await api.storage.local.set({ helpOnErrorShown: true })
    await api.runtime.openOptionsPage()
  } catch { /* ignore */ }
}

/* ─── Tab helpers ────────────────────────────────────────────────── */

function getTabBySessionId(sessionId) {
  const tabId = tabBySession.get(sessionId)
  return tabId != null ? tabId : null
}

function isTabEligible(tab) {
  if (!tab?.url || !tab?.id) return false
  const url = tab.url.toLowerCase()
  return url.startsWith('http://') || url.startsWith('https://') ||
    url.startsWith('file://') || url.startsWith('about:blank')
}

/* ─── Tab attach / detach ────────────────────────────────────────── */

async function attachTab(tabId, opts = {}) {
  const existing = tabs.get(tabId)
  if (existing?.state === 'connected' && existing.sessionId && existing.targetId) {
    return { sessionId: existing.sessionId, targetId: existing.targetId }
  }

  // Firefox: no debugger API. We use content script as proxy.
  // Generate a synthetic targetId from the tab URL.
  const tab = await api.tabs.get(tabId).catch(() => null)
  if (!tab) throw new Error(`Tab ${tabId} not found`)

  const prevState = tabs.get(tabId)
  const sessionId = prevState?.sessionId || `da-tab-${nextSession++}`
  const targetId = `da-target-${tabId}`
  const attachOrder = nextSession

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)

  void api.action.setTitle({ tabId, title: 'DOMAgent: active (click to disable for this tab)' }).catch(() => { })

  if (!opts.skipAttachedEvent) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId,
            targetInfo: { targetId, type: 'page', url: tab.url || '', attached: true },
            waitingForDebugger: false,
          },
        },
      })
    } catch { /* not yet connected — ignore */ }
  }

  setBadge(tabId, 'on')
  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)

  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch { /* ignore */ }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  if (automationTab?.tabId === tabId) {
    automationTab = null
    void persistAutomationTab()
  }

  setBadge(tabId, 'off')
  void api.action.setTitle({ tabId, title: 'DOMAgent (ON by default — click to disable for this tab)' }).catch(() => { })
}

/* ─── Auto attach ────────────────────────────────────────────────── */

async function autoAttachTab(tabId) {
  if (pendingAutomationSetup.has(tabId)) return
  if (manuallyDetached.has(tabId)) return
  const tab = await api.tabs.get(tabId).catch(() => null)
  if (!isTabEligible(tab)) return
  if (tabs.get(tabId)?.state === 'connected') return

  try {
    await ensureRelayConnection().catch(() => { })
    if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return
    await attachTab(tabId)
  } catch { /* ignore */ }
}

/* ─── Toolbar toggle ─────────────────────────────────────────────── */

async function connectOrToggleForActiveTab() {
  const [active] = await api.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  if (tabs.get(tabId)?.state === 'connected') {
    manuallyDetached.add(tabId)
    await detachTab(tabId, 'toggle')
    return
  }

  manuallyDetached.delete(tabId)
  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')

  try {
    await ensureRelayConnection()
    await attachTab(tabId)
  } catch {
    tabs.delete(tabId)
    setBadge(tabId, 'error')
    void api.action.setTitle({ tabId, title: 'DOMAgent: bridge not running (check your local server)' }).catch(() => { })
    void maybeOpenHelpOnce()
  }
}

/* ─── Tab resolution ─────────────────────────────────────────────── */

function resolveTabForCommand(sessionId) {
  if (sessionId) {
    const bySession = getTabBySessionId(sessionId)
    if (bySession != null) return bySession
  }

  if (automationTab) {
    const state = tabs.get(automationTab.tabId)
    if (state?.state === 'connected') return automationTab.tabId
    automationTab = null
  }

  let best = null, bestOrder = -1
  for (const [id, tab] of tabs.entries()) {
    if (tab.state === 'connected' && (tab.attachOrder || 0) > bestOrder) {
      best = id; bestOrder = tab.attachOrder || 0
    }
  }
  return best
}

/* ─── Wait for tab load ──────────────────────────────────────────── */

function waitForTabLoad(tabId, maxMs = 10000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { api.tabs.onUpdated.removeListener(listener); resolve() }, maxMs)
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout); api.tabs.onUpdated.removeListener(listener); resolve()
      }
    }
    api.tabs.onUpdated.addListener(listener)
  })
}

/* ─── Automation tab management ──────────────────────────────────── */

async function ensureAutomationTab(url) {
  if (!automationTab) await restoreAutomationTab()

  if (automationTab) {
    const existingTab = await api.tabs.get(automationTab.tabId).catch(() => null)
    const existingState = tabs.get(automationTab.tabId)

    if (existingTab && existingState?.state === 'connected') {
      await api.tabs.update(automationTab.tabId, { url, active: true })
      if (existingTab.windowId) await api.windows.update(existingTab.windowId, { focused: true }).catch(() => { })
      await waitForTabLoad(automationTab.tabId)

      const refreshed = tabs.get(automationTab.tabId)
      automationTab.sessionId = refreshed?.sessionId || automationTab.sessionId
      automationTab.targetId = refreshed?.targetId || automationTab.targetId
      void persistAutomationTab()
      return { tabId: automationTab.tabId, targetId: automationTab.targetId, sessionId: automationTab.sessionId }
    }
    automationTab = null
    void persistAutomationTab()
  }

  const tab = await api.tabs.create({ url, active: true })
  if (!tab.id) throw new Error('Failed to create tab')

  pendingAutomationSetup.add(tab.id)
  try {
    await waitForTabLoad(tab.id)
    const attached = await attachTab(tab.id)
    automationTab = { tabId: tab.id, sessionId: attached.sessionId, targetId: attached.targetId }
    void persistAutomationTab()
    return { tabId: tab.id, targetId: attached.targetId, sessionId: attached.sessionId }
  } finally {
    pendingAutomationSetup.delete(tab.id)
  }
}

async function adoptCurrentTabAsAutomation() {
  const [active] = await api.tabs.query({ active: true, currentWindow: true })
  if (!active?.id) throw new Error('No active tab found')

  const tabId = active.id
  const attached = await attachTab(tabId)

  automationTab = { tabId, sessionId: attached.sessionId, targetId: attached.targetId }
  void persistAutomationTab()

  return { tabId, targetId: attached.targetId, sessionId: attached.sessionId, url: active.url || '', title: active.title || '' }
}

/* ─── Content script relay ───────────────────────────────────────── */

/**
 * Send a command to the content script in the given tab and await response.
 * The content script (content.js) executes the action in page context and
 * returns the result or throws an error.
 */
async function sendToContentScript(tabId, command) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Content script timeout for: ${command.method}`)), 15000)
    api.tabs.sendMessage(tabId, command, (response) => {
      clearTimeout(timeout)
      if (api.runtime.lastError) {
        reject(new Error(`Content script error: ${api.runtime.lastError.message}`))
        return
      }
      if (response?.error) reject(new Error(response.error))
      else resolve(response?.result)
    })
  })
}

/* ─── Command handler ────────────────────────────────────────────── */

async function handleCommand(msg) {
  if (!automationTab) await restoreAutomationTab()

  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  const tabId = resolveTabForCommand(sessionId)

  /* ── Special commands ── */

  if (method === 'Browser.ensureTab') {
    const url = typeof params?.url === 'string' ? params.url : ''
    if (!url) throw new Error('URL required')
    const result = await ensureAutomationTab(url)
    return { targetId: result.targetId, sessionId: result.sessionId }
  }

  if (method === 'Browser.useCurrentTab') {
    const result = await adoptCurrentTabAsAutomation()
    return { targetId: result.targetId, sessionId: result.sessionId, url: result.url, title: result.title }
  }

  if (method === 'Browser.getOverlaySettings') {
    const defaults = {
      overlayClickEnabled: true, overlayClickOpacity: 75,
      overlayTypeEnabled: true, overlayTypeOpacity: 75,
      overlayTextEnabled: true, overlayTextOpacity: 50,
    }
    return await api.storage.local.get(defaults)
  }

  /* ── Tab-targeted commands — relay via content script ── */

  if (!tabId) throw new Error(`No attached tab for method: ${method}`)

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await api.tabs.create({ url, active: true })
    if (!tab.id) throw new Error('Failed to create tab')
    await waitForTabLoad(tab.id)
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    try { await api.tabs.remove(tabId) } catch { return { success: false } }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const tab = await api.tabs.get(tabId).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) await api.windows.update(tab.windowId, { focused: true }).catch(() => { })
    await api.tabs.update(tabId, { active: true }).catch(() => { })
    return {}
  }

  /* ── Runtime.evaluate, Page.captureScreenshot, etc. → content script ── */
  return await sendToContentScript(tabId, { method, params })
}

/* ─── Event listeners ────────────────────────────────────────────── */

api.action.onClicked.addListener(() => void connectOrToggleForActiveTab())

api.tabs.onCreated.addListener((tab) => {
  if (tab.id) void autoAttachTab(tab.id)
})

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') void autoAttachTab(tabId)
})

api.tabs.onRemoved.addListener((tabId) => {
  if (tabs.has(tabId)) void detachTab(tabId, 'tab_closed')
})

api.runtime.onInstalled.addListener(() => {
  void api.runtime.openOptionsPage()
})

/* ─── Startup scan & periodic retry ─────────────────────────────── */

void (async () => {
  await new Promise((r) => setTimeout(r, 1000))
  const scan = async () => {
    const allTabs = await api.tabs.query({})
    for (const t of allTabs) {
      if (t.id) void autoAttachTab(t.id)
    }
  }
  void scan()
  setInterval(scan, 10000)
})()
