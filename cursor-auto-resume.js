/* ======================================================================
 * CursorAutoHelper  –  v4.3  (2025-05-20)
 * ----------------------------------------------------------------------
 *  · Auto-clicks “resume the conversation” after 25 tool calls
 *  · Auto-recovers from “Connection failed” via:
 *        – Visible “Try again” button
 *        – Last message’s retry icon (div.anysphere-icon-button)
 *  · Exponential back-off  (1 s → … → 5 min)
 *  · Toast notifications  (8 s default)
 *  · Preview: every target is highlighted (magenta outline) for 3 s;
 *             real click occurs after 1 s so you can see what’s chosen
 *
 *  Public API  →  window.CursorAutoHelper
 *    • start() / stop()
 *    • showToast(msg, ms)
 *    • setDebug(true|false)           – pops alert() diagnostics
 *    • clearAllIntervals()            – 💥 nukes **all** intervals (debug)
 * ------------------------------------------------------------------- */

(function bootstrap () {
  const KEY = 'CursorAutoHelper';
  if (window[KEY]?.stop) window[KEY].stop(true);       // remove old copy

  /* ──────────────── Module-level state ──────────────── */
  let intervals         = [];
  let retryDelay        = 1000;              // grows exponentially
  let nextRetryAfter    = 0;                 // timestamp
  let lastResumeClick   = 0;                 // timestamp
  let debugAlerts       = false;            // toggled via setDebug()
  let resumeBusy        = false;
  let retryBusy         = false;

  /* Cache `.conversations` column (refreshes if DOM is replaced) */
  let convoCache = null;
  function getConversationArea () {
    if (!convoCache || !convoCache.isConnected || !document.contains(convoCache)) {
      convoCache = document.querySelector('.conversations');
    }
    return convoCache;
  }

  /* ────────────────  Helpers  ──────────────── */

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
    if (!rect.width || !rect.height) return false;      // off-screen / collapsed
    return cs.position === 'fixed' || !!el.offsetParent;
  }

  /** Toast helper */
  function showToast (msg, ms = 8000) {
    const div = Object.assign(document.createElement('div'), {
      textContent : msg,
      style : `
        position:fixed;bottom:12px;right:12px;z-index:2147483647;
        background:#333;color:#fff;padding:6px 10px;border-radius:4px;
        font:12px/1.3 monospace;opacity:.92;pointer-events:none;`
    });
    document.body.appendChild(div);
    setTimeout(() => div.remove(), ms);
  }

  const dbg = m => { if (debugAlerts) alert(m); };

  /**
   * Highlight an element, click after a delay, then restore.
   * @param {HTMLElement}  el                 – element to act on
   * @param {() => void}   clickFn            – real click handler
   * @param {number}       delayBeforeClick   – ms before click (default 1000)
   * @param {number}       highlightMs        – how long outline stays (default 3000)
   * @param {() => void}   onFinish           – callback after highlight cleared
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
    el.style.outline = '3px solid magenta';

    // Schedule real click
    setTimeout(() => {
      try { clickFn(); }
      finally { /* ensure release even on errors */ }
    }, delayBeforeClick);

    // Remove outline and run finish callback
    setTimeout(() => {
      if (document.contains(el)) el.style.outline = origOutline || '';
      onFinish();
    }, highlightMs);
  }

  /* ──────────────── 1.  Resume-banner watcher ──────────────── */
  function resumeWatcher () {
    if (resumeBusy) return;
    const now = Date.now();
    if (now - lastResumeClick < 3000) return;

    for (const el of document.querySelectorAll('body *')) {
      if (!el.textContent) continue;
      if (
        el.textContent.includes('stop the agent after 25 tool calls') ||
        el.textContent.includes('Note: we default stop')
      ) {
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
  }

  /* ──────────────── 2.  Connection-failed watcher ──────────────── */
  function retryWatcher () {
    if (retryBusy) return;
    const now = Date.now();
    if (now < nextRetryAfter) return;

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

    /* Fallback – last retry icon */
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

  /* ────────────────  Control API  ──────────────── */
  function start (silent = false) {
    stop(true);                                // fresh slate
    intervals.push(setInterval(resumeWatcher, 1000));
    intervals.push(setInterval(retryWatcher , 1000));
    resumeWatcher();
    retryWatcher();
    if (!silent) showToast('🚀 CursorAutoHelper started');
  }

  function stop (silent = false) {
    intervals.forEach(clearInterval);
    intervals.length = 0;
    resumeBusy = retryBusy = false;
    retryDelay = 1000;
    nextRetryAfter = lastResumeClick = 0;
    if (!silent) showToast('🛑 CursorAutoHelper stopped');
  }

  /** DANGEROUS: clears *every* interval id that currently exists */
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
  showToast('🔧 CursorAutoHelper v4.3 loaded – preview enabled');
})();
