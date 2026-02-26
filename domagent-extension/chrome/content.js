/* ─── DOMAgent Firefox Content Script ───────────────────────────────
 *
 * Runs in every tab's isolated world. Receives command messages from
 * background.js via browser.tabs.sendMessage and executes them in the
 * page, returning results back to background.
 *
 * This replaces Chrome's chrome.debugger API for Firefox — all page
 * interactions (eval, screenshot, overlays) happen here directly.
 * ─────────────────────────────────────────────────────────────────── */

/* ─── browser compat shim ────────────────────────────────────────── */
const _api = typeof browser !== 'undefined' ? browser : chrome

/* ─── Overlay CSS ────────────────────────────────────────────────── */

const OVERLAY_CSS = `
.__da-scan-box {
  position: fixed !important;
  pointer-events: none !important;
  z-index: 2147483640 !important;
  border: 1.5px dashed !important;
  border-radius: 3px !important;
  box-sizing: border-box !important;
  transition: opacity 0.4s ease !important;
}
.__da-scan-box[data-kind="click"] {
  border-color: rgba(234, 179, 8, 0.75) !important;
  background: rgba(234, 179, 8, 0.04) !important;
}
.__da-scan-box[data-kind="type"] {
  border-color: rgba(34, 197, 94, 0.75) !important;
  background: rgba(34, 197, 94, 0.04) !important;
}
.__da-scan-box[data-kind="text"] {
  border: 1px solid rgba(0, 210, 255, 0.50) !important;
  background: rgba(0, 210, 255, 0.05) !important;
}
.__da-idx {
  position: absolute !important;
  top: -1px !important; left: -1px !important;
  background: rgba(255, 90, 54, 0.92) !important;
  color: #fff !important;
  font: bold 9px/1 system-ui, sans-serif !important;
  padding: 1px 4px 2px !important;
  border-radius: 0 0 4px 0 !important;
  pointer-events: none !important;
}
.__da-action-hl {
  position: fixed !important;
  pointer-events: none !important;
  z-index: 2147483645 !important;
  border-radius: 4px !important;
  box-sizing: border-box !important;
  animation: __da-pulse 0.5s ease-in-out 3 !important;
}
@keyframes __da-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
`

/* ─── Helpers ────────────────────────────────────────────────────── */

function escapeJS(str) {
    return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
}

function ensureOverlayStyles() {
    if (document.getElementById('__da-style')) return
    const s = document.createElement('style')
    s.id = '__da-style'
    s.textContent = OVERLAY_CSS
        ; (document.head || document.documentElement).appendChild(s)
}

function clearOverlays() {
    document.querySelectorAll('.__da-scan-box, .__da-action-hl, .__da-dot').forEach((el) => el.remove())
    return 'cleared'
}

/* ─── Page evaluation ────────────────────────────────────────────── */

function evaluate(expression) {
    try {
        // eslint-disable-next-line no-new-func
        const result = new Function(`return (${expression})`)()
        if (result instanceof Promise) {
            return result
                .then((v) => ({ value: typeof v === 'object' ? JSON.stringify(v) : String(v ?? '') }))
                .catch((e) => { throw new Error(String(e?.message || e)) })
        }
        return { value: typeof result === 'object' ? JSON.stringify(result) : String(result ?? '') }
    } catch (e) {
        throw new Error(String(e?.message || e))
    }
}

/* ─── Screenshot via canvas ──────────────────────────────────────── */

async function captureScreenshot() {
    // Firefox content scripts can draw a visible screenshot using the
    // html2canvas-less approach: clone the viewport into an offscreen canvas.
    // For a simple base64 PNG we use a 1x1 placeholder and note the limitation.
    // Full screenshot support requires the browser.tabs.captureVisibleTab API
    // called from background.js — so we delegate back.
    return '__delegate_to_background__'
}

/* ─── Click ──────────────────────────────────────────────────────── */

function clickElement(selector, overlayEnabled = true, opacity = 0.75) {
    ensureOverlayStyles()
    clearOverlays()

    const el = document.querySelector(selector)
    if (!el) throw new Error(`Element not found: ${selector}`)

    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const container = document.body || document.documentElement

    if (overlayEnabled) {
        const op = opacity
        const hl = document.createElement('div')
        hl.className = '__da-action-hl'
        hl.setAttribute('data-action', 'click')
        hl.style.cssText = `position:fixed;pointer-events:none;z-index:2147483645;border-radius:4px;box-sizing:border-box;`
            + `left:${rect.left - 3}px;top:${rect.top - 3}px;`
            + `width:${rect.width + 6}px;height:${rect.height + 6}px;`
            + `border:2.5px solid rgba(234,179,8,${op});`
            + `background:rgba(234,179,8,${op * 0.1});`
            + `box-shadow:0 0 8px rgba(234,179,8,${op * 0.35});`
        container.appendChild(hl)

        const dot = document.createElement('div')
        dot.className = '__da-dot'
        dot.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;`
            + `width:18px;height:18px;border-radius:50%;`
            + `background:rgba(255,90,54,0.85);`
            + `box-shadow:0 0 0 4px rgba(255,90,54,0.35),0 0 12px rgba(255,90,54,0.5);`
            + `left:${cx - 9}px;top:${cy - 9}px;`
            + `transition:transform .3s ease,opacity .4s ease;transform:scale(1);opacity:1`
        container.appendChild(dot)

        requestAnimationFrame(() => {
            setTimeout(() => { dot.style.transform = 'scale(2.2)'; dot.style.opacity = '0' }, 150)
            setTimeout(() => dot.remove(), 650)
            setTimeout(() => { hl.style.opacity = '0'; hl.style.transition = 'opacity 0.4s ease' }, 1200)
            setTimeout(() => hl.remove(), 1700)
        })
    }

    const evOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }
    el.dispatchEvent(new MouseEvent('pointerdown', evOpts))
    el.dispatchEvent(new MouseEvent('mousedown', evOpts))
    el.dispatchEvent(new MouseEvent('pointerup', evOpts))
    el.dispatchEvent(new MouseEvent('mouseup', evOpts))
    el.dispatchEvent(new MouseEvent('click', evOpts))
    return `Clicked: ${selector}`
}

/* ─── Type ───────────────────────────────────────────────────────── */

function typeIntoElement(selector, text, overlayEnabled = true, opacity = 0.75) {
    ensureOverlayStyles()
    clearOverlays()

    const el = document.querySelector(selector)
    if (!el) throw new Error(`Element not found: ${selector}`)

    const rect = el.getBoundingClientRect()
    const container = document.body || document.documentElement

    if (overlayEnabled) {
        const op = opacity
        const hl = document.createElement('div')
        hl.className = '__da-action-hl'
        hl.setAttribute('data-action', 'type')
        hl.style.cssText = `position:fixed;pointer-events:none;z-index:2147483645;border-radius:4px;box-sizing:border-box;`
            + `left:${rect.left - 3}px;top:${rect.top - 3}px;`
            + `width:${rect.width + 6}px;height:${rect.height + 6}px;`
            + `border:2.5px solid rgba(34,197,94,${op});`
            + `background:rgba(34,197,94,${op * 0.1});`
            + `box-shadow:0 0 8px rgba(34,197,94,${op * 0.35});`
        container.appendChild(hl)

        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2
        const dot = document.createElement('div')
        dot.className = '__da-dot'
        dot.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;`
            + `width:14px;height:14px;border-radius:50%;`
            + `background:rgba(59,130,246,0.85);`
            + `box-shadow:0 0 0 3px rgba(59,130,246,0.3),0 0 10px rgba(59,130,246,0.4);`
            + `left:${cx - 7}px;top:${cy - 7}px;`
            + `transition:transform .3s ease,opacity .5s ease;transform:scale(1);opacity:1`
        container.appendChild(dot)

        requestAnimationFrame(() => {
            setTimeout(() => { dot.style.transform = 'scale(1.8)'; dot.style.opacity = '0' }, 350)
            setTimeout(() => dot.remove(), 850)
            setTimeout(() => { hl.style.opacity = '0'; hl.style.transition = 'opacity 0.4s ease' }, 1500)
            setTimeout(() => hl.remove(), 2000)
        })
    }

    el.focus()
    const proto = el.tagName === 'TEXTAREA'
        ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
        : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    if (proto?.set) proto.set.call(el, text)
    else el.value = text

    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }))
    return `Typed into: ${selector}`
}

/* ─── Get text ───────────────────────────────────────────────────── */

function getText(selector) {
    const el = document.querySelector(selector)
    return el ? el.innerText : null
}

/* ─── Get interactive elements ───────────────────────────────────── */

function getInteractiveElements(cfg = {}) {
    ensureOverlayStyles()
    clearOverlays()

    const { showClick = true, showType = true, showText = true, opClick = 0.75, opType = 0.75, opText = 0.50 } = cfg
    const vw = window.innerWidth, vh = window.innerHeight
    const container = document.body || document.documentElement
    const gen = (window.__daOverlayGen = (window.__daOverlayGen || 0) + 1)

    function isVisible(el) {
        if (!el) return false
        const s = getComputedStyle(el)
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false
        if (el.offsetParent === null && s.position !== 'fixed' && s.position !== 'sticky' && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && r.right >= 0 && r.bottom >= 0 && r.left <= vw && r.top <= vh
    }

    function getPath(el) {
        const parts = []
        while (el && el.nodeType === 1) {
            const tag = el.nodeName.toLowerCase()
            if (el.id) { parts.unshift(`${tag}#${CSS.escape(el.id)}`); break }
            let nth = 1, sib = el
            while ((sib = sib.previousElementSibling)) if (sib.nodeName.toLowerCase() === tag) nth++
            parts.unshift(nth > 1 ? `${tag}:nth-of-type(${nth})` : tag)
            el = el.parentNode
        }
        return parts.join(' > ')
    }

    const typeableTags = { INPUT: 1, TEXTAREA: 1, SELECT: 1 }
    function isTypeable(el) {
        if (typeableTags[el.tagName]) {
            const t = (el.type || '').toLowerCase()
            if (el.tagName === 'INPUT' && ['button', 'submit', 'reset', 'image', 'hidden'].includes(t)) return false
            return true
        }
        return el.getAttribute('contenteditable') === 'true' ||
            ['textbox', 'combobox', 'searchbox'].includes(el.getAttribute('role') || '')
    }

    function hasDirectText(el) {
        for (const node of el.childNodes) if (node.nodeType === 3 && node.textContent.trim()) return true
        return false
    }

    const seen = new Set()
    const sels = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=menuitem],[role=textbox],[role=combobox],[role=searchbox],[onclick],[tabindex],label[for]'
    const interactive = Array.from(document.querySelectorAll(sels)).filter(isVisible).slice(0, 100)
    const textTags = 'p,h1,h2,h3,h4,h5,h6,span,li,td,th,label,blockquote,figcaption,caption,legend,dt,dd,em,strong,b,i,mark,small,del,ins,sub,sup,cite,code,pre,abbr,time,address'
    const textEls = Array.from(document.querySelectorAll(textTags)).filter((el) => isVisible(el) && hasDirectText(el)).slice(0, 150)

    const results = []
    let idx = 0

    for (const el of interactive) {
        seen.add(el)
        const r = el.getBoundingClientRect()
        const kind = isTypeable(el) ? 'type' : 'click'
        const shouldDraw = (kind === 'click' && showClick) || (kind === 'type' && showType)
        const opacity = kind === 'click' ? opClick : opType

        if (shouldDraw) {
            const borderColor = kind === 'click' ? `rgba(234,179,8,${opacity})` : `rgba(34,197,94,${opacity})`
            const bgColor = kind === 'click' ? `rgba(234,179,8,${opacity * 0.08})` : `rgba(34,197,94,${opacity * 0.08})`
            const box = document.createElement('div')
            box.className = '__da-scan-box'
            box.setAttribute('data-kind', kind)
            box.setAttribute('data-gen', gen)
            box.style.cssText = `position:fixed;pointer-events:none;z-index:2147483640;box-sizing:border-box;border-radius:3px;border:1.5px dashed ${borderColor};left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:${bgColor};`
            const badge = document.createElement('span')
            badge.className = '__da-idx'
            badge.style.cssText = 'position:absolute;top:-1px;left:-1px;background:rgba(255,90,54,0.92);color:#fff;font:bold 9px/1 system-ui,sans-serif;padding:1px 4px 2px;border-radius:0 0 4px 0;pointer-events:none;'
            badge.textContent = String(idx)
            box.appendChild(badge)
            container.appendChild(box)
        }

        const txt = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').substring(0, 100).replace(/\s+/g, ' ').trim()
        results.push({ index: idx, tag: el.tagName.toLowerCase(), kind, text: txt, selector: getPath(el), attributes: { id: el.id || undefined, name: el.name || undefined, type: el.type || undefined, placeholder: el.placeholder || undefined, role: el.getAttribute('role') || undefined }, box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })
        idx++
    }

    for (const tel of textEls) {
        if (seen.has(tel)) continue
        seen.add(tel)
        const tr = tel.getBoundingClientRect()
        if (showText) {
            const tbox = document.createElement('div')
            tbox.className = '__da-scan-box'
            tbox.setAttribute('data-kind', 'text')
            tbox.setAttribute('data-gen', gen)
            tbox.style.cssText = `position:fixed;pointer-events:none;z-index:2147483640;box-sizing:border-box;border-radius:3px;border:1px solid rgba(0,210,255,${opText});left:${tr.left}px;top:${tr.top}px;width:${tr.width}px;height:${tr.height}px;background:rgba(0,210,255,${opText * 0.07});`
            container.appendChild(tbox)
        }
        const ttxt = (tel.innerText || '').substring(0, 200).replace(/\s+/g, ' ').trim()
        if (ttxt) {
            results.push({ index: idx, tag: tel.tagName.toLowerCase(), kind: 'text', text: ttxt, selector: getPath(tel), attributes: { id: tel.id || undefined }, box: { x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height) } })
            idx++
        }
    }

    const thisGen = gen
    setTimeout(() => {
        document.querySelectorAll(`.__da-scan-box[data-gen="${thisGen}"]`).forEach((el) => { el.style.transition = 'opacity 0.4s ease'; el.style.opacity = '0' })
        setTimeout(() => document.querySelectorAll(`.__da-scan-box[data-gen="${thisGen}"]`).forEach((el) => el.remove()), 500)
    }, 4000)

    return results
}

/* ─── Message listener ───────────────────────────────────────────── */

_api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { method, params } = message || {}

        ; (async () => {
            try {
                let result

                switch (method) {
                    case 'Runtime.evaluate': {
                        const expr = params?.expression || ''
                        const res = await Promise.resolve(evaluate(expr))
                        result = { result: { type: 'string', value: res?.value ?? '' } }
                        break
                    }

                    case 'Page.captureScreenshot':
                        result = await captureScreenshot()
                        break

                    case 'Browser.click': {
                        const cfg = params?.overlayConfig || {}
                        result = clickElement(params.selector, cfg.overlayClickEnabled !== false, (cfg.overlayClickOpacity || 75) / 100)
                        break
                    }

                    case 'Browser.type': {
                        const cfg = params?.overlayConfig || {}
                        result = typeIntoElement(params.selector, params.text, cfg.overlayTypeEnabled !== false, (cfg.overlayTypeOpacity || 75) / 100)
                        break
                    }

                    case 'Browser.getText':
                        result = getText(params.selector)
                        break

                    case 'Browser.getInteractiveElements': {
                        const cfg = params?.overlayConfig || {}
                        result = getInteractiveElements({
                            showClick: cfg.overlayClickEnabled !== false,
                            showType: cfg.overlayTypeEnabled !== false,
                            showText: cfg.overlayTextEnabled !== false,
                            opClick: (cfg.overlayClickOpacity || 75) / 100,
                            opType: (cfg.overlayTypeOpacity || 75) / 100,
                            opText: (cfg.overlayTextOpacity || 50) / 100,
                        })
                        break
                    }

                    case 'Browser.clearOverlays':
                        result = clearOverlays()
                        break

                    default:
                        throw new Error(`Unknown method: ${method}`)
                }

                sendResponse({ result })
            } catch (e) {
                sendResponse({ error: e instanceof Error ? e.message : String(e) })
            }
        })()

    return true // keep message channel open for async response
})
