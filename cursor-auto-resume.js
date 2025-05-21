/* ======================================================================
 * CursorAutoHelper  –  v5.4  (2025-05-21)
 * ----------------------------------------------------------------------
 *  · All automatic clicks are now limited to the detected conversation pane
 *  · On load the pane is highlighted in magenta for 3 s
 *  · If the pane cannot be found → red error toast and helper aborts
 *  · Rest of the features exactly as in v5.3:
 *        – Auto-click “resume the conversation” (25-tool-call)
 *        – Auto-recover from connection errors (“Try again”, retry icon,
 *          and the alternate single-button “Resume” banner)
 *        – Idle checker ► tab cycler (abortable on real user input)
 *        – Exponential back-off on retries
 *        – Public API → window.CursorAutoHelper
 * ------------------------------------------------------------------- */

(function bootstrap () {
  const KEY = 'CursorAutoHelper';
  if (window[KEY]?.stop) window[KEY].stop(true);   // unload old copy

  /* ────────────────────────── CONFIG ────────────────────────── */
  const IDLE_TIMEOUT         = 60_000;
  const IDLE_START_NOTICE    = 10_000;
  const CYCLE_WARNING_BEFORE = 30_000;
  const TAB_DELAY            = 15_000;
  const IDLE_CHECK_INTERVAL  = 10_000;

  /* ────────────────────────── STATE ─────────────────────────── */
  let conversationPane  = null;   // will hold the pane element
  let intervals         = [];
  let retryDelay        = 1_000;
  let nextRetryAfter    = 0;
  let lastResumeClick   = 0;
  let debugAlerts       = false;
  let resumeBusy        = false;
  let retryBusy         = false;
  let resumeConnBusy    = false;

  let lastUserActivity  = Date.now();
  let idleToastShown    = false;
  let preCycleToastShown = false;

  const cycleCtl = { active: false, cancel: () => {} };

  let currentToast = null;
  let currentToastTimer = null;

  /* ────────────────────────── HELPERS ───────────────────────── */

  const log = (...args) => { if (debugAlerts) console.log('[CAH]', ...args); };

  function showToast (msg, ms = 8000, color = '#333') {
    if (currentToast) { clearTimeout(currentToastTimer); currentToast.remove(); }
    const div = Object.assign(document.createElement('div'), {
      textContent : msg,
      style : `
        position:fixed;bottom:12px;right:12px;z-index:2147483647;
        background:${color};color:#fff;padding:8px 10px;border-radius:4px;
        font:14px/1.3 monospace;opacity:.92;pointer-events:none;`
    });
    document.body.appendChild(div);
    currentToast = div;
    currentToastTimer = setTimeout(() => { div.remove(); currentToast = null; }, ms);
  }

/**
 * Visually highlight any element for `duration` ms – guaranteed visible.
 * Works even if the target has overflow:hidden or complex stacking.
 *
 * @param {Element|null} el
 * @param {number} [duration=3000]
 */
function highlightElement(el, duration = 3000) {
  if (!el || !(el instanceof HTMLElement)) return;

  // Get target’s bounding box relative to the viewport
  const rect = el.getBoundingClientRect();
  const overlay = Object.assign(document.createElement('div'), {
    style: `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 3px solid magenta;
      border-radius: 2px;
      pointer-events: none;
      z-index: 2147483647;          /* on top of everything */
      box-sizing: border-box;
      animation: cah-pulse 0.6s linear infinite;
    `
  });

  // Simple pulse so it’s harder to miss
  const styleTag = document.getElementById('cah-pulse-style') ??
    Object.assign(document.createElement('style'), {
      id: 'cah-pulse-style',
      textContent: `
        @keyframes cah-pulse {
          0%   { opacity: 1; }
          50%  { opacity: 0.4; }
          100% { opacity: 1; }
        }
      `
    });
  if (!styleTag.isConnected) document.head.appendChild(styleTag);

  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), duration);
}

  function previewAndClick (el, clickFn, before = 1000, dur = 3000) {
    if (!el || !el.offsetParent) return [];
    const prev = el.style.outline;
    el.style.outline = '3px solid magenta';
    const t1 = setTimeout(() => { clickFn(); }, before);
    const t2 = setTimeout(() => {
      if (document.contains(el)) el.style.outline = prev || '';
    }, dur);
    return [t1, t2];
  }

  /* ───────────── CONVERSATION PANE DETECTION ───────────── */

  /** Tries several heuristics to locate the conversation pane. */
  function findConversationPane () {
    // 1) Look for a visible UL.tablist and walk up to its composite part
    const ul = Array.from(
      document.querySelectorAll('ul.actions-container[role="tablist"]')
    ).find(el =>
      el.offsetParent !== null && el.closest('.right.pane-composite-part')
    );
    if (ul) return ul.closest('.right.pane-composite-part');

    // 2) Common class name used by Cursor
    const convo = document.querySelector('.conversations');
    if (convo && convo.offsetParent) return convo;

    // 3) ARIA label (fallback)
    const aria = document.querySelector('[aria-label="Conversations"]');
    if (aria && aria.offsetParent) return aria;

    return null;
  }

  /** All queries are scoped to the pane once it exists. */
  const qAll   = sel => conversationPane ? conversationPane.querySelectorAll(sel) : [];
  const qFirst = sel => conversationPane ? conversationPane.querySelector(sel)    : null;
  const isVisible = el => !!(el instanceof HTMLElement && el.offsetParent);

  /* ───────────── 1. “Resume conversation” WATCHER ───────────── */

  function resumeWatcher () {
    if (!conversationPane || resumeBusy || Date.now() - lastResumeClick < 3000) return;

    for (const el of qAll('*')) {
      if (!el.textContent ||
          (!el.textContent.includes('stop the agent after 25 tool calls') &&
           !el.textContent.includes('Note: we default stop'))) continue;

      const link = Array.from(
        el.querySelectorAll('a, span.markdown-link, [role="link"], [data-link]')
      ).find(a => a.textContent.trim() === 'resume the conversation');

      if (link && isVisible(link)) {
        resumeBusy = true;
        previewAndClick(
          link,
          () => { link.click(); lastResumeClick = Date.now(); showToast('🟢 Resumed conversation'); }
        );
        setTimeout(() => { resumeBusy = false; }, 3100);
        break;
      }
    }
  }

  /* ───────────── 2. CONNECTION WATCHERS ───────────── */

  function retryWatcher () {
    if (!conversationPane || retryBusy || Date.now() < nextRetryAfter) return;

    const failSpan = Array.from(qAll('span'))
      .find(s => s.textContent.trim().startsWith('Connection failed.'));

    if (!failSpan) { retryDelay = 1_000; nextRetryAfter = 0; return; }

    const banner = failSpan.closest('div') || failSpan;
    const tryBtn = Array.from(
      banner.querySelectorAll('button,[role="button"],a,span')
    ).find(el => /try again/i.test(el.textContent) && isVisible(el));

    const clickAndBackoff = (node, label) => {
      node.click();
      nextRetryAfter = Date.now() + retryDelay;
      retryDelay = Math.min(retryDelay * 2, 5 * 60_000);
      showToast(`🔄 ${label} (next ${retryDelay / 1000}s)`);
    };

    retryBusy = true;

    if (tryBtn) {
      previewAndClick(
        tryBtn, () => clickAndBackoff(tryBtn, 'Clicked “Try again”')
      );
      setTimeout(() => { retryBusy = false; }, 3100);
      return;
    }

    const iconBtn = Array.from(qAll('div.anysphere-icon-button'))
      .filter(btn => isVisible(btn) && !btn.closest('.full-input-box'))
      .at(-1);

    if (iconBtn) {
      previewAndClick(
        iconBtn, () => clickAndBackoff(iconBtn, 'Retried via icon')
      );
      setTimeout(() => { retryBusy = false; }, 3100);
      return;
    }

    retryBusy = false;
  }

  function resumeConnWatcher () {
    if (!conversationPane || resumeConnBusy || Date.now() < nextRetryAfter) return;

    const resumeBtn = Array.from(qAll('button,[role="button"],a,span'))
      .find(el => el.textContent.trim().toLowerCase() === 'resume' && isVisible(el));

    if (!resumeBtn) return;

    resumeConnBusy = true;
    previewAndClick(
      resumeBtn,
      () => {
        resumeBtn.click();
        nextRetryAfter = Date.now() + retryDelay;
        retryDelay = Math.min(retryDelay * 2, 5 * 60_000);
        showToast(`🔌 Pressed “Resume” (next ${retryDelay / 1000}s)`);
      }
    );
    setTimeout(() => { resumeConnBusy = false; }, 3100);
  }

  /* ───────────── 3. IDLE WATCHER & TAB CYCLER ─────────────── */

  const USER_EVENTS = ['mousedown', 'keydown', 'wheel', 'touchstart', 'pointerdown'];

  USER_EVENTS.forEach(evt =>
    window.addEventListener(evt, ev => {
      if (!ev.isTrusted) return;
      lastUserActivity = Date.now();
      if (cycleCtl.active) { cycleCtl.cancel(); showToast('⛔ Cycle cancelled by user'); }
      if (idleToastShown || preCycleToastShown) showToast('🔄 Idle countdown reset');
      idleToastShown = preCycleToastShown = false;
    }, { passive: true })
  );

  function findChatTabList () {
    return conversationPane
      ? conversationPane.querySelector('ul.actions-container[role="tablist"]')
      : null;
  }

  function cycleTabs (tabs) {
    cycleCtl.active = true;
    let idx = 0;
    let timers = [];

    cycleCtl.cancel = () => { timers.forEach(clearTimeout); timers = []; cycleCtl.active = false; };

    const next = () => {
      if (!cycleCtl.active) return;
      if (idx >= tabs.length) {
        showToast('🔄 Idle tab cycle complete');
        cycleCtl.active = false;
        lastUserActivity = Date.now();
        return;
      }
      const tab = tabs[idx++];
      const label = tab.textContent.trim() || `Tab ${idx}`;
      showToast(`📂 ${label}`);
      const [tClick, tOutline] = previewAndClick(
        tab, () => { if (cycleCtl.active) tab.click(); }
      );
      timers.push(tClick, tOutline, setTimeout(next, TAB_DELAY));
    };
    next();
  }

  function idleWatcher () {
    if (cycleCtl.active || !conversationPane) return;
    const idleFor = Date.now() - lastUserActivity;

    if (!idleToastShown && idleFor >= IDLE_START_NOTICE) {
      showToast(`😴 No activity – waiting ${IDLE_TIMEOUT / 1000}s before cycling tabs`);
      idleToastShown = true;
    }

    if (!preCycleToastShown && idleFor >= (IDLE_TIMEOUT - CYCLE_WARNING_BEFORE)) {
      const secs = Math.ceil((IDLE_TIMEOUT - idleFor) / 1000);
      showToast(`⏳ Cycling tabs in ${secs}s`);
      preCycleToastShown = true;
      highlightElement(findChatTabList(), 3000);
    }

    if (idleFor < IDLE_TIMEOUT) return;

    const ul = findChatTabList();
    if (!ul) { showToast('🚨 Chat tabs not found – cannot cycle'); return; }

    const tabs = Array.from(ul.querySelectorAll('li')).filter(isVisible);
    if (!tabs.length) return;

    idleToastShown = preCycleToastShown = false;
    showToast(`🔄 Idle detected – cycling ${tabs.length} tab${tabs.length > 1 ? 's' : ''}`);
    highlightElement(ul, 3000);
    cycleTabs(tabs);
  }

  /* ──────────────────── PUBLIC API & BOOTSTRAP ─────────────────── */

  function start (silent = false) {
    stop(true);
    intervals.push(setInterval(resumeWatcher     , 1000));
    intervals.push(setInterval(retryWatcher      , 1000));
    intervals.push(setInterval(resumeConnWatcher , 1000));
    intervals.push(setInterval(idleWatcher       , IDLE_CHECK_INTERVAL));
    resumeWatcher(); retryWatcher(); resumeConnWatcher(); idleWatcher();
    if (!silent) showToast('🚀 CursorAutoHelper started');
  }

  function stop (silent = false) {
    intervals.forEach(clearInterval); intervals.length = 0;
    retryBusy = resumeBusy = resumeConnBusy = false;
    retryDelay = 1_000; nextRetryAfter = lastResumeClick = 0;
    idleToastShown = preCycleToastShown = false;
    if (cycleCtl.active) cycleCtl.cancel();
    if (!silent) showToast('🛑 CursorAutoHelper stopped');
  }

  function clearAllIntervals () {
    const max = setInterval(() => {}, 9999);
    for (let i = max; i >= 0; --i) clearInterval(i);
    intervals.length = 0;
    alert('💥 All intervals cleared – reload or paste helper again.');
  }

  function setDebug (on) {
    debugAlerts = !!on;
    alert('Debug ' + (debugAlerts ? 'ENABLED' : 'disabled'));
  }

  /* ────────────────────────── INITIALISE ───────────────────────── */

  conversationPane = findConversationPane();
  if (!conversationPane) {
    showToast('🚨 Conversation pane not found – helper disabled', 12000, '#c01');
    return;          // nothing else runs
  }

  highlightElement(conversationPane, 3000);
  window[KEY] = { start, stop, showToast, setDebug, clearAllIntervals };
  start(true);
  showToast('🔧 CursorAutoHelper v5.4 loaded');
})();
