// GV Sheet Helper — Google Voice content script.
//
// Prepares and sends ONE message per job:
//   check page -> open composer -> enter number -> confirm recipient ->
//   enter message -> verify -> ask the background for permission (commit) ->
//   press Send -> watch the conversation for the outcome -> report.
//
// Rules this file follows:
//  - Send is pressed at most once per job, and only after the background has
//    recorded that it is about to happen.
//  - Nothing after the click is ever retried. If the outcome can't be
//    observed, the result is "unknown", never "failed".
//  - Enter is never pressed in the message box (it would send).
//  - Phone numbers and message text are never written to the console.
//
// Selectors live in gv-selectors.js (loaded first).

(() => {
  'use strict';

  const S = globalThis.GVSH_SELECTORS;
  if (!S) {
    console.error('[GV Sheet Helper] gv-selectors.js did not load.');
    return;
  }

  // Replace an older copy of this script (re-injection after an extension reload).
  try {
    globalThis.__gvshContent?.dispose();
  } catch {
    /* the old copy belonged to an unloaded extension */
  }

  // Must match CONTENT in lib/protocol.js (enforced by tests/protocol.test.js).
  const MSG = Object.freeze({
    PING: 'gv:ping',
    SEND: 'gv:send',
    ABORT: 'gv:abort',
    DIAGNOSE: 'gv:diagnose',
    PROGRESS: 'gv:progress',
    COMMIT: 'gv:commit',
    RESULT: 'gv:result',
  });

  const TIMEOUTS = Object.freeze({
    appReady: 20_000,
    element: 10_000,
    option: 6_000,
    recipientConfirm: 8_000,
    composer: 10_000,
    sendEnabled: 5_000,
    commitAck: 8_000,
    accept: 20_000,
    settle: 25_000,
  });
  const MAX_PREPARE_ATTEMPTS = 2;
  // Longest a message is typed character by character; two attempts plus the
  // other steps must fit in the background's 100 s commit window.
  const TYPING_BUDGET_MS = 20_000;
  const MESSAGE_MAX_CHARS = 5000;

  let current = null; // job being processed
  let lastJob = null; // outcome of the most recent job (no phone numbers or text)

  const debug = (...args) => console.debug('[GV Sheet Helper]', ...args);

  class GvError extends Error {
    constructor(code, detail = null, { retryable = false } = {}) {
      super(detail || code);
      this.code = code;
      this.detail = detail;
      this.retryable = retryable;
    }
  }

  // -------------------------------------------------------------------------
  // DOM helpers

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function isDisabled(el) {
    return (
      Boolean(el.disabled) ||
      el.getAttribute('aria-disabled') === 'true' ||
      Boolean(el.closest('[disabled], [aria-disabled="true"]'))
    );
  }

  /** Accessible name, for matching button labels. */
  const labelOf = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim();

  /** Everything readable on an element, for finding phone numbers. */
  const fullText = (el) =>
    [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ');

  function queryTarget(target, { root = document, visibleOnly = true } = {}) {
    const found = [];
    const seen = new Set();
    const add = (el) => {
      if (!seen.has(el)) {
        seen.add(el);
        found.push(el);
      }
    };
    for (const selector of target.css || []) {
      try {
        root.querySelectorAll(selector).forEach(add);
      } catch {
        debug(`invalid selector skipped: ${selector}`);
      }
    }
    if (target.text) {
      root.querySelectorAll(target.text.selector).forEach((el) => {
        const label = labelOf(el);
        if (label.length <= 120 && target.text.patterns.some((p) => p.test(label))) add(el);
      });
    }
    return visibleOnly ? found.filter(isVisible) : found;
  }

  const first = (target, options) => queryTarget(target, options)[0] || null;

  function clickable(el) {
    if (!el) return null;
    if (el.matches('button, a, input, [role="button"], [role="option"]')) return el;
    return el.querySelector('button, [role="button"]') || el;
  }

  /**
   * Resolve with probe()'s first truthy value, or null after `timeout` ms.
   * Re-checks on DOM mutations (not throttled in background tabs) and on an
   * interval. Rejects with ABORTED as soon as the job is aborted.
   */
  function waitFor(probe, { timeout, ctx = null, interval = 200 } = {}) {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      let settled = false;
      let lastRun = 0;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(timer);
        fn(value);
      };
      const check = () => {
        if (settled) return;
        if (ctx?.aborted) {
          finish(reject, new GvError('ABORTED', 'Stopped before sending.'));
          return;
        }
        let value = null;
        try {
          value = probe();
        } catch (err) {
          if (err instanceof GvError) {
            finish(reject, err);
            return;
          }
        }
        if (value) finish(resolve, value);
        else if (performance.now() - started >= timeout) finish(resolve, null);
      };
      const observer = new MutationObserver(() => {
        const now = performance.now();
        if (now - lastRun < 60) return;
        lastRun = now;
        check();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const timer = setInterval(check, interval);
      check();
    });
  }

  const readValue = (el) => (el.isContentEditable ? el.innerText : el.value ?? '');
  const normalizeText = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Replace a field's text the way typing would: execCommand fires real
   * input events that Angular listens to. Falls back to the native setter.
   * Never sends key events, so a newline can't trigger Send.
   */
  function replaceFieldText(el, value) {
    el.focus();
    if (el.isContentEditable) document.getSelection()?.selectAllChildren(el);
    else if (typeof el.select === 'function') el.select();

    let inserted = false;
    try {
      inserted = value === '' ? document.execCommand('delete') : document.execCommand('insertText', false, value);
    } catch {
      inserted = false;
    }
    if (!inserted || normalizeText(readValue(el)) !== normalizeText(value)) {
      if (el.isContentEditable) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        setNativeValue(el, value);
      }
    }
    return normalizeText(readValue(el)) === normalizeText(value);
  }

  function pressKey(el, key) {
    const keyCode = { Enter: 13, Escape: 27 }[key];
    const init = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true };
    for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, init));
  }

  // -------------------------------------------------------------------------
  // Human-like activity simulation (Mouse, Typing, Pauses, Scrolling, Context)

  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randFloat = (min, max) => Math.random() * (max - min) + min;

  // Virtual cursor state to ensure movements carry over across interactions
  const virtualCursor = {
    x: typeof window !== 'undefined' ? randInt(100, Math.min(window.innerWidth || 800, 500)) : 200,
    y: typeof window !== 'undefined' ? randInt(100, Math.min(window.innerHeight || 600, 400)) : 200,
  };

  /**
   * 1. Natural mouse movement:
   * Moves cursor along a randomized cubic Bezier curved path, varies speed and acceleration
   * (cubic ease-in-out), pauses briefly before clicking, and avoids repeating identical paths.
   */
  async function simulateCurvedMouseMove(targetEl, { ctx = null } = {}) {
    if (!targetEl || typeof targetEl.getBoundingClientRect !== 'function') return;
    try {
      targetEl.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } catch {
      /* ignore scroll error */
    }
    const rect = targetEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    // Pick target point within target element bounds (avoiding exact edges and exact center)
    const targetX = rect.left + rect.width * randFloat(0.25, 0.75);
    const targetY = rect.top + rect.height * randFloat(0.25, 0.75);

    const startX = virtualCursor.x;
    const startY = virtualCursor.y;
    const dx = targetX - startX;
    const dy = targetY - startY;
    const distance = Math.hypot(dx, dy);

    // Number of intermediate steps scaled by distance (min 4, max 14)
    const steps = Math.min(14, Math.max(4, Math.round(distance / 45)));

    // Generate random perpendicular deviations for cubic Bezier control points
    const angle = Math.atan2(dy, dx);
    const deviation1 = (Math.random() - 0.5) * Math.min(120, distance * 0.4);
    const deviation2 = (Math.random() - 0.5) * Math.min(120, distance * 0.4);

    const cp1X = startX + dx * 0.28 + Math.sin(angle) * deviation1;
    const cp1Y = startY + dy * 0.28 - Math.cos(angle) * deviation1;
    const cp2X = startX + dx * 0.72 + Math.sin(angle) * deviation2;
    const cp2Y = startY + dy * 0.72 - Math.cos(angle) * deviation2;

    // Cubic ease-in-out for realistic acceleration and deceleration
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    for (let i = 1; i <= steps; i++) {
      if (ctx?.aborted) return;
      const t = ease(i / steps);
      const u = 1 - t;
      const x = u * u * u * startX + 3 * u * u * t * cp1X + 3 * u * t * t * cp2X + t * t * t * targetX + (Math.random() - 0.5) * 1.5;
      const y = u * u * u * startY + 3 * u * u * t * cp1Y + 3 * u * t * t * cp2Y + t * t * t * targetY + (Math.random() - 0.5) * 1.5;

      virtualCursor.x = Math.round(x);
      virtualCursor.y = Math.round(y);

      const underCursor = document.elementFromPoint(virtualCursor.x, virtualCursor.y) || targetEl;
      try {
        underCursor.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: virtualCursor.x,
            clientY: virtualCursor.y,
          })
        );
      } catch {
        /* ignore event dispatch failure */
      }
      await sleep(randInt(8, 18));
    }

    virtualCursor.x = Math.round(targetX);
    virtualCursor.y = Math.round(targetY);
    try {
      targetEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: virtualCursor.x, clientY: virtualCursor.y }));
      targetEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: virtualCursor.x, clientY: virtualCursor.y }));
    } catch {
      /* ignore */
    }
  }

  /**
   * Natural click:
   * Moves cursor naturally to the target, pauses briefly before clicking,
   * emits mousedown/mouseup sequence, and triggers click.
   */
  async function naturalClick(el, { ctx = null, prePause = true } = {}) {
    if (!el) return;
    const target = clickable(el);
    if (!target) return;

    await simulateCurvedMouseMove(target, { ctx });
    if (ctx?.aborted) return;

    // Pause briefly before clicking (human hesitation / visual settle)
    if (prePause) {
      await sleep(randInt(75, 180));
    }
    if (ctx?.aborted) return;

    try {
      target.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: virtualCursor.x,
          clientY: virtualCursor.y,
          buttons: 1,
        })
      );
      await sleep(randInt(40, 95));
      target.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: virtualCursor.x,
          clientY: virtualCursor.y,
          buttons: 0,
        })
      );
    } catch {
      /* ignore */
    }

    target.click();
    await sleep(randInt(40, 80));
  }

  /**
   * 2. Human-like typing:
   * - Type text in small chunks (1-3 chars).
   * - Variable pauses between words or sentences (longer on punctuation).
   * - Occasional review pauses.
   * - Realistic editing behavior when correcting mistakes (small typo, notice pause, backspace, correct char).
   */
  async function simulateHumanTyping(el, text, { ctx = null, isPhone = false } = {}) {
    el.focus();
    if (el.isContentEditable) document.getSelection()?.selectAllChildren(el);
    else if (typeof el.select === 'function') el.select();

    try {
      document.execCommand('delete');
    } catch {
      /* ignore */
    }

    const value = String(text ?? '');
    if (!value) {
      replaceFieldText(el, '');
      return true;
    }

    // Phone numbers: type in realistic digit chunks (area code, prefix, line number)
    if (isPhone) {
      let typedSoFar = '';
      const clean = value.trim();
      let i = 0;
      while (i < clean.length) {
        if (ctx?.aborted) return false;
        // 1 to 2 digits at a time
        const chunkLen = Math.min(randInt(1, 2), clean.length - i);
        const chunk = clean.slice(i, i + chunkLen);
        i += chunkLen;
        typedSoFar += chunk;

        let ok = false;
        try {
          ok = document.execCommand('insertText', false, chunk);
        } catch {
          ok = false;
        }
        if (!ok) {
          if (el.isContentEditable) {
            el.textContent = typedSoFar;
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          } else {
            setNativeValue(el, typedSoFar);
          }
        }
        // Micro pause between digits, slightly longer after 3rd and 6th digit
        const isGroupBreak = i === 3 || i === 6 || (clean.startsWith('+1') && (i === 2 || i === 5 || i === 8));
        await sleep(isGroupBreak ? randInt(100, 200) : randInt(35, 75));
      }
      const digitsOnly = (s) => String(s ?? '').replace(/\D/g, '');
      const ok = digitsOnly(readValue(el)) === digitsOnly(value) || normalizeText(readValue(el)) === normalizeText(value);
      return ok || replaceFieldText(el, value);
    }

    // Message text: realistic typing simulation
    let currentText = '';
    let charsSinceReview = 0;
    const reviewInterval = randInt(40, 80);
    const typingStarted = performance.now();

    let idx = 0;
    while (idx < value.length) {
      if (ctx?.aborted) return false;

      // Typing runs at roughly 55 ms a character, so a long message would use
      // up the time the background allows for preparing it. Past the budget,
      // the rest goes in at once (the result is verified below either way).
      if (performance.now() - typingStarted > TYPING_BUDGET_MS) {
        const rest = value.slice(idx);
        let inserted = false;
        try {
          inserted = document.execCommand('insertText', false, rest);
        } catch {
          inserted = false;
        }
        if (!inserted) replaceFieldText(el, value);
        break;
      }

      // Occasional realistic editing behavior (small typo, pause, backspace, correct char)
      // Only for longer texts (>20 chars), rarely (~1.5% chance per word boundary), never on newlines or near end
      const isWordBoundary = idx > 5 && idx < value.length - 8 && value[idx] === ' ';
      if (isWordBoundary && Math.random() < 0.02) {
        const typoChar = String.fromCharCode(randInt(97, 122)); // random a-z typo
        try {
          document.execCommand('insertText', false, typoChar);
        } catch {}
        await sleep(randInt(140, 260)); // pause to "notice" the mistake
        try {
          document.execCommand('delete');
        } catch {}
        await sleep(randInt(70, 150)); // pause before resuming correct input
      }

      // Small chunk (1 to 3 characters)
      const nextChar = value[idx];
      let chunk = nextChar;
      idx += 1;
      if (idx < value.length && !/[\s.,!?;:\n]/.test(nextChar) && Math.random() < 0.4) {
        chunk += value[idx];
        idx += 1;
      }

      currentText += chunk;
      charsSinceReview += chunk.length;

      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, chunk);
      } catch {
        inserted = false;
      }
      if (!inserted) {
        if (el.isContentEditable) {
          el.textContent = currentText;
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } else {
          setNativeValue(el, currentText);
        }
      }

      // Variable cadence based on punctuation and structure
      const lastChar = chunk[chunk.length - 1];
      if (/[.!?\n]/.test(lastChar)) {
        await sleep(randInt(180, 380)); // Sentence pause
      } else if (/[,;:—-]/.test(lastChar)) {
        await sleep(randInt(90, 180)); // Clause pause
      } else if (lastChar === ' ') {
        await sleep(randInt(60, 130)); // Word pause
      } else {
        await sleep(randInt(25, 55)); // Normal keystroke
      }

      // Occasional reading/review pause during long message entry
      if (charsSinceReview >= reviewInterval) {
        charsSinceReview = 0;
        await sleep(randInt(240, 480));
      }
    }

    // Integrity guarantee: Ensure final text matches the exact intended text
    if (normalizeText(readValue(el)) !== normalizeText(value)) {
      replaceFieldText(el, value);
    }
    return normalizeText(readValue(el)) === normalizeText(value);
  }

  /**
   * 3. Reading and thinking pauses:
   * Dynamically pauses based on the context/task (page readiness, form inspection,
   * proofreading scaled to text length).
   */
  async function readingPause(task, ctx, extra = {}) {
    if (ctx?.aborted) return;
    let ms = 200;
    switch (task) {
      case 'page_ready':
        ms = randInt(350, 700); // Reading/orienting after page view
        break;
      case 'inspect_composer':
        ms = randInt(250, 500); // Visual check of the new composer
        break;
      case 'read_recipient':
        ms = randInt(200, 400); // Reading the suggestion before selecting
        break;
      case 'compose_start':
        ms = randInt(250, 500); // Thinking before starting to type message
        break;
      case 'review_before_send': {
        const textLen = (extra.message || '').length;
        // Longer pause for longer message, shorter for simple message
        ms = Math.min(1400, Math.max(300, Math.round(textLen * 5 + randInt(200, 400))));
        break;
      }
      default:
        ms = randInt(180, 350);
    }
    await sleep(ms);
  }

  /**
   * 4. Natural scrolling:
   * Scrolls smoothly in multiple increments rather than jumping to bottom,
   * pauses to inspect relevant sections, and occasionally micro-scrolls back up.
   */
  async function simulateNaturalScroll(container, targetScrollTop, { ctx = null, inspect = false } = {}) {
    if (!container) return;
    const startTop = container.scrollTop;
    const delta = targetScrollTop - startTop;
    if (Math.abs(delta) < 10) return;

    const steps = Math.min(10, Math.max(4, Math.round(Math.abs(delta) / 60)));
    const ease = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

    for (let step = 1; step <= steps; step++) {
      if (ctx?.aborted) return;
      const t = ease(step / steps);
      container.scrollTop = Math.round(startTop + delta * t);
      await sleep(randInt(18, 42));
    }

    // When inspecting content (e.g. checking conversation history):
    if (inspect && Math.abs(delta) > 50) {
      await sleep(randInt(120, 220)); // Pause to inspect
      // Micro-scroll back up slightly to re-check content
      if (Math.random() < 0.35 && container.scrollTop > 30) {
        const microBack = randInt(20, 45);
        container.scrollTop = Math.max(0, container.scrollTop - microBack);
        await sleep(randInt(100, 180));
        container.scrollTop = targetScrollTop;
      }
    }
  }

  /**
   * 5. Context-aware interaction:
   * Checks whether element is interactable (visible, in viewport, not disabled or obstructed).
   */
  function isInteractable(el) {
    if (!isVisible(el) || isDisabled(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const inViewport = (
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.left <= (window.innerWidth || document.documentElement.clientWidth)
    );
    return inViewport;
  }

  // -------------------------------------------------------------------------
  // Phone numbers and message text matching

  /** Digit strings of every phone-number-looking run in `text`. */
  const phoneSequences = (text) =>
    (String(text).match(/\+?\d[\d\s().-]{5,}\d/g) || []).map((s) => s.replace(/\D/g, ''));

  function digitsMatch(found, job) {
    if (!job.international) return found === job.digits || found === `1${job.digits}`;
    return found === job.digits || (found.length >= 7 && job.digits.endsWith(found));
  }

  const fingerprint = (s) => String(s ?? '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  // -------------------------------------------------------------------------
  // Page state

  function pageState() {
    if (location.hostname !== 'voice.google.com') return 'not_voice';
    if (/^\/(?:u\/\d+\/)?signup\b/.test(location.pathname)) return 'not_set_up';
    if (queryTarget(S.appShell).length) return 'ready';
    if (/^\/(?:about|intl)\b/.test(location.pathname) || queryTarget(S.signedOut).length) return 'signed_out';
    return 'loading';
  }

  async function ensureAppReady(ctx) {
    const state = await waitFor(
      () => {
        const s = pageState();
        return s === 'loading' ? null : s;
      },
      { timeout: TIMEOUTS.appReady, ctx },
    );
    if (state === 'ready') return;
    if (state === 'signed_out') throw new GvError('NOT_SIGNED_IN');
    if (state === 'not_set_up') throw new GvError('NOT_SET_UP');
    if (state === 'not_voice') throw new GvError('NOT_VOICE_PAGE');
    throw new GvError('PAGE_NOT_READY', null, { retryable: true });
  }

  function assertNoBlockingDialog() {
    const blocking = queryTarget(S.blockingDialog).filter(
      (d) => !queryTarget(S.recipientInput, { root: d }).length && !queryTarget(S.messageInput, { root: d }).length,
    );
    if (blocking.length) throw new GvError('BLOCKING_DIALOG', labelOf(blocking[0]).slice(0, 120) || null);
  }

  // -------------------------------------------------------------------------
  // Steps

  function checkpoint(ctx) {
    if (ctx.aborted) throw new GvError('ABORTED', 'Stopped before sending.');
    if (Date.now() > ctx.commitBy) throw new GvError('TIMEOUT', 'Ran out of time preparing the message.');
  }

  function reportStep(ctx, step) {
    checkpoint(ctx);
    ctx.step = step;
    debug(`step: ${step}`);
    notify({ type: MSG.PROGRESS, jobId: ctx.jobId, stage: 'preparing', step }, 1);
  }

  async function ensureMessagesView(ctx) {
    if (/\/messages\b/.test(location.pathname)) return;
    const link = first(S.messagesNavLink);
    if (!link) return; // the new-message button may still be reachable
    await naturalClick(link, { ctx });
    await waitFor(() => /\/messages\b/.test(location.pathname), { timeout: TIMEOUTS.element, ctx });
    await readingPause('page_ready', ctx);
  }

  async function openNewMessage(ctx) {
    const button = await waitFor(
      () => {
        const el = clickable(first(S.newMessageButton));
        return el && !isDisabled(el) ? el : null;
      },
      { timeout: TIMEOUTS.element, ctx },
    );
    if (!button) throw new GvError('NEW_MESSAGE_NOT_FOUND', null, { retryable: true });
    await naturalClick(button, { ctx });

    const input = await waitFor(
      () => {
        const el = first(S.recipientInput);
        return el && !isDisabled(el) ? el : null;
      },
      { timeout: TIMEOUTS.element, ctx },
    );
    if (!input) throw new GvError('RECIPIENT_FIELD_NOT_FOUND', null, { retryable: true });

    // A fresh composer has no recipients. A leftover one could turn this into a group message.
    const clean = await waitFor(() => queryTarget(S.recipientChip).length === 0, { timeout: 1500, ctx });
    if (!clean) throw new GvError('RECIPIENT_MISMATCH', 'A recipient was already selected in the composer.', { retryable: true });
    ctx.recipientInput = input;
    await readingPause('inspect_composer', ctx);
    return input;
  }

  async function enterRecipient(ctx, input, job) {
    checkpoint(ctx);
    // Human-like typing simulation for recipient phone number
    const typed = await simulateHumanTyping(input, job.dial, { ctx, isPhone: true });
    if (!typed && !replaceFieldText(input, job.dial)) {
      throw new GvError('RECIPIENT_FIELD_NOT_FOUND', 'The recipient field did not accept the number.', { retryable: true });
    }
    const option = await waitFor(
      () =>
        queryTarget(S.recipientOption).find((el) => phoneSequences(fullText(el)).some((d) => digitsMatch(d, job))) || null,
      { timeout: TIMEOUTS.option, ctx },
    );
    if (option) {
      await readingPause('read_recipient', ctx);
      checkpoint(ctx);
      await naturalClick(option, { ctx });
      ctx.pickedMatchingOption = true;
    } else {
      // No suggestion showed this number; let Google Voice resolve what was typed.
      await sleep(randInt(80, 160));
      pressKey(input, 'Enter');
      ctx.pickedMatchingOption = false;
    }
  }

  async function verifyRecipient(ctx, job) {
    const verdict = await waitFor(
      () => {
        const rejected = first(S.recipientError);
        if (rejected) return { error: 'RECIPIENT_REJECTED', detail: labelOf(rejected).slice(0, 120) };
        const chips = queryTarget(S.recipientChip);
        if (chips.length > 1) return { error: 'RECIPIENT_MISMATCH', detail: `${chips.length} recipients are selected.` };
        if (chips.length === 1) {
          const numbers = phoneSequences(fullText(chips[0]));
          if (numbers.some((d) => digitsMatch(d, job))) return { ok: true };
          if (numbers.length) return { error: 'RECIPIENT_MISMATCH', detail: 'The selected recipient has a different number.' };
          // Saved contacts show a name rather than the number. Accept only if
          // the suggestion we clicked showed exactly this number.
          return ctx.pickedMatchingOption ? { ok: true } : null;
        }
        const header = queryTarget(S.conversationHeader).find((h) =>
          phoneSequences(fullText(h)).some((d) => digitsMatch(d, job)),
        );
        return header ? { ok: true } : null;
      },
      { timeout: TIMEOUTS.recipientConfirm, ctx },
    );
    if (!verdict) throw new GvError('RECIPIENT_NOT_CONFIRMED', null, { retryable: true });
    if (verdict.error) {
      throw new GvError(verdict.error, verdict.detail, { retryable: verdict.error === 'RECIPIENT_MISMATCH' });
    }
  }

  async function waitForComposer(ctx) {
    const input = await waitFor(
      () => {
        const el = first(S.messageInput);
        return el && !isDisabled(el) ? el : null;
      },
      { timeout: TIMEOUTS.composer, ctx },
    );
    if (!input) throw new GvError('MESSAGE_FIELD_NOT_FOUND', null, { retryable: true });
    ctx.messageInput = input;
    return input;
  }

  async function enterMessage(ctx, input, message) {
    checkpoint(ctx);
    await readingPause('compose_start', ctx);
    checkpoint(ctx);
    const typed = await simulateHumanTyping(input, message, { ctx });
    if (!typed || normalizeText(readValue(input)) !== normalizeText(message)) {
      if (!replaceFieldText(input, message)) {
        const got = normalizeText(readValue(input)).length;
        throw new GvError(
          'MESSAGE_TEXT_MISMATCH',
          `The message box holds ${got} of ${normalizeText(message).length} characters.`,
          { retryable: true },
        );
      }
    }
  }

  function findSendButton(input) {
    let node = input;
    for (let depth = 0; node && depth < 8; depth++) {
      node = node.parentElement;
      if (!node) break;
      const match = first(S.sendButton, { root: node });
      if (match) return clickable(match);
    }
    return clickable(first(S.sendButton));
  }

  async function verifyReadyToSend(ctx, job) {
    if (normalizeText(readValue(ctx.messageInput)) !== normalizeText(job.message)) {
      throw new GvError('MESSAGE_TEXT_MISMATCH', 'The message text changed after it was entered.', { retryable: true });
    }
    const button = await waitFor(
      () => {
        const el = findSendButton(ctx.messageInput);
        return el && !isDisabled(el) ? el : null;
      },
      { timeout: TIMEOUTS.sendEnabled, ctx },
    );
    if (!button) {
      throw new GvError(findSendButton(ctx.messageInput) ? 'SEND_DISABLED' : 'SEND_BUTTON_NOT_FOUND', null, { retryable: true });
    }
    // Context-aware reading and review pause before sending: scales with message length
    await readingPause('review_before_send', ctx, { message: job.message });
    checkpoint(ctx);

    // Entering the message must not have changed who it goes to.
    await verifyRecipient(ctx, job);
    assertNoBlockingDialog();
  }

  async function resetComposer() {
    const active = document.activeElement;
    if (active && active !== document.body) {
      pressKey(active, 'Escape');
      active.blur?.();
    }
    await sleep(500);
    const link = first(S.messagesNavLink);
    if (link) await naturalClick(link);
    await sleep(800);
  }

  async function prepare(ctx, job) {
    reportStep(ctx, 'check_page');
    if (location.hostname !== 'voice.google.com') throw new GvError('NOT_VOICE_PAGE');
    await ensureAppReady(ctx);
    assertNoBlockingDialog();
    await ensureMessagesView(ctx);

    reportStep(ctx, 'open_composer');
    const recipientInput = await openNewMessage(ctx);

    reportStep(ctx, 'enter_recipient');
    await enterRecipient(ctx, recipientInput, job);

    reportStep(ctx, 'verify_recipient');
    await verifyRecipient(ctx, job);

    reportStep(ctx, 'enter_message');
    const messageInput = await waitForComposer(ctx);
    await enterMessage(ctx, messageInput, job.message);

    reportStep(ctx, 'verify_message');
    await verifyReadyToSend(ctx, job);
  }

  // -------------------------------------------------------------------------
  // Observing the outcome after Send

  function threadItems() {
    const container = first(S.threadContainer);
    let items = queryTarget(S.messageItem, { root: container || document });
    if (!container) {
      const lists = queryTarget(S.conversationList, { visibleOnly: false });
      items = items.filter((el) => !lists.some((list) => list.contains(el)));
    }
    return items;
  }

  function snapshotThread(message) {
    const fp = fingerprint(message).slice(0, 120);
    const items = threadItems();
    return {
      fp,
      total: items.length,
      matching: fp ? items.filter((el) => fingerprint(el.textContent).includes(fp)).length : 0,
    };
  }

  function findNewBubble(before) {
    const items = threadItems();
    if (before.fp) {
      const matching = items.filter((el) => fingerprint(el.textContent).includes(before.fp));
      return matching.length > before.matching ? matching[matching.length - 1] : null;
    }
    return items.length > before.total ? items[items.length - 1] : null;
  }

  /** 'sending' | 'failed' | 'settled', judged from status text near the bubble. */
  function bubbleStatus(bubble, message) {
    const scope = [bubble, bubble.nextElementSibling].filter(Boolean);
    const statusEls = scope.flatMap((el) => queryTarget(S.messageStatus, { root: el }));
    let text;
    if (statusEls.length) {
      text = statusEls.map(labelOf).join(' ');
    } else {
      const body = normalizeText(message).replace(/\s+/g, ' ');
      text = scope.map((el) => el.textContent.replace(/\s+/g, ' ')).join(' ').split(body).join(' ');
    }
    if (S.patterns.failed.test(text)) return 'failed';
    if (S.patterns.sending.test(text)) return 'sending';
    return 'settled';
  }

  async function confirmSend(ctx, job, before, toastsBefore) {
    const appeared = await waitFor(
      () => {
        const bubble = findNewBubble(before);
        if (bubble) return { bubble };
        const toast = queryTarget(S.errorToast).find((el) => !toastsBefore.has(el) && S.patterns.failed.test(labelOf(el)));
        return toast ? { failed: labelOf(toast).slice(0, 120) } : null;
      },
      { timeout: TIMEOUTS.accept },
    );
    if (!appeared) {
      const input = ctx.messageInput;
      const cleared = !input.isConnected || normalizeText(readValue(input)) === '';
      return {
        outcome: 'unknown',
        code: 'SEND_UNCONFIRMED',
        detail: cleared
          ? 'The message box cleared, but the message did not appear in the conversation.'
          : 'Google Voice did not react to the Send button.',
      };
    }
    if (appeared.failed) return { outcome: 'failed', code: 'SEND_FAILED', detail: appeared.failed };

    if (appeared.bubble) {
      const container = first(S.threadContainer);
      if (container) {
        await simulateNaturalScroll(container, container.scrollHeight, { ctx, inspect: true });
      }
    }

    // "Sending…" can appear a moment after the bubble; don't judge too early.
    await sleep(2000);
    let bubble = appeared.bubble;
    const status = await waitFor(
      () => {
        if (!bubble.isConnected) bubble = findNewBubble(before) || bubble;
        if (!bubble.isConnected) return null;
        const s = bubbleStatus(bubble, job.message);
        return s === 'sending' ? null : s;
      },
      { timeout: TIMEOUTS.settle },
    );
    if (status === 'failed') return { outcome: 'failed', code: 'SEND_FAILED' };
    if (status === 'settled') return { outcome: 'accepted' };
    return { outcome: 'unknown', code: 'SEND_UNCONFIRMED', detail: 'The message still showed "Sending" after 25 seconds.' };
  }

  // -------------------------------------------------------------------------
  // Job runner

  async function performSend(ctx, job) {
    for (let attempt = 1; ; attempt++) {
      try {
        await prepare(ctx, job);
        break;
      } catch (err) {
        if (!(err instanceof GvError) || !err.retryable || attempt >= MAX_PREPARE_ATTEMPTS || ctx.aborted) throw err;
        debug(`attempt ${attempt} failed (${err.code}); retrying`);
        reportStep(ctx, 'retrying');
        await resetComposer();
      }
    }

    checkpoint(ctx);
    notify({ type: MSG.PROGRESS, jobId: ctx.jobId, stage: 'prepared', step: 'verify_message' }, 1);

    // Two-phase commit: the background records "sending" before saying yes.
    const gate = await requestCommit(ctx);
    if (gate?.proceed !== true || ctx.aborted) throw new GvError('ABORTED', 'The send was not confirmed by the extension.');
    ctx.committed = true;

    // Final look immediately before pressing Send.
    const button = findSendButton(ctx.messageInput);
    if (!button || isDisabled(button)) throw new GvError('SEND_DISABLED');
    if (normalizeText(readValue(ctx.messageInput)) !== normalizeText(job.message)) {
      throw new GvError('MESSAGE_TEXT_MISMATCH', 'The message text changed just before sending.');
    }
    const before = snapshotThread(job.message);
    const toastsBefore = new Set(queryTarget(S.errorToast));

    ctx.clicked = true; // set first: if click() throws, the outcome is still ambiguous
    debug('pressing Send');
    await naturalClick(button, { ctx, prePause: true });
    reportProgressQuietly(ctx);
    return confirmSend(ctx, job, before, toastsBefore);
  }

  function reportProgressQuietly(ctx) {
    notify({ type: MSG.PROGRESS, jobId: ctx.jobId, stage: 'heartbeat' }, 1);
  }

  async function runJob(job) {
    const ctx = {
      jobId: job.jobId,
      commitBy: job.commitBy,
      aborted: false,
      committed: false,
      clicked: false,
      step: null,
      pickedMatchingOption: false,
      recipientInput: null,
      messageInput: null,
    };
    current = ctx;
    const heartbeat = setInterval(() => reportProgressQuietly(ctx), 10_000);

    let result;
    try {
      result = await performSend(ctx, job);
    } catch (err) {
      const e = err instanceof GvError ? err : new GvError('UNEXPECTED', String(err?.message || err).slice(0, 200));
      if (ctx.clicked) result = { outcome: 'unknown', code: 'SEND_UNCONFIRMED', detail: e.detail || e.code };
      else if (e.code === 'ABORTED') result = { outcome: 'aborted', code: 'ABORTED' };
      else result = { outcome: 'failed', code: e.code, detail: e.detail };
    } finally {
      clearInterval(heartbeat);
    }

    result.sendAttempted = ctx.clicked;
    if (result.detail) result.detail = String(result.detail).slice(0, 300);
    else delete result.detail;
    debug(`job finished: ${result.outcome}${result.code ? ` (${result.code})` : ''}`);
    lastJob = { jobId: ctx.jobId, ...result };
    current = null;
    await notify({ type: MSG.RESULT, jobId: ctx.jobId, ...result }, 5);
  }

  // -------------------------------------------------------------------------
  // Messaging

  const extensionAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  async function notify(payload, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      if (!extensionAlive()) return null;
      try {
        return await chrome.runtime.sendMessage(payload);
      } catch {
        if (!extensionAlive()) return null;
        await sleep(400 * (i + 1));
      }
    }
    return null;
  }

  async function requestCommit(ctx) {
    if (!extensionAlive()) return null;
    let timer;
    try {
      return await Promise.race([
        chrome.runtime.sendMessage({ type: MSG.COMMIT, jobId: ctx.jobId }),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), TIMEOUTS.commitAck);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function validateJob(msg) {
    if (typeof msg.jobId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(msg.jobId)) return 'jobId';
    if (typeof msg.dial !== 'string' || !/^\+?\d{7,15}$/.test(msg.dial)) return 'dial';
    if (typeof msg.digits !== 'string' || !/^\d{7,15}$/.test(msg.digits)) return 'digits';
    if (typeof msg.international !== 'boolean') return 'international';
    if (typeof msg.message !== 'string' || !msg.message.trim() || msg.message.length > MESSAGE_MAX_CHARS) return 'message';
    if (!Number.isFinite(msg.commitBy)) return 'commitBy';
    return null;
  }

  function diagnose() {
    const checks = [];
    const add = (key, label, optional = false) => {
      const target = S[key];
      const count = queryTarget(target).length;
      checks.push({ key, label, found: count > 0, count, optional: optional || Boolean(target.optional) });
    };
    add('appShell', 'app navigation');
    add('messagesNavLink', 'Messages link');
    add('newMessageButton', 'New message button');
    add('recipientInput', 'recipient field (only while composing)', true);
    add('messageInput', 'message box (only in a conversation)', true);
    add('sendButton', 'Send button (only in a conversation)', true);
    add('threadContainer', 'conversation message list', true);
    add('messageItem', 'message bubbles', true);
    return {
      ok: true,
      page: pageState(),
      visibility: document.visibilityState,
      selectorsVersion: S.version,
      blockingDialogs: queryTarget(S.blockingDialog).length,
      checks,
    };
  }

  function onMessage(msg, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;
    switch (msg.type) {
      case MSG.PING:
        sendResponse({
          ok: true,
          page: pageState(),
          busyJobId: current?.jobId ?? null,
          lastJob,
          visibility: document.visibilityState,
          selectorsVersion: S.version,
        });
        return false;

      case MSG.SEND: {
        const invalid = validateJob(msg);
        if (invalid) {
          sendResponse({ accepted: false, code: 'UNEXPECTED', error: `Invalid job field: ${invalid}` });
        } else if (current) {
          sendResponse({ accepted: false, code: 'CONTENT_BUSY' });
        } else {
          sendResponse({ accepted: true });
          runJob(msg); // sets `current` synchronously
        }
        return false;
      }

      case MSG.ABORT:
        if (!current || current.jobId !== msg.jobId) sendResponse({ aborted: false, reason: 'no_job' });
        else if (current.committed) sendResponse({ aborted: false, committed: true });
        else {
          current.aborted = true;
          sendResponse({ aborted: true });
        }
        return false;

      case MSG.DIAGNOSE:
        sendResponse(diagnose());
        return false;

      default:
        return false;
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.__gvshContent = {
    dispose() {
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        /* extension context already gone */
      }
      if (current && !current.committed) current.aborted = true;
    },
  };
  debug(`content script ready (selectors ${S.version})`);
})();
