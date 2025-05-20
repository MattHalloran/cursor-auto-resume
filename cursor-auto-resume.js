/* ======================================================================
 * CursorAutoHelper  –  v4.6  (2025-05-20)
 * ----------------------------------------------------------------------
 *  · Auto-clicks “resume the conversation” banner (25-tool-call limit)
 *  · Auto-recovers from “Connection failed” banners & retry icons
 *  · Idle checker
 *        – Idle START notice after   10 s  (single toast)
 *        – “Cycling in 30 s” warning 30 s before tab-cycle  (single toast)
 *        – If either toast was shown and user becomes active → “Idle
 *          countdown reset” toast
 *        – After 3 min of user inactivity ► cycle every chat tab
 *        – Each tab highlighted magenta for 3 s, clicked after 1 s,
 *          4 s gap between tabs
 *  · Exponential back-off (1 s → … → 5 min) on retries
 *  · **Always at most one toast on screen**
 *  · Public API  →  window.CursorAutoHelper
 *      • start()/stop() · showToast() · setDebug() · clearAllIntervals()
 * ------------------------------------------------------------------- */

(function bootstrap () {
  const KEY = 'CursorAutoHelper';
  if (window[KEY]?.stop) window[KEY].stop(true);   // remove old copy

  /* ──────────────── Module-level state ──────────────── */
  let intervals         = [];
  let retryDelay        = 1000;
  let nextRetryAfter    = 0;
  let lastResumeClick   = 0;
  let debugAlerts       = false;
  let resumeBusy        = false;
  let retryBusy         = false;

  /* idle-checker */
  const IDLE_TIMEOUT          = 3 * 60_000;     // 3 min until cycling
  const IDLE_START_NOTICE     = 10_000;         // toast after 10 s idle
  const CYCLE_WARNING_BEFORE  = 30_000;         // toast 30 s pre-cycle
  const TAB_DELAY             = 4000;           // ms between tab actions
  let lastUserActivity  = Date.now();
  let isCyclingTabs     = false;
  let idleToastShown    = false;
  let preCycleToastShown = false;

  /* toast tracking */
  let currentToast = null;
  let currentToastTimer = null;

  /* Cache `.conversations` column (refreshes if DOM is replaced) */
  let convoCache = null;
  function getConversationArea () {
    if (!convoCache || !convoCache.isConnected || !document.contains(convoCache)) {
      convoCache = document.querySelector('.conversations');
    }
    return convoCache;
  }

  /* ──────────────── Helpers ──────────────── */

  /** Robust visibility test */
  function isVisible (el) {
    if (!(el instanceof HTMLElement)) return false;
    const cs = getComputedStyle(el);
    if (
      cs.display === 'none' ||
      cs.visibility === 'hidden' ||
      cs.opacity === '0'
    ) return false;

    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    return cs.position === 'fixed' || !!el.offsetParent;
  }

  /** Toast helper (now singleton) */
  function showToast (msg, ms = 8000) {
    if (currentToast) {                           // remove prior toast
      clearTimeout(currentToastTimer);
      currentToast.remove();
      currentToast = null;
    }
    const div = Object.assign(document.createElement('div'), {
      textContent : msg,
      style : `
        position:fixed;bottom:12px;right:12px;z-index:2147483647;
        background:#333;color:#fff;padding:8px;border-radius:4px;
        font:14px/1.3 monospace;opacity:.92;pointer-events:none;`
    });
    document.body.appendChild(div);
    currentToast = div;
    currentToastTimer = setTimeout(() => {
      div.remove();
      if (currentToast === div) currentToast = null;
    }, ms);
  }

  const dbg = m => { if (debugAlerts) alert(m); };

  /**
   * Highlight an element, click after a delay, then restore.
   */
  function previewAndClick (
    el,
    clickFn,
    delayBeforeClick = 1000,
    highlightMs    = 3000,
    onFinish       = () => {}
  ) {
    if (!el || !isVisible(el)) return onFinish();

    const origOutline = el.style.outline;
    el.style.outline  = '3px solid magenta';

    setTimeout(() => { try { clickFn(); } finally {} }, delayBeforeClick);

    setTimeout(() => {
      if (document.contains(el)) el.style.outline = origOutline || '';
      onFinish();
    }, highlightMs);
  }

  /* ──────────────── 1. Resume-banner watcher ──────────────── */
  function resumeWatcher () {
    if (resumeBusy) return;
    if (Date.now() - lastResumeClick < 3000) return;

    for (const el of document.querySelectorAll('body *')) {
      if (
        !el.textContent ||
        (!el.textContent.includes('stop the agent after 25 tool calls') &&
         !el.textContent.includes('Note: we default stop'))
      ) continue;

      const link = Array.from(
        el.querySelectorAll('a, span.markdown-link, [role="link"], [data-link]')
      ).find(a => a.textContent.trim() === 'resume the conversation');

      if (link && isVisible(link)) {
        resumeBusy = true;

        previewAndClick(
          link,
          () => {
            link.click();
            lastResumeClick = Date.now();
            showToast('🟢 Resumed conversation');
            dbg('Clicked “resume the conversation”');
          },
          1000,
          3000,
          () => { resumeBusy = false; }
        );
        break;
      }
    }
  }

  /* ──────────────── 2. Connection-failed watcher ──────────────── */
  function retryWatcher () {
    if (retryBusy) return;
    if (Date.now() < nextRetryAfter) return;

    const convo = getConversationArea();
    if (!convo) return;

    const failSpan = Array.from(convo.querySelectorAll('span'))
      .find(s => s.textContent.trim().startsWith('Connection failed.'));

    if (!failSpan) {
      retryDelay     = 1000;
      nextRetryAfter = 0;
      return;
    }

    const bannerRoot = failSpan.closest('div') || failSpan;

    const tryBtn = Array.from(
      bannerRoot.querySelectorAll('button,[role="button"],a,span')
    ).find(el => isVisible(el) && /try again/i.test(el.textContent));

    const clickAndBackoff = (node, label) => {
      node.click();
      nextRetryAfter = Date.now() + retryDelay;
      retryDelay     = Math.min(retryDelay * 2, 5 * 60_000);
      showToast(`🔄 ${label} (next ${retryDelay / 1000}s)`);
      dbg(`Clicked ${label}`);
    };

    retryBusy = true;

    if (tryBtn) {
      previewAndClick(
        tryBtn,
        () => clickAndBackoff(tryBtn, 'Clicked “Try again”'),
        1000,
        3000,
        () => { retryBusy = false; }
      );
      return;
    }

    /* fallback – last retry icon */
    const iconButtons = Array.from(
      convo.querySelectorAll('div.anysphere-icon-button')
    ).filter(btn => !btn.closest('.full-input-box') && isVisible(btn));

    const lastIcon = iconButtons.at(-1);
    if (lastIcon) {
      previewAndClick(
        lastIcon,
        () => clickAndBackoff(lastIcon, 'Retried via message icon'),
        1000,
        3000,
        () => { retryBusy = false; }
      );
      return;
    }

    retryBusy = false;
    dbg('Fail banner found, but no actionable element.');
  }

  /* ──────────────── 3. Idle-checker & tab cycler ──────────────── */

  /* track user activity – also cancel idle countdown */
  ['scroll','click','keydown','mousemove','touchstart'].forEach(evt =>
    window.addEventListener(evt, () => {
      if (idleToastShown || preCycleToastShown) showToast('🔄 Idle countdown reset');
      idleToastShown = preCycleToastShown = false;
      lastUserActivity = Date.now();
    })
  );

  function cycleTabs (tabs) {
    let i = 0;
    const next = () => {
      if (i >= tabs.length) {
        showToast('🔄 Idle tab cycle complete');
        lastUserActivity = Date.now();
        isCyclingTabs    = false;
        return;
      }
      const tab = tabs[i++];
      previewAndClick(tab, () => tab.click(), 1000, 3000,
        () => setTimeout(next, TAB_DELAY));
    };
    next();
  }

  function idleWatcher () {
    if (isCyclingTabs) return;

    const idleFor = Date.now() - lastUserActivity;

    /* 3a. idle-start toast after 10 s */
    if (!idleToastShown && idleFor >= IDLE_START_NOTICE) {
      showToast(`😴 No activity detected – waiting ${IDLE_TIMEOUT / 1000}s before cycling tabs`);
      idleToastShown = true;
    }

    /* 3b. 30-s pre-cycle warning */
    if (!preCycleToastShown && idleFor >= (IDLE_TIMEOUT - CYCLE_WARNING_BEFORE)) {
      const secs = Math.ceil((IDLE_TIMEOUT - idleFor) / 1000);
      showToast(`⏳ Cycling tabs in ${secs}s`);
      preCycleToastShown = true;
    }

    if (idleFor < IDLE_TIMEOUT) return;    // not yet cycling

    /* 3c. time to cycle */
    const convo = getConversationArea();
    if (!convo) return;
    const tabs = Array.from(
      convo.querySelectorAll('ul.actions-container[role="tablist"] > li')
    ).filter(isVisible);
    if (!tabs.length) return;

    isCyclingTabs = true;
    idleToastShown = preCycleToastShown = false;
    showToast(`🔄 Idle detected – cycling ${tabs.length} tab${tabs.length === 1 ? '' : 's'}`);
    dbg(`Idle – cycling ${tabs.length} tabs`);
    cycleTabs(tabs);
  }

  /* ────────────────  Control API  ──────────────── */
  function start (silent = false) {
    stop(true);                              // fresh slate
    intervals.push(setInterval(resumeWatcher, 1000));
    intervals.push(setInterval(retryWatcher , 1000));
    intervals.push(setInterval(idleWatcher  , 30_000));
    resumeWatcher(); retryWatcher(); idleWatcher();
    if (!silent) showToast('🚀 CursorAutoHelper started');
  }

  function stop (silent = false) {
    intervals.forEach(clearInterval);
    intervals.length = 0;
    resumeBusy = retryBusy = isCyclingTabs = false;
    retryDelay = 1000;
    nextRetryAfter = lastResumeClick = 0;
    idleToastShown = preCycleToastShown = false;
    if (!silent) showToast('🛑 CursorAutoHelper stopped');
  }

  /** DANGEROUS: clears every interval id currently present */
  function clearAllIntervals () {
    const max = setInterval(() => {}, 9999);
    for (let i = max; i >= 0; --i) clearInterval(i);
    intervals.length = 0;
    alert('💥 All intervals cleared – reload or paste helper again.');
  }

  const setDebug = on => {
    debugAlerts = !!on;
    alert('Debug alerts ' + (debugAlerts ? 'ENABLED' : 'disabled'));
  };

  /* ────────────────  Expose & auto-start  ──────────────── */
  window[KEY] = { start, stop, showToast, setDebug, clearAllIntervals };
  start(true);
  showToast('🔧 CursorAutoHelper v4.6 loaded');
})();
