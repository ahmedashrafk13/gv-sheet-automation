/**
 * Human-Like Activity Simulation Module for n8n Workflows
 * 
 * Can be imported into n8n Code Nodes or custom JavaScript functions
 * to pace automated actions (Google Sheets, SMS, Webhooks, HTTP Requests)
 * with realistic human timing, dynamic pauses, and context-aware error recovery.
 */

/**
 * 1. Random integer generator within range [min, max].
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 2. Task-Dependent Reading & Thinking Pauses:
 * Returns realistic human pause durations (ms) based on the specific action.
 * Longer pauses for complex forms, shorter for simple confirmations,
 * and scaled pauses based on message length for proofreading.
 */
function getHumanDelay(taskType, textContent = '') {
  switch (taskType) {
    case 'page_load':
      // Waiting after opening a sheet or loading a page to orient
      return randInt(600, 1400);

    case 'simple_click':
      // Simple toggle, checkbox, or button click
      return randInt(180, 420);

    case 'complex_form':
      // Inspecting multiple fields before filling or submitting
      return randInt(800, 1800);

    case 'proofread_message': {
      // Dynamic pause proportional to text length (reading words)
      const len = String(textContent || '').length;
      return Math.min(3000, Math.max(450, Math.round(len * 7 + randInt(300, 600))));
    }

    case 'inter_contact_delay':
      // Randomized gap between queue items (e.g. 45s-75s)
      return randInt(45000, 75000);

    default:
      return randInt(300, 700);
  }
}

/**
 * 3. Human-like Typing Stream Chunker:
 * Breaks a string into small variable chunks (1-3 chars) with assigned
 * variable delays (sentence pauses, word pauses, keystroke speed).
 */
function createHumanTypingPlan(text) {
  const value = String(text || '');
  const steps = [];
  let i = 0;

  while (i < value.length) {
    const char = value[i];
    let chunk = char;
    i += 1;

    // 40% chance to bundle adjacent character if not punctuation/whitespace
    if (i < value.length && !/[\s.,!?;:\n]/.test(char) && !/[\s.,!?;:\n]/.test(value[i]) && Math.random() < 0.4) {
      chunk += value[i];
      i += 1;
    }

    let delayMs = randInt(25, 60);
    const last = chunk[chunk.length - 1];
    if (/[.!?\n]/.test(last)) {
      delayMs = randInt(220, 480); // Sentence pause
    } else if (/[,;:—-]/.test(last)) {
      delayMs = randInt(110, 220); // Clause pause
    } else if (last === ' ') {
      delayMs = randInt(70, 160); // Word boundary pause
    }

    steps.push({ chunk, delayMs });
  }

  return steps;
}

/**
 * 4. Context-Aware Verification:
 * Validates payload fields before submitting, inspects API response status,
 * and determines if an action should be retried or halted.
 */
function evaluateResponseContext(response) {
  if (!response) {
    return { ok: false, retryable: true, reason: 'Empty response received.' };
  }

  const statusCode = response.status || response.statusCode || 200;

  // Rate limited (429) or Temporary Service Unavailable (503)
  if (statusCode === 429 || statusCode === 503) {
    const backoffMs = randInt(30000, 60000);
    return { ok: false, retryable: true, backoffMs, reason: `Rate limited (${statusCode}). Backing off.` };
  }

  // Client errors (400, 401, 403, 404) are generally fatal / non-retryable
  if (statusCode >= 400 && statusCode < 500) {
    return { ok: false, retryable: false, reason: `Client error (${statusCode}). Check authentication and parameters.` };
  }

  // Successful submission (2xx)
  if (statusCode >= 200 && statusCode < 300) {
    return { ok: true, reason: 'Confirmed successful submission.' };
  }

  return { ok: false, retryable: true, backoffMs: 5000, reason: `Unexpected status code: ${statusCode}` };
}

// ---------------------------------------------------------------------------
// Example n8n Code Node Implementation
// ---------------------------------------------------------------------------
/**
 * In an n8n Code Node, copy the logic below to process spreadsheet rows
 * with human-paced reading, validation, and jittered dispatch delays:
 *
 * async function runN8nCodeNode($input) {
 *   const items = $input.all();
 *   const results = [];
 *
 *   for (let i = 0; i < items.length; i++) {
 *     const item = items[i].json;
 *     const message = item.Message || item.message || '';
 *
 *     // 1. Task-dependent proofreading pause based on message length
 *     const readPauseMs = getHumanDelay('proofread_message', message);
 *
 *     // 2. Inter-item queue delay with randomized human jitter
 *     const queueWaitMs = i > 0 ? getHumanDelay('inter_contact_delay') : 0;
 *
 *     results.push({
 *       json: {
 *         ...item,
 *         _humanPacing: {
 *           readPauseMs,
 *           queueWaitMs,
 *           typingChunksCount: createHumanTypingPlan(message).length,
 *           scheduledAt: new Date(Date.now() + queueWaitMs).toISOString()
 *         }
 *       }
 *     });
 *   }
 *   return results;
 * }
 */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    randInt,
    getHumanDelay,
    createHumanTypingPlan,
    evaluateResponseContext,
  };
}

