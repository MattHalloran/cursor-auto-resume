/* ======================================================================
 * CursorAutoHelper  –  v5.2  (2025-05-20)
 * ----------------------------------------------------------------------
 *  · Auto-clicks “resume the conversation” banner (25-tool-call limit)
 *  · Auto-recovers from “Connection failed” banners & retry icons
 *  · Idle checker
 *        – Idle-START toast after 10 s
 *        – “Cycling in 30 s” warning (tab-strip outlined)
 *        – After 1 min of real inactivity ► cycle every chat tab
 *              · each tab outlined 3 s, clicked after 1 s, shown 15 s
 *  · Exponential back-off (1 s → … → 5 min) on retries
 *  · Always at most one toast on screen
 *  · Public API → window.CursorAutoHelper
 *      • start()  stop()  showToast()  setDebug()  clearAllIntervals()
 * ------------------------------------------------------------------- */

(function bootstrap () {
  const KEY = 'CursorAutoHelper';
  if (window[KEY]?.stop) window[KEY].stop(true);   // unload old copy

  /* ────────────────────────── CONFIG ────────────────────────── */
  /** Time (ms) before cycling starts after last real user action. */
  const IDLE_TIMEOUT         = 60_000;
  /** First idle-notice toast delay (ms). */
  const IDLE_START_NOTICE    = 10_000;
  /** “Cycling in …” warning appears this many ms before cycling. */
  const CYCLE_WARNING_BEFORE = 30_000;
  /** How long (ms) to keep each tab open during cycling. */
  const TAB_DELAY            = 15_000;
  /** Idle-watcher polling interval (ms). */
  const IDLE_CHECK_INTERVAL  = 10_000;

  /* ────────────────────────── STATE ─────────────────────────── */
  let intervals          = [];
  let retryDelay         = 1_000;
  let nextRetryAfter     = 0;
  let lastResumeClick    = 0;
  let debugAlerts        = false;
  let resumeBusy         = false;
  let retryBusy          = false;

  let lastUserActivity   = Date.now();
  let isCyclingTabs      = false;
  let idleToastShown     = false;
  let preCycleToastShown = false;

  let currentToast       = null;
  let currentToastTimer  = null;

  /* ────────────────────────── HELPERS ───────────────────────── */

  /**
   * Write to console only when debug is enabled.
   * @param {...unknown} args – anything to log
   */
  const log = (...args) => { if (debugAlerts) console.log('[CAH]', ...args); };

  /**
   * Display a toast message, ensuring only one toast is visible at a time.
   * @param {string} msg – text content
   * @param {number} [ms=8000] – time before auto-dismiss (ms)
   */
  function showToast (msg, ms = 8000) {
    if (currentToast) { clearTimeout(currentToastTimer); currentToast.remove(); }
    const div = Object.assign(document.createElement('div'), {
      textContent : msg,
      style : `
        position:fixed;bottom:12px;right:12px;z-index:2147483647;
        background:#333;color:#fff;padding:8px;border-radius:4px;
        font:14px/1.3 monospace;opacity:.92;pointer-events:none;`
    });
    document.body.appendChild(div);
    currentToast = div;
    currentToastTimer = setTimeout(() => { div.remove(); currentToast = null; }, ms);
  }

  /**
   * Add a temporary magenta outline to an element.
   * @param {Element|null} el – element to outline
   * @param {number} [duration=3000] – outline duration (ms)
   */
  function highlightElement (el, duration = 3000) {
    if (!el || !(el instanceof HTMLElement)) return;
    const prev = el.style.outline;
    el.style.outline = '3px solid magenta';
    setTimeout(() => { if (document.contains(el)) el.style.outline = prev || ''; }, duration);
  }

  /**
   * Outline `el`, wait `before` ms, click it, keep outline `dur` ms total.
   * Executes `onDone` after outline removal.
   * @param {HTMLElement} el
   * @param {() => void} clickFn
   * @param {number} [before=1000] – delay before click (ms)
   * @param {number} [dur=3000] – total outline time (ms)
   * @param {() => void} [onDone] – callback when complete
   */
  function previewAndClick (
    el, clickFn, before = 1000, dur = 3000, onDone = () => {}
  ) {
    if (!el || !el.offsetParent) { onDone(); return; }
    const prev = el.style.outline;
    el.style.outline = '3px solid magenta';
    setTimeout(() => { clickFn(); }, before);
    setTimeout(() => {
      if (document.contains(el)) el.style.outline = prev || '';
      onDone();
    }, dur);
  }

  /**
   * Return the chat’s UL.tablist
   * @returns {HTMLUListElement|null}
   */
   function findChatTabList() {
     // grab only visible tablists
    const lists = Array.from(
      document.querySelectorAll('ul.actions-container[role="tablist"]')
    ).filter(el => el.offsetParent !== null);

    // pick the one whose any ancestor has class="right pane-composite-part"
    for (const ul of lists) {
      if (ul.closest('.right.pane-composite-part')) {
        return ul;
      }
    }

    return null;
  }

  /**
   * Whether an element is visible in the layout flow.
   * @param {Element|null} el
   * @returns {boolean}
   */
  function isVisible (el) {
    return !!(el instanceof HTMLElement && el.offsetParent);
  }

  /* ───────────── 1. “Resume conversation” WATCHER ───────────── */

  /**
   * Clicks the “resume the conversation” link in the 25-tool-call banner.
   * Runs once per second and uses a 3 s cooldown.
   */
  function resumeWatcher () {
    if (resumeBusy || Date.now() - lastResumeClick < 3000) return;

    for (const el of document.querySelectorAll('body *')) {
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
          () => { link.click(); lastResumeClick = Date.now(); showToast('🟢 Resumed conversation'); },
          1000, 3000,
          () => { resumeBusy = false; }
        );
        break;
      }
    }
  }

  /* ───────────── 2. “Connection failed” WATCHER ───────────── */

  /**
   * Detects “Connection failed.” banner and retries with exponential back-off.
   * Looks for either a visible “Try again” button or the last retry icon.
   */
  function retryWatcher () {
    if (retryBusy || Date.now() < nextRetryAfter) return;

    const failSpan = Array.from(document.querySelectorAll('span'))
      .find(s => s.textContent.trim().startsWith('Connection failed.'));

    if (!failSpan) { retryDelay = 1_000; nextRetryAfter = 0; return; }

    const banner = failSpan.closest('div') || failSpan;
    const tryBtn = Array.from(banner.querySelectorAll('button,[role="button"],a,span'))
      .find(el => /try again/i.test(el.textContent) && isVisible(el));

    /**
     * Click `node`, show toast, update back-off timers.
     * @param {HTMLElement} node
     * @param {string} label
     */
    const clickAndBackoff = (node, label) => {
      node.click();
      nextRetryAfter = Date.now() + retryDelay;
      retryDelay = Math.min(retryDelay * 2, 5 * 60_000);
      showToast(`🔄 ${label} (next ${retryDelay / 1000}s)`);
    };

    retryBusy = true;

    if (tryBtn) {
      previewAndClick(tryBtn, () => clickAndBackoff(tryBtn, 'Clicked “Try again”'),
                      1000, 3000, () => { retryBusy = false; });
      return;
    }

    const iconBtn = Array.from(document.querySelectorAll('div.anysphere-icon-button'))
      .filter(btn => isVisible(btn) && !btn.closest('.full-input-box'))
      .at(-1);

    if (iconBtn) {
      previewAndClick(iconBtn, () => clickAndBackoff(iconBtn, 'Retried via icon'),
                      1000, 3000, () => { retryBusy = false; });
      return;
    }

    retryBusy = false;
  }

  /* ───────────── 3. IDLE WATCHER & TAB CYCLER ─────────────── */

  /** User-generated events that count as “activity.” */
  const USER_EVENTS = ['mousedown', 'keydown', 'wheel', 'touchstart', 'pointerdown'];

  USER_EVENTS.forEach(evt =>
    window.addEventListener(evt, ev => {
      if (!ev.isTrusted) return;               // ignore synthetic clicks
      lastUserActivity = Date.now();
      if (idleToastShown || preCycleToastShown) showToast('🔄 Idle countdown reset');
      idleToastShown = preCycleToastShown = false;
    }, { passive: true })
  );

  /**
   * Sequentially switch through `tabs`, keeping each open `TAB_DELAY` ms.
   * @param {HTMLElement[]} tabs
   */
  function cycleTabs (tabs) {
    let idx = 0;
    const next = () => {
      if (idx >= tabs.length) {
        showToast('🔄 Idle tab cycle complete');
        lastUserActivity = Date.now();
        isCyclingTabs = false;
        return;
      }
      const tab = tabs[idx++];
      const label = tab.textContent.trim() || `Tab ${idx}`;
      showToast(`📂 ${label}`);
      previewAndClick(
        tab,
        () => tab.click(),
        1000, 3000,
        () => setTimeout(next, TAB_DELAY)
      );
    };
    next();
  }

  /**
   * Periodic checker that starts tab-cycling after `IDLE_TIMEOUT` ms.
   */
  function idleWatcher () {
    if (isCyclingTabs) return;
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

    isCyclingTabs = true;
    idleToastShown = preCycleToastShown = false;
    showToast(`🔄 Idle detected – cycling ${tabs.length} tab${tabs.length > 1 ? 's' : ''}`);
    highlightElement(ul, 3000);
    cycleTabs(tabs);
  }

  /* ──────────────────── PUBLIC API & BOOTSTRAP ─────────────────── */

  /**
   * Start all watchers (called automatically on load).
   * @param {boolean} [silent=false] – suppress initial toast
   */
  function start (silent = false) {
    stop(true);
    intervals.push(setInterval(resumeWatcher, 1000));
    intervals.push(setInterval(retryWatcher , 1000));
    intervals.push(setInterval(idleWatcher  , IDLE_CHECK_INTERVAL));
    resumeWatcher(); retryWatcher(); idleWatcher();
    if (!silent) showToast('🚀 CursorAutoHelper started');
  }

  /**
   * Stop all watchers, clear timers, reset state.
   * @param {boolean} [silent=false] – suppress toast
   */
  function stop (silent = false) {
    intervals.forEach(clearInterval); intervals.length = 0;
    retryBusy = resumeBusy = isCyclingTabs = false;
    retryDelay = 1_000; nextRetryAfter = lastResumeClick = 0;
    idleToastShown = preCycleToastShown = false;
    if (!silent) showToast('🛑 CursorAutoHelper stopped');
  }

  /**
   * Extremist debug helper – clears *every* setInterval on the page.
   */
  function clearAllIntervals () {
    const max = setInterval(() => {}, 9999);
    for (let i = max; i >= 0; --i) clearInterval(i);
    intervals.length = 0;
    alert('💥 All intervals cleared – reload or paste helper again.');
  }

  /**
   * Enable or disable debug logging.
   * @param {boolean} on
   */
  function setDebug (on) {
    debugAlerts = !!on;
    alert('Debug ' + (debugAlerts ? 'ENABLED' : 'disabled'));
  }

  /* Export & launch */
  window[KEY] = { start, stop, showToast, setDebug, clearAllIntervals };
  start(true);
  showToast('🔧 CursorAutoHelper v5.2 loaded');
})();
