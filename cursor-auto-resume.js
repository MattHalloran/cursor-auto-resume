/* ======================================================================
 * CursorAutoHelper  –  v4.1  (2025-05-20)
 * ---------------------------------------------------------------------- */

(function bootstrap () {
  const KEY = 'CursorAutoHelper';

  /* ───── Kill old version ───── */
  if (window[KEY]?.stop) window[KEY].stop(true);

  /* ───── State ───── */
  let intervals        = [];
  let retryDelay       = 1000;
  let nextRetryAfter   = 0;
  let lastResumeClick  = 0;
  let debugAlerts      = false;

  /* Cached reference to the main chat column.
     It’s LIVE — if the element gets re-mounted the reference updates
     automatically, but if it’s replaced we refresh the cache.           */
  let convoCache = null;
  const getConversationArea = () => {
    if (!convoCache || !document.contains(convoCache)) {
      convoCache = document.querySelector('.conversations');
    }
    return convoCache;
  };

  /* ───── Utilities ───── */
  const isVisible = el => {
    if (!(el instanceof HTMLElement)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    return cs.position === 'fixed' || !!el.offsetParent;
  };

  function showToast (msg, ms = 8000) {
    const div = Object.assign(document.createElement('div'), {
      textContent: msg,
      style: `
        position:fixed;bottom:12px;right:12px;z-index:2147483647;
        background:#333;color:#fff;padding:6px 10px;border-radius:4px;
        font:12px/1.3 monospace;opacity:.92;pointer-events:none;`
    });
    document.body.appendChild(div);
    setTimeout(() => div.remove(), ms);
  }
  const dbg = m => { if (debugAlerts) alert(m); };

  /* ───── 1.  Resume watcher ───── */
  function resumeWatcher () {
    const now = Date.now();
    if (now - lastResumeClick < 3000) return;

    // Still scanning whole body (banner may float outside convo)
    for (const el of document.querySelectorAll('body *')) {
      if (!el.textContent) continue;
      if (
        el.textContent.includes('stop the agent after 25 tool calls') ||
        el.textContent.includes('Note: we default stop')
      ) {
        const link = Array.from(
          el.querySelectorAll('a, span.markdown-link, [role="link"], [data-link]')
        ).find(a => a.textContent.trim() === 'resume the conversation');
        if (link) {
          link.click();
          showToast('🟢 Resumed conversation');
          dbg('Clicked “resume the conversation”');
          lastResumeClick = now;
          break;
        }
      }
    }
  }

  /* ───── 2.  Retry watcher (conversation-scoped) ───── */
  function retryWatcher () {
    const now = Date.now();
    if (now < nextRetryAfter) return;

    const convo = getConversationArea();
    if (!convo) return;

    /* ❶ Detect fail-banner span (search *only* inside convo) */
    const failSpan = Array.from(convo.querySelectorAll('span'))
      .find(s => s.textContent.trim().startsWith('Connection failed.'));

    if (!failSpan) {
      retryDelay     = 1000;
      nextRetryAfter = 0;
      return;
    }

    /* ❷ Primary: “Try again” button inside same banner subtree */
    const bannerRoot = failSpan.closest('div') || failSpan;
    const tryBtn = Array.from(
      bannerRoot.querySelectorAll('button,[role="button"],a,span')
    ).find(el => isVisible(el) && /try again/i.test(el.textContent));

    if (tryBtn) {
      tryBtn.click();
      showToast(`🔄 Clicked “Try again” (next ${retryDelay / 1000}s)`);
      dbg('Clicked "Try again"');
      nextRetryAfter = now + retryDelay;
      retryDelay     = Math.min(retryDelay * 2, 5 * 60_000);
      return;
    }

    /* ❸ Fallback: last message’s retry icon */
    const iconButtons = Array.from(
      convo.querySelectorAll('div.anysphere-icon-button')
    ).filter(btn => !btn.closest('.full-input-box')); // exclude input area

    const lastIcon = iconButtons.at(-1);
    if (lastIcon && isVisible(lastIcon)) {
      lastIcon.click();
      showToast(`🔄 Retried via message icon (next ${retryDelay / 1000}s)`);
      dbg('Clicked message retry icon');
      nextRetryAfter = now + retryDelay;
      retryDelay     = Math.min(retryDelay * 2, 5 * 60_000);
      return;
    }

    dbg('Fail banner found, but neither “Try again” nor icon present.');
  }

  /* ───── Controls ───── */
  function start (silent = false) {
    stop(true);
    intervals.push(setInterval(resumeWatcher, 1000));
    intervals.push(setInterval(retryWatcher , 1000));
    resumeWatcher();
    retryWatcher();
    if (!silent) showToast('🚀 CursorAutoHelper started');
  }
  function stop (silent = false) {
    intervals.forEach(clearInterval);
    intervals.length  = 0;
    retryDelay        = 1000;
    nextRetryAfter    = 0;
    lastResumeClick   = 0;
    if (!silent) showToast('🛑 CursorAutoHelper stopped');
  }
  function clearAllIntervals () {
    const max = setInterval(() => {}, 9999);
    for (let i = max; i >= 0; --i) clearInterval(i);
    intervals.length = 0;
    alert('💥 All intervals cleared – paste helper again if needed.');
  }
  function setDebug (on = true) {
    debugAlerts = !!on;
    alert('Debug alerts ' + (debugAlerts ? 'ENABLED' : 'disabled'));
  }

  /* ───── Expose & auto-start ───── */
  window[KEY] = { start, stop, showToast, clearAllIntervals, setDebug };
  start(true);
  showToast('🔧 CursorAutoHelper v4.1 ready (CursorAutoHelper.*)');
})();
