/* ─── Constants ─────────────────────────────────────────────────── */

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 18792
const DEFAULT_PATH = '/extension'

/**
 * Storage key for persisting automationTab across service-worker restarts.
 * Uses chrome.storage.session (survives SW suspension, cleared on browser quit).
 */
const AUTOMATION_TAB_KEY = '__daAutomationTab'

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '...', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

/* ─── State ─────────────────────────────────────────────────────── */

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null

let debuggerListenersInstalled = false
let nextSession = 1

/**
 * Connected tab state.
 * @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>}
 */
const tabs = new Map()

/** sessionId → tabId (for our custom cb-tab-* sessions) */
const tabBySession = new Map()

/** Child session IDs (from Target.attachedToTarget events) → parent tabId */
const childSessionToTab = new Map()

/** Pending request/response promises keyed by message id */
const pending = new Map()

/** Tabs the user has manually toggled OFF via the toolbar icon */
const manuallyDetached = new Set()

/**
 * Tab IDs currently being set up by ensureAutomationTab.
 * autoAttachTab must skip these to avoid the attach race condition.
 * @type {Set<number>}
 */
const pendingAutomationSetup = new Set()

/**
 * THE dedicated automation tab.
 * All MCP commands target this tab. Only ONE automation tab exists at a time.
 * - navigate() → reuses this tab (or creates it if missing).
 * - useCurrentTab() → adopts the user's active tab as this tab.
 * @type {{tabId: number, sessionId: string, targetId: string}|null}
 */
let automationTab = null

/* ─── Automation tab persistence (survives service-worker suspension) ── */

/**
 * Save automationTab.tabId to chrome.storage.session so that if the
 * Manifest V3 service worker is suspended and later restarted, we can
 * recover the same tab instead of opening a duplicate.
 */
async function persistAutomationTab() {
  try {
    if (automationTab) {
      await chrome.storage.session.set({
        [AUTOMATION_TAB_KEY]: { tabId: automationTab.tabId },
      })
    } else {
      await chrome.storage.session.remove(AUTOMATION_TAB_KEY)
    }
  } catch { /* ignore – storage unavailable */ }
}

/**
 * Restore automationTab from chrome.storage.session after a service-worker
 * restart.  Re-attaches the debugger (idempotent) and rebuilds the in-memory
 * automationTab / tabs / tabBySession state.
 *
 * Safe to call multiple times – returns immediately if automationTab is
 * already populated.
 */
async function restoreAutomationTab() {
  if (automationTab) return  // already set

  try {
    const stored = await chrome.storage.session.get(AUTOMATION_TAB_KEY)
    const saved = stored?.[AUTOMATION_TAB_KEY]
    if (!saved?.tabId) return

    // Verify the tab still exists in the browser
    const tab = await chrome.tabs.get(saved.tabId).catch(() => null)
    if (!tab) {
      await chrome.storage.session.remove(AUTOMATION_TAB_KEY).catch(() => { })
      return
    }

    // Re-attach debugger (idempotent – handles "already attached")
    const attached = await attachTab(saved.tabId, { skipAttachedEvent: true }).catch(() => null)
    if (!attached) {
      await chrome.storage.session.remove(AUTOMATION_TAB_KEY).catch(() => { })
      return
    }

    automationTab = {
      tabId: saved.tabId,
      sessionId: attached.sessionId,
      targetId: attached.targetId,
    }
  } catch { /* ignore */ }
}

/* ─── Settings ──────────────────────────────────────────────────── */

async function getRelaySettings() {
  const stored = await chrome.storage.local.get(['host', 'port', 'path'])
  let port = Number.parseInt(String(stored.port || ''), 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) port = DEFAULT_PORT
  return {
    host: stored.host || DEFAULT_HOST,
    port,
    path: stored.path || DEFAULT_PATH,
  }
}

/* ─── Badge helpers ─────────────────────────────────────────────── */

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text }).catch(() => { })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color }).catch(() => { })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => { })
}

/* ─── WebSocket relay (to MCP server) ───────────────────────────── */

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const settings = await getRelaySettings()
    const httpBase = `http://${settings.host}:${settings.port}`
    const wsUrl = `ws://${settings.host}:${settings.port}${settings.path}`

    // Preflight check
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
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
    ws.onclose = () => onRelayClosed('closed')
    ws.onerror = () => onRelayClosed('error')

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }
  })()

  try {
    await relayConnectPromise
  } finally {
    relayConnectPromise = null
  }
}

function onRelayClosed(reason) {
  relayWs = null

  // Reject all pending requests
  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Bridge disconnected (${reason})`))
  }

  // Detach all tabs
  for (const tabId of tabs.keys()) {
    void chrome.debugger.detach({ tabId }).catch(() => { })
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'DOMAgent: disconnected (start your local bridge server)',
    }).catch(() => { })
  }

  tabs.clear()
  tabBySession.clear()
  childSessionToTab.clear()
  pendingAutomationSetup.clear()
  automationTab = null
  // NOTE: Do NOT clear storage here. The tab still exists in the browser.
  // When the relay reconnects, restoreAutomationTab() will recover it.
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Bridge not connected')
  }
  ws.send(JSON.stringify(payload))
}

/* ─── Relay message handling ────────────────────────────────────── */

async function onRelayMessage(text) {
  let msg
  try { msg = JSON.parse(text) } catch { return }

  // Ping/pong keepalive
  if (msg?.method === 'ping') {
    try { sendToRelay({ method: 'pong' }) } catch { /* ignore */ }
    return
  }

  // Response to a command we sent
  if (typeof msg?.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  // CDP command forwarded from the MCP server
  if (typeof msg?.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/* ─── One-time help page ────────────────────────────────────────── */

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch { /* ignore */ }
}

/* ─── Tab / session lookup helpers ──────────────────────────────── */

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

/* ─── Debugger attach / detach ──────────────────────────────────── */

/**
 * Attach the debugger to a tab.
 * IDEMPOTENT: if the tab is already attached and connected, returns the
 * existing session info instead of throwing.
 */
async function attachTab(tabId, opts = {}) {
  // ── Idempotent check: already connected? Just return existing info ──
  const existing = tabs.get(tabId)
  if (existing?.state === 'connected' && existing.sessionId && existing.targetId) {
    return { sessionId: existing.sessionId, targetId: existing.targetId }
  }

  const debuggee = { tabId }

  // Try to attach; if already attached (by autoAttachTab race), catch and continue
  try {
    await chrome.debugger.attach(debuggee, '1.3')
  } catch (err) {
    // If it's already attached, that's fine, so just proceed to get target info
    const msg = String(err?.message || err || '')
    if (!msg.includes('already') && !msg.includes('Another debugger')) {
      throw err // genuinely unexpected error
    }
  }

  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => { })

  const info = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo')
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) throw new Error('Target.getTargetInfo returned no targetId')

  // If already in tabs map with a session, reuse it; otherwise create a new one
  const prevState = tabs.get(tabId)
  const sessionId = (prevState?.sessionId) || `cb-tab-${nextSession++}`
  const attachOrder = nextSession

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)

  void chrome.action.setTitle({
    tabId,
    title: 'DOMAgent: active (click to disable for this tab)',
  }).catch(() => { })

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    })
  }

  setBadge(tabId, 'on')
  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)

  // Notify relay of detach
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

  // Clean up maps
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  if (automationTab?.tabId === tabId) {
    automationTab = null
    void persistAutomationTab()  // clear persisted reference
  }

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  // Actually detach the debugger
  try { await chrome.debugger.detach({ tabId }) } catch { /* ignore */ }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'DOMAgent (ON by default: click to disable for this tab)',
  }).catch(() => { })
}

/* ─── Tab eligibility & auto-attach ─────────────────────────────── */

function isTabEligible(tab) {
  if (!tab?.url || !tab?.id) return false
  const url = tab.url.toLowerCase()
  return (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('file://') ||
    url.startsWith('about:blank')
  )
}

async function autoAttachTab(tabId) {
  // Skip tabs that ensureAutomationTab is currently setting up
  if (pendingAutomationSetup.has(tabId)) return

  if (manuallyDetached.has(tabId)) return
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!isTabEligible(tab)) return
  if (tabs.get(tabId)?.state === 'connected') return

  try {
    await ensureRelayConnection().catch(() => { })
    if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return
    await attachTab(tabId)
  } catch { /* ignore auto-attach failures */ }
}

/* ─── Toolbar icon toggle ───────────────────────────────────────── */

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
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
    void chrome.action.setTitle({
      tabId,
      title: 'DOMAgent: bridge not running (check your local server)',
    }).catch(() => { })
    void maybeOpenHelpOnce()
  }
}

/* ─── Tab resolution for CDP commands ───────────────────────────── */

/**
 * Resolve the correct tabId for an incoming CDP command.
 * Priority: sessionId → targetId → automationTab → most-recently-attached.
 */
function resolveTabForCommand(sessionId, targetId) {
  if (sessionId) {
    const bySession = getTabBySessionId(sessionId)
    if (bySession) return bySession.tabId
  }

  if (targetId) {
    const byTarget = getTabByTargetId(targetId)
    if (byTarget) return byTarget
  }

  if (automationTab) {
    const state = tabs.get(automationTab.tabId)
    if (state?.state === 'connected') return automationTab.tabId
    automationTab = null // stale
  }

  // Last resort: most recently attached
  let best = null
  let bestOrder = -1
  for (const [id, tab] of tabs.entries()) {
    if (tab.state === 'connected' && (tab.attachOrder || 0) > bestOrder) {
      best = id
      bestOrder = tab.attachOrder || 0
    }
  }
  return best
}

/* ─── Automation tab management ─────────────────────────────────── */

/**
 * Wait for a tab to finish loading (or timeout after maxMs).
 */
function waitForTabLoad(tabId, maxMs = 10000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }, maxMs)

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

/**
 * Ensure an automation tab exists and is navigated to the given URL.
 *
 * Logic:
 *  1. Recover automationTab from storage if SW was restarted.
 *  2. If automationTab exists and alive → reuse it (navigate to URL).
 *  3. Otherwise → create a NEW dedicated tab (NEVER take over user's tabs).
 *
 * The user's existing tabs are NEVER adopted. If the user explicitly wants
 * to use their current tab, they call `use_current_tab` via the MCP tool.
 *
 * Uses pendingAutomationSetup to prevent autoAttachTab race conditions.
 */
async function ensureAutomationTab(url) {
  // ── Recover from service-worker restart ──
  if (!automationTab) {
    await restoreAutomationTab()
  }

  // Try to reuse the current automation tab
  if (automationTab) {
    const existingTab = await chrome.tabs.get(automationTab.tabId).catch(() => null)
    const existingState = tabs.get(automationTab.tabId)

    if (existingTab && existingState?.state === 'connected') {
      // Reuse: navigate the existing tab
      await chrome.tabs.update(automationTab.tabId, { url, active: true })
      if (existingTab.windowId) {
        await chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => { })
      }
      await waitForTabLoad(automationTab.tabId)

      // Re-read state (session might be the same, targetId might change)
      const refreshedState = tabs.get(automationTab.tabId)
      automationTab.sessionId = refreshedState?.sessionId || automationTab.sessionId
      automationTab.targetId = refreshedState?.targetId || automationTab.targetId

      void persistAutomationTab()  // keep storage fresh
      return {
        tabId: automationTab.tabId,
        targetId: automationTab.targetId,
        sessionId: automationTab.sessionId,
      }
    }
    automationTab = null // dead
    void persistAutomationTab()
  }

  // ── Create a new dedicated automation tab ──
  // NEVER take over the user's existing tabs. The user's browsing session is sacred.
  // If the user explicitly wants to adopt their current tab, they use `use_current_tab`.
  const tab = await chrome.tabs.create({ url, active: true })
  if (!tab.id) throw new Error('Failed to create tab')

  // Guard: prevent autoAttachTab from racing us
  pendingAutomationSetup.add(tab.id)

  try {
    await waitForTabLoad(tab.id)
    const attached = await attachTab(tab.id)

    automationTab = {
      tabId: tab.id,
      sessionId: attached.sessionId,
      targetId: attached.targetId,
    }
    void persistAutomationTab()

    return {
      tabId: tab.id,
      targetId: attached.targetId,
      sessionId: attached.sessionId,
    }
  } finally {
    // Always remove the guard, even if attachTab throws
    pendingAutomationSetup.delete(tab.id)
  }
}

/**
 * Adopt the user's currently active tab as the automation tab.
 * No new tab is created.
 */
async function adoptCurrentTabAsAutomation() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!active?.id) throw new Error('No active tab found')

  const tabId = active.id
  const attached = await attachTab(tabId)

  automationTab = {
    tabId,
    sessionId: attached.sessionId,
    targetId: attached.targetId,
  }
  void persistAutomationTab()

  return {
    tabId,
    targetId: attached.targetId,
    sessionId: attached.sessionId,
    url: active.url || '',
    title: active.title || '',
  }
}

/* ─── CDP command handler ───────────────────────────────────────── */

async function handleForwardCdpCommand(msg) {
  // ── Recover automation tab if service worker was restarted ──
  if (!automationTab) {
    await restoreAutomationTab()
  }

  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined

  const tabId = resolveTabForCommand(sessionId, targetId)

  // ── Special commands (don't require pre-existing tab) ──

  if (method === 'Browser.ensureTab') {
    const url = typeof params?.url === 'string' ? params.url : ''
    if (!url) throw new Error('URL required')
    const result = await ensureAutomationTab(url)
    return { targetId: result.targetId, sessionId: result.sessionId }
  }

  if (method === 'Browser.useCurrentTab') {
    const result = await adoptCurrentTabAsAutomation()
    return {
      targetId: result.targetId,
      sessionId: result.sessionId,
      url: result.url,
      title: result.title,
    }
  }

  if (method === 'Browser.getOverlaySettings') {
    const defaults = {
      overlayClickEnabled: true,
      overlayClickOpacity: 75,
      overlayTypeEnabled: true,
      overlayTypeOpacity: 75,
      overlayTextEnabled: true,
      overlayTextOpacity: 50,
    }
    const stored = await chrome.storage.local.get(defaults)
    return stored
  }

  // ── Standard CDP commands (require a resolved tab) ──

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch { /* ignore */ }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: true })
    if (!tab.id) throw new Error('Failed to create tab')
    await waitForTabLoad(tab.id)
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try { await chrome.tabs.remove(toClose) } catch { return { success: false } }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => { })
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => { })
    return {}
  }

  // ── Pass-through to Chrome Debugger ──

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

/* ─── Debugger event forwarding ─────────────────────────────────── */

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }
  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch { /* ignore */ }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId || !tabs.has(tabId)) return
  void detachTab(tabId, reason)
}

/* ─── Event listeners ───────────────────────────────────────────── */

chrome.action.onClicked.addListener(() => void connectOrToggleForActiveTab())

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id) void autoAttachTab(tab.id)
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') void autoAttachTab(tabId)
})

chrome.runtime.onInstalled.addListener(() => {
  void chrome.runtime.openOptionsPage()
})

/* ─── Startup scan & periodic retry ─────────────────────────────── */

void (async () => {
  const scan = async () => {
    const allTabs = await chrome.tabs.query({})
    for (const t of allTabs) {
      if (t.id) void autoAttachTab(t.id)
    }
  }

  await new Promise((r) => setTimeout(r, 1000))
  void scan()
  setInterval(scan, 10000)
})()
