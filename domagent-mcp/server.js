import { WebSocketServer } from 'ws';
import { createServer } from 'http';

function escapeJS(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

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
  top: -1px !important;
  left: -1px !important;
  background: rgba(255, 90, 54, 0.92) !important;
  color: #fff !important;
  font: bold 9px/1 system-ui, sans-serif !important;
  padding: 1px 4px 2px !important;
  border-radius: 0 0 4px 0 !important;
  pointer-events: none !important;
  letter-spacing: 0.3px !important;
}
.__da-action-hl {
  position: fixed !important;
  pointer-events: none !important;
  z-index: 2147483645 !important;
  border-radius: 4px !important;
  box-sizing: border-box !important;
  animation: __da-pulse 0.5s ease-in-out 3 !important;
}
.__da-action-hl[data-action="click"] {
  border: 2.5px solid rgba(234, 179, 8, 0.95) !important;
  background: rgba(234, 179, 8, 0.10) !important;
  box-shadow: 0 0 8px rgba(234, 179, 8, 0.35) !important;
}
.__da-action-hl[data-action="type"] {
  border: 2.5px solid rgba(34, 197, 94, 0.95) !important;
  background: rgba(34, 197, 94, 0.10) !important;
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.35) !important;
}
@keyframes __da-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
`;

export class BridgeServer {
  constructor(port = 18792, path = '/extension') {
    this.port = port;
    this.path = path;
    this.wss = null;
    this.httpServer = null;
    this.activeConnection = null;
    this.pendingRequests = new Map();
    this.nextId = 1;
    this.activeSessionId = null;
  }

  start() {
    return new Promise((resolve) => {
      this.httpServer = createServer((req, res) => {
        if ((req.method === 'HEAD' || req.method === 'GET') && (req.url === '/' || req.url === '/health')) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
          return;
        }
        res.writeHead(404);
        res.end();
      });

      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws, req) => {
        if (req.url !== this.path) { ws.close(); return; }

        console.error('Extension connected');
        this.activeConnection = ws;

        ws.on('message', (raw) => {
          try { this.handleMessage(JSON.parse(raw)); }
          catch (e) { console.error('Parse error:', e); }
        });

        ws.on('close', () => {
          console.error('Extension disconnected');
          this.activeConnection = null;
          this.activeSessionId = null;
        });

        ws.on('error', (err) => console.error('WS error:', err));
      });

      this.httpServer.listen(this.port, '127.0.0.1', () => {
        console.error(`DOMAgent Bridge running on ws://127.0.0.1:${this.port}${this.path}`);
        resolve();
      });
    });
  }

  handleMessage(data) {
    if (data.method === 'ping') { this.send({ method: 'pong' }); return; }

    if (data.id && (data.result !== undefined || data.error !== undefined)) {
      const p = this.pendingRequests.get(data.id);
      if (p) {
        this.pendingRequests.delete(data.id);
        data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
      }
    }
  }

  send(payload) {
    if (!this.activeConnection || this.activeConnection.readyState !== 1) {
      throw new Error('Extension not connected');
    }
    this.activeConnection.send(JSON.stringify(payload));
  }

  async sendCommand(method, params = {}) {
    if (!this.activeConnection) throw new Error('Extension not connected');

    const id = this.nextId++;
    const cmdParams = { method, params };

    if (this.activeSessionId) {
      cmdParams.sessionId = this.activeSessionId;
    }

    const payload = { id, method: 'forwardCDPCommand', params: cmdParams };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Command ${method} timed out`));
        }
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (res) => { clearTimeout(timeout); resolve(res); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      try { this.send(payload); }
      catch (err) { clearTimeout(timeout); this.pendingRequests.delete(id); reject(err); }
    });
  }

  async navigate(url) {
    console.error(`Navigating to: ${url}`);
    const result = await this.sendCommand('Browser.ensureTab', { url });
    if (result?.sessionId) this.activeSessionId = result.sessionId;
    return result;
  }

  async useCurrentTab() {
    console.error('Adopting current tab as automation target');
    const result = await this.sendCommand('Browser.useCurrentTab', {});
    if (result?.sessionId) this.activeSessionId = result.sessionId;
    return result;
  }

  async getScreenshot() {
    const result = await this.sendCommand('Page.captureScreenshot', { format: 'png' });
    return result.data;
  }

  async evaluate(expression) {
    const result = await this.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`Evaluation failed: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  async getOverlaySettings() {
    try {
      const settings = await this.sendCommand('Browser.getOverlaySettings', {});
      return {
        overlayClickEnabled: settings.overlayClickEnabled !== false,
        overlayClickOpacity: Number(settings.overlayClickOpacity) || 75,
        overlayTypeEnabled: settings.overlayTypeEnabled !== false,
        overlayTypeOpacity: Number(settings.overlayTypeOpacity) || 75,
        overlayTextEnabled: settings.overlayTextEnabled !== false,
        overlayTextOpacity: Number(settings.overlayTextOpacity) || 50,
      };
    } catch {
      return {
        overlayClickEnabled: true, overlayClickOpacity: 75,
        overlayTypeEnabled: true, overlayTypeOpacity: 75,
        overlayTextEnabled: true, overlayTextOpacity: 50,
      };
    }
  }
  async _ensureOverlayStyles() {
    const cssEscaped = escapeJS(OVERLAY_CSS);
    try {
      await this.evaluate(`(function(){
  if (document.getElementById('__da-style')) return 'exists';
  var s = document.createElement('style');
  s.id = '__da-style';
  s.textContent = '${cssEscaped}';
  (document.head || document.documentElement).appendChild(s);
  return 'injected';
})()`);
    } catch {
      console.error('Warning: overlay CSS injection failed (CSP or page not ready)');
    }
  }
  async clearOverlays() {
    return this.evaluate(`(function(){
  document.querySelectorAll('.__da-scan-box, .__da-action-hl, .__da-dot').forEach(function(el){ el.remove(); });
  return 'cleared';
})()`);
  }
  async click(selector) {
    await this._ensureOverlayStyles();
    await this.clearOverlays().catch(() => { });

    const cfg = await this.getOverlaySettings();
    const showHL = cfg.overlayClickEnabled !== false;
    const op = (cfg.overlayClickOpacity || 75) / 100;

    const safe = escapeJS(selector);
    const code = `(function(){
  var el = document.querySelector('${safe}');
  if (!el) throw new Error('Element not found: ${safe}');
  var rect = el.getBoundingClientRect();
  var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  var container = document.body || document.documentElement;

  if (${showHL}) {
    var hl = document.createElement('div');
    hl.className = '__da-action-hl';
    hl.setAttribute('data-action', 'click');
    hl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;'
      + 'border-radius:4px;box-sizing:border-box;'
      + 'left:' + (rect.left - 3) + 'px;top:' + (rect.top - 3) + 'px;'
      + 'width:' + (rect.width + 6) + 'px;height:' + (rect.height + 6) + 'px;'
      + 'border:2.5px solid rgba(234,179,8,' + ${op} + ');'
      + 'background:rgba(234,179,8,' + ${op * 0.1} + ');'
      + 'box-shadow:0 0 8px rgba(234,179,8,' + ${op * 0.35} + ');';
    container.appendChild(hl);

    var dot = document.createElement('div');
    dot.className = '__da-dot';
    dot.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;'
      + 'width:18px;height:18px;border-radius:50%;'
      + 'background:rgba(255,90,54,0.85);'
      + 'box-shadow:0 0 0 4px rgba(255,90,54,0.35),0 0 12px rgba(255,90,54,0.5);'
      + 'left:' + (cx - 9) + 'px;top:' + (cy - 9) + 'px;'
      + 'transition:transform .3s ease,opacity .4s ease;'
      + 'transform:scale(1);opacity:1';
    container.appendChild(dot);

    requestAnimationFrame(function(){
      setTimeout(function(){ dot.style.transform='scale(2.2)'; dot.style.opacity='0'; }, 150);
      setTimeout(function(){ dot.remove(); }, 650);
      setTimeout(function(){ hl.style.opacity='0'; hl.style.transition='opacity 0.4s ease'; }, 1200);
      setTimeout(function(){ hl.remove(); }, 1700);
    });
  }

  var evOpts = { bubbles: true, cancelable: true, view: window,
    clientX: cx, clientY: cy, button: 0 };
  el.dispatchEvent(new MouseEvent('pointerdown', evOpts));
  el.dispatchEvent(new MouseEvent('mousedown', evOpts));
  el.dispatchEvent(new MouseEvent('pointerup', evOpts));
  el.dispatchEvent(new MouseEvent('mouseup', evOpts));
  el.dispatchEvent(new MouseEvent('click', evOpts));
  return 'Clicked: ${safe}';
})()`;
    return this.evaluate(code);
  }
  async type(selector, text) {
    await this._ensureOverlayStyles();
    await this.clearOverlays().catch(() => { });

    const cfg = await this.getOverlaySettings();
    const showHL = cfg.overlayTypeEnabled !== false;
    const op = (cfg.overlayTypeOpacity || 75) / 100;

    const safeSel = escapeJS(selector);
    const safeText = escapeJS(text);
    const code = `(function(){
  var el = document.querySelector('${safeSel}');
  if (!el) throw new Error('Element not found: ${safeSel}');
  var rect = el.getBoundingClientRect();
  var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  var container = document.body || document.documentElement;

  if (${showHL}) {
    var hl = document.createElement('div');
    hl.className = '__da-action-hl';
    hl.setAttribute('data-action', 'type');
    hl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;'
      + 'border-radius:4px;box-sizing:border-box;'
      + 'left:' + (rect.left - 3) + 'px;top:' + (rect.top - 3) + 'px;'
      + 'width:' + (rect.width + 6) + 'px;height:' + (rect.height + 6) + 'px;'
      + 'border:2.5px solid rgba(34,197,94,' + ${op} + ');'
      + 'background:rgba(34,197,94,' + ${op * 0.1} + ');'
      + 'box-shadow:0 0 8px rgba(34,197,94,' + ${op * 0.35} + ');';
    container.appendChild(hl);

    var dot = document.createElement('div');
    dot.className = '__da-dot';
    dot.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;'
      + 'width:14px;height:14px;border-radius:50%;'
      + 'background:rgba(59,130,246,0.85);'
      + 'box-shadow:0 0 0 3px rgba(59,130,246,0.3),0 0 10px rgba(59,130,246,0.4);'
      + 'left:' + (cx - 7) + 'px;top:' + (cy - 7) + 'px;'
      + 'transition:transform .3s ease,opacity .5s ease;'
      + 'transform:scale(1);opacity:1';
    container.appendChild(dot);

    requestAnimationFrame(function(){
      setTimeout(function(){ dot.style.transform='scale(1.8)'; dot.style.opacity='0'; }, 350);
      setTimeout(function(){ dot.remove(); }, 850);
      setTimeout(function(){ hl.style.opacity='0'; hl.style.transition='opacity 0.4s ease'; }, 1500);
      setTimeout(function(){ hl.remove(); }, 2000);
    });
  }

  el.focus();

  var proto = el.tagName === 'TEXTAREA'
    ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
    : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (proto && proto.set) {
    proto.set.call(el, '${safeText}');
  } else {
    el.value = '${safeText}';
  }

  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return 'Typed into: ${safeSel}';
})()`;
    return this.evaluate(code);
  }
  async getText(selector) {
    const safe = escapeJS(selector);
    return this.evaluate(`(function(){
  var el = document.querySelector('${safe}');
  return el ? el.innerText : null;
})()`);
  }

  async getInteractiveElements() {
    await this._ensureOverlayStyles();
    await this.clearOverlays().catch(() => { });

    const cfg = await this.getOverlaySettings();
    const showClick = cfg.overlayClickEnabled !== false;
    const showType = cfg.overlayTypeEnabled !== false;
    const showText = cfg.overlayTextEnabled !== false;
    const opClick = (cfg.overlayClickOpacity || 75) / 100;
    const opType = (cfg.overlayTypeOpacity || 75) / 100;
    const opText = (cfg.overlayTextOpacity || 50) / 100;

    return this.evaluate(`(function(){
  var CFG = {
    showClick: ${showClick}, showType: ${showType}, showText: ${showText},
    opClick: ${opClick}, opType: ${opType}, opText: ${opText}
  };

  var gen = (window.__daOverlayGen || 0) + 1;
  window.__daOverlayGen = gen;

  var vw = window.innerWidth, vh = window.innerHeight;

  var container = document.body || document.documentElement;
  if (!container) return [];

  function isVisible(el) {
    if (!el) return false;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    if (el.offsetParent === null
        && s.position !== 'fixed'
        && s.position !== 'sticky'
        && el.tagName !== 'BODY'
        && el.tagName !== 'HTML') {
      return false;
    }
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) return false;
    return true;
  }

  function getPath(el) {
    if (!(el instanceof Element)) return '';
    var parts = [];
    while (el && el.nodeType === 1) {
      var tag = el.nodeName.toLowerCase();
      if (el.id) {
        var eid = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(el.id)
          : el.id.replace(/([^\\w-])/g, '\\\\$1');
        parts.unshift(tag + '#' + eid);
        break;
      }
      var sib = el, nth = 1;
      while ((sib = sib.previousElementSibling)) {
        if (sib.nodeName.toLowerCase() === tag) nth++;
      }
      if (nth > 1) tag += ':nth-of-type(' + nth + ')';
      parts.unshift(tag);
      el = el.parentNode;
    }
    return parts.join(' > ');
  }

  var typeableTags = { INPUT:1, TEXTAREA:1, SELECT:1 };
  function isTypeable(el) {
    if (typeableTags[el.tagName]) {
      var t = (el.type || '').toLowerCase();
      if (el.tagName === 'INPUT' && (t==='button'||t==='submit'||t==='reset'||t==='image'||t==='hidden')) return false;
      return true;
    }
    if (el.getAttribute('contenteditable') === 'true') return true;
    if (el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'combobox' || el.getAttribute('role') === 'searchbox') return true;
    return false;
  }

  function hasDirectText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3 && el.childNodes[i].textContent.trim().length > 0) return true;
    }
    return false;
  }

  var seen = new Set();

  var sels = 'a[href],button,input:not([type=hidden]),textarea,select,'
    + '[role=button],[role=link],[role=menuitem],[role=textbox],[role=combobox],[role=searchbox],[onclick],[tabindex],label[for]';
  var interactive = Array.from(document.querySelectorAll(sels)).filter(isVisible);
  interactive = interactive.slice(0, 100);

  var textTags = 'p,h1,h2,h3,h4,h5,h6,span,li,td,th,label,blockquote,figcaption,caption,legend,dt,dd,em,strong,b,i,mark,small,del,ins,sub,sup,cite,code,pre,abbr,time,address';
  var textEls = Array.from(document.querySelectorAll(textTags)).filter(function(el) {
    return isVisible(el) && hasDirectText(el);
  });
  textEls = textEls.slice(0, 150);

  var results = [];
  var idx = 0;
  for (var i = 0; i < interactive.length; i++) {
    var el = interactive[i];
    seen.add(el);
    var r = el.getBoundingClientRect();
    var kind = isTypeable(el) ? 'type' : 'click';

    var shouldDraw = (kind === 'click' && CFG.showClick) || (kind === 'type' && CFG.showType);
    var opacity = kind === 'click' ? CFG.opClick : CFG.opType;

    if (shouldDraw) {
      var box = document.createElement('div');
      box.className = '__da-scan-box';
      box.setAttribute('data-kind', kind);
      box.setAttribute('data-gen', gen);
      var borderColor = kind === 'click'
        ? 'rgba(234,179,8,' + opacity + ')'
        : 'rgba(34,197,94,' + opacity + ')';
      var bgColor = kind === 'click'
        ? 'rgba(234,179,8,' + (opacity * 0.08) + ')'
        : 'rgba(34,197,94,' + (opacity * 0.08) + ')';
      var borderStyle = kind === 'click'
        ? '1.5px dashed ' + borderColor
        : '1.5px dashed ' + borderColor;
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483640;'
        + 'box-sizing:border-box;border-radius:3px;'
        + 'border:' + borderStyle + ';'
        + 'left:' + r.left + 'px;top:' + r.top + 'px;'
        + 'width:' + r.width + 'px;height:' + r.height + 'px;'
        + 'background:' + bgColor + ';';

      var badge = document.createElement('span');
      badge.className = '__da-idx';
      badge.style.cssText = 'position:absolute;top:-1px;left:-1px;'
        + 'background:rgba(255,90,54,0.92);color:#fff;'
        + 'font:bold 9px/1 system-ui,sans-serif;'
        + 'padding:1px 4px 2px;border-radius:0 0 4px 0;pointer-events:none;letter-spacing:0.3px;';
      badge.textContent = String(idx);
      box.appendChild(badge);
      container.appendChild(box);
    }

    var txt = (el.innerText||el.value||el.placeholder||el.getAttribute('aria-label')||'')
      .substring(0,100).replace(/\\s+/g,' ').trim();
    results.push({
      index: idx,
      tag: el.tagName.toLowerCase(),
      kind: kind,
      text: txt,
      selector: getPath(el),
      attributes: {
        id: el.id || undefined,
        name: el.name || undefined,
        type: el.type || undefined,
        placeholder: el.placeholder || undefined,
        role: el.getAttribute('role') || undefined
      },
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    });
    idx++;
  }

  for (var j = 0; j < textEls.length; j++) {
    var tel = textEls[j];
    if (seen.has(tel)) continue;
    seen.add(tel);
    var tr = tel.getBoundingClientRect();

    if (CFG.showText) {
      var tbox = document.createElement('div');
      tbox.className = '__da-scan-box';
      tbox.setAttribute('data-kind', 'text');
      tbox.setAttribute('data-gen', gen);
      tbox.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483640;'
        + 'box-sizing:border-box;border-radius:3px;'
        + 'border:1px solid rgba(0,210,255,' + CFG.opText + ');'
        + 'left:' + tr.left + 'px;top:' + tr.top + 'px;'
        + 'width:' + tr.width + 'px;height:' + tr.height + 'px;'
        + 'background:rgba(0,210,255,' + (CFG.opText * 0.07) + ');';
      container.appendChild(tbox);
    }

    var ttxt = (tel.innerText || '').substring(0, 200).replace(/\\s+/g, ' ').trim();
    if (ttxt) {
      results.push({
        index: idx,
        tag: tel.tagName.toLowerCase(),
        kind: 'text',
        text: ttxt,
        selector: getPath(tel),
        attributes: { id: tel.id || undefined },
        box: { x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height) }
      });
      idx++;
    }
  }

  var thisGen = gen;
  setTimeout(function(){
    document.querySelectorAll('.__da-scan-box[data-gen="' + thisGen + '"]').forEach(function(el){
      el.style.transition = 'opacity 0.4s ease';
      el.style.opacity = '0';
    });
    setTimeout(function(){
      document.querySelectorAll('.__da-scan-box[data-gen="' + thisGen + '"]').forEach(function(el){ el.remove(); });
    }, 500);
  }, 4000);

  return results;
})()`);
  }
}
