/* ======================================================================
 * CursorAutoHelper  –  v2  (2025-05-20)
 * ----------------------------------------------------------------------
 *  · Auto-clicks “resume the conversation” after 25 tool calls
 *  · Auto-clicks “Try again” when a “Connection failed” banner appears
 *    (exponential back-off – 1 s → 2 s → … 5 min)
 *  · Toast notifications in the lower-right corner
 *
 *  Public API exposed at `window.CursorAutoHelper`
 *    ├─ start()                – (re)start the helper
 *    ├─ stop()                 – stop watchers and reset state
 *    ├─ showToast(msg, ms)     – manual toast for testing
 *    ├─ setDebug(on)           – enable/disable alert-style debug
 *    └─ clearAllIntervals()    – 💥 nukes *every* interval on the page
 *                                (use only if stop() somehow fails)
 *
 *  Paste this whole file into DevTools. Re-pasting later cleans up the
 *  older copy and installs the new one.
 * ------------------------------------------------------------------- */

/* global document, window, setInterval, clearInterval, alert */

(function bootstrap () {
  const KEY = 'CursorAutoHelper';

  /* ───────────────────────────────── previous instance cleanup ──── */
  if (window[KEY] && typeof window[KEY].stop === 'function') {
    window[KEY].stop(/*silent*/ true);
  }

  /* ───────────────────────────────── module-scoped state ────────── */
  /** @type {ReturnType<typeof setInterval>[]} */
  let intervals = [];
  let retryDelay       = 1000;           // ms, exponential back-off
  let nextRetryAfter   = 0;              // timestamp
  let lastResumeClick  = 0;              // timestamp
  let debugAlerts      = false;          // toggle via setDebug(true)

  /* ───────────────────────────────── helpers ────────────────────── */
  /** @param {HTMLElement} el */
  const isVisible = el => !!(el.offsetParent);

  /**
   * Toast helper visible in the bottom-right corner.
   * Exposed so you can call `CursorAutoHelper.showToast('hi')`
   * @param {string} msg   –  message to show
   * @param {number} [ms]  –  duration (default 6000 ms)
   */
  function showToast (msg, ms = 6000) {
    const div = Object.assign(document.createElement('div'), {
      textContent : msg,
      style : `
        position:fixed; bottom:12px; right:12px; z-index:2147483647;
        background:#333; color:#fff; padding:6px 10px; border-radius:4px;
        font:12px/1.3 monospace; opacity:.92; pointer-events:none;
      `
    });
    document.body.appendChild(div);
    setTimeout(() => div.remove(), ms);
  }

  /** Debug utility – alert if debugAlerts === true */
  function dbg (msg) {
    if (debugAlerts) alert(msg);
  }

  /* ───────────────────────────────── Watchers ───────────────────── */

  /** Click “resume the conversation” if rate-limit banner is present */
  function resumeWatcher () {
    const now = Date.now();
    if (now - lastResumeClick < 3000) return;       // 3 s debounce

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
          dbg('🟢 Clicking “resume the conversation”');
          link.click();
          showToast('🟢 Resumed conversation');
          lastResumeClick = now;
          break;
        }
      }
    }
  }

  /**  Find a “Try again” button and click with exponential back-off */
  function retryWatcher () {
    const now = Date.now();
    if (now < nextRetryAfter) return;

    // broader selector set – sometimes “Try again” lives in <span>
    const candidates = document.querySelectorAll(
      'button, [role="button"], a, span'
    );

    /** @type {HTMLElement|undefined} */
    const btn = Array.from(candidates).find(el => {
      if (!isVisible(el)) return false;
      const txt = el.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
      return txt === 'try again' || txt.includes('try again');
    });

    if (btn) {
      dbg('🔄 Clicking “Try again” button');
      btn.click();
      showToast(`🔄 “Try again” clicked (next ${retryDelay/1000}s)`);
      nextRetryAfter = now + retryDelay;
      retryDelay     = Math.min(retryDelay * 2, 5 * 60_000);   // cap 5 min
    } else {
      // If no button visible, reset delay so next appearance is immediate
      retryDelay   = 1000;
      nextRetryAfter = 0;
    }
  }

  /* ───────────────────────────────── Control API ────────────────── */

  /**
   * Start / restart the helper
   * @param {boolean} [silent=false] – suppress toast on start
   */
  function start (silent = false) {
    stop(true);                               // ensure clean slate
    intervals.push(setInterval(resumeWatcher, 1000));
    intervals.push(setInterval(retryWatcher , 1000));
    resumeWatcher();
    retryWatcher();
    if (!silent) showToast('🚀 CursorAutoHelper started');
  }

  /**
   * Stop all intervals, reset state
   * @param {boolean} [silent=false] – suppress toast on stop
   */
  function stop (silent = false) {
    intervals.forEach(clearInterval);
    intervals = [];
    retryDelay      = 1000;
    nextRetryAfter  = 0;
    lastResumeClick = 0;
    if (!silent) showToast('🛑 CursorAutoHelper stopped');
  }

  /**
   * DEBUG ONLY – clears **every** interval that exists on the page.
   * Use if something breaks and `stop()` can’t clean up.
   */
  function clearAllIntervals () {
    const max = setInterval(() => {}, 9999);
    for (let i = max; i >= 0; --i) clearInterval(i);
    intervals = [];
    alert('💥 All intervals cleared.\nPaste the script again to restart.');
  }

  /** Enable / disable blocking alert debug */
  function setDebug (on = true) {
    debugAlerts = !!on;
    alert('Debug alerts ' + (debugAlerts ? 'ENABLED' : 'disabled'));
  }

  /* ─────────────────────────── Expose to window ─────────────────── */
  window[KEY] = {
    start,
    stop,
    showToast,
    setDebug,
    clearAllIntervals
  };

  /* ─────────────────────────── Auto-start instance ───────────────── */
  start(/*silent*/ true);
  showToast('🔧 CursorAutoHelper v2 loaded (use CursorAutoHelper.* API)');
})();
