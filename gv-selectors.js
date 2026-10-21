// GV Sheet Helper — Google Voice selectors.
//
// Google Voice's DOM is NOT a public API. It changes without notice. Every
// selector below is a best guess based on Google Voice's accessible labels and
// custom-element names, and MUST be verified against the live site:
//
//   1. Open https://voice.google.com/ and sign in.
//   2. Open the extension's side panel and click "Check page" (Settings).
//      The activity log lists which targets were found.
//   3. For anything missing, right-click the element in Google Voice ->
//      Inspect, and add a selector for it to the matching `css` list below.
//      Prefer aria-label, role, placeholder and custom element names over
//      generated class names (e.g. "_ngcontent-abc", "mat-mdc-123").
//
// Each target has:
//   css   - selectors tried in order; all matches are collected
//   text  - optional fallback: elements matching `selector` whose accessible
//           name (aria-label, title or text) matches one of `patterns`
//   note  - what the element is and how confident the selector is
//
// This file is loaded before content.js and only defines data.

(() => {
  const S = {
    version: '2026-10-21',

    // Present only when the signed-in app has rendered.
    appShell: {
      note: 'Main navigation of the signed-in app. VERIFY.',
      css: [
        'gv-side-nav',
        'gv-sidenav',
        '[gv-test-id="sidenav"]',
        'nav a[href*="/messages"]',
        'a[gv-test-id="sidenav-messages"]',
        '[role="navigation"] a[href*="/messages"]',
      ],
    },

    // Marketing / sign-in page shown to signed-out visitors.
    signedOut: {
      note: 'Sign-in links on the public landing page. VERIFY.',
      css: [
        'a[href*="accounts.google.com/ServiceLogin"]',
        'a[href*="accounts.google.com/signin"]',
        'a[href*="accounts.google.com/v3/signin"]',
      ],
      text: { selector: 'a, button', patterns: [/^sign in$/i] },
    },

    messagesNavLink: {
      note: 'Left-nav link to the Messages view. VERIFY.',
      css: [
        'a[gv-test-id="sidenav-messages"]',
        'a[href$="/messages"]',
        'a[href*="/messages?"]',
        '[role="navigation"] a[aria-label^="Messages" i]',
      ],
    },

    newMessageButton: {
      note: '"Send new message" button at the top of the Messages list. VERIFY.',
      css: [
        '[gv-test-id="send-new-message"]',
        '[gv-id="send-new-message"]',
        '[aria-label="Send new message"]',
        '[aria-label="New message"]',
      ],
      text: { selector: 'button, [role="button"], a', patterns: [/^send new message$/i, /^new message$/i] },
    },

    recipientInput: {
      note: 'Input where a name or phone number is typed. VERIFY.',
      css: [
        'input[gv-test-id="recipient-picker-input"]',
        'gv-recipient-picker input',
        'input[placeholder*="name or phone number" i]',
        'input[aria-label*="name or phone number" i]',
        'input[aria-label="To" i]',
      ],
    },

    // Suggestion rows that appear after typing a number.
    recipientOption: {
      note: 'Suggestion such as "Send to (212) 555-0147". VERIFY.',
      css: [
        '[gv-test-id="send-to-phone-number"]',
        '[id^="send_to_button"]',
        '[role="option"]',
        'mat-option',
        '.mat-mdc-option',
      ],
      text: { selector: 'button, [role="button"], li, div[tabindex]', patterns: [/^send to\b/i] },
    },

    // Selected recipients ("chips") in the recipient picker.
    recipientChip: {
      note: 'Selected recipient chips. Used to make sure exactly one recipient is selected. VERIFY.',
      css: [
        '[gv-test-id="recipient-chip"]',
        'gv-recipient-picker mat-chip',
        'gv-recipient-picker .mat-mdc-chip',
        'gv-recipient-picker [role="row"]',
        'gv-recipient-picker .chip',
      ],
    },

    recipientError: {
      note: 'Inline error when a number is rejected. Low confidence. VERIFY.',
      css: ['gv-recipient-picker [role="alert"]', 'gv-recipient-picker .error', 'gv-recipient-picker mat-error'],
      text: { selector: '[role="alert"], mat-error, .error', patterns: [/not a valid/i, /invalid (phone )?number/i, /can.t send to this number/i] },
    },

    // Header of the open conversation (fallback recipient confirmation).
    conversationHeader: {
      note: 'Title of the open conversation. Optional fallback. VERIFY.',
      css: ['[gv-test-id="conversation-title"]', 'gv-thread-details-header', '.conversation-header', '[role="main"] header'],
      optional: true,
    },

    messageInput: {
      note: 'Message composer text box. Never press Enter in it. VERIFY.',
      css: [
        'textarea[gv-test-id="gv-message-input"]',
        'textarea[aria-label="Type a message" i]',
        'textarea[placeholder*="Type a message" i]',
        'gv-message-entry textarea',
        'textarea.message-input',
        '[contenteditable="true"][aria-label*="message" i]',
      ],
    },

    sendButton: {
      note: 'Send button next to the composer. Searched near the composer first. VERIFY.',
      css: [
        'button[gv-test-id="send_message"]',
        '[gv-test-id="send_message"]',
        'button[aria-label="Send message" i]',
        '[role="button"][aria-label="Send message" i]',
      ],
      text: { selector: 'button, [role="button"]', patterns: [/^send( message)?$/i] },
    },

    // Container of the open conversation's messages.
    threadContainer: {
      note: 'Scrollable list of messages in the open conversation. VERIFY.',
      css: ['gv-message-list', '[gv-test-id="message-list"]', '[role="list"][aria-label*="message" i]', '.message-list'],
      optional: true,
    },

    // One message bubble in the open conversation.
    messageItem: {
      note: 'A single message bubble/row. VERIFY.',
      css: ['gv-text-message-item', 'gv-message-item', '[gv-test-id="message-item"]', '.message-row'],
      optional: true,
    },

    // Messages list on the left; never mistaken for the open conversation.
    conversationList: {
      note: 'Conversation list (left column). Excluded when looking for sent messages.',
      css: ['gv-conversation-list', '[gv-test-id="conversation-list"]', '[aria-label="Conversations" i]'],
      optional: true,
    },

    // Status line inside or next to a bubble ("Sending…", "Not sent").
    messageStatus: {
      note: 'Per-message status text. Low confidence; text patterns below are the main signal.',
      css: ['[gv-test-id="message-status"]', '.status', '.message-status'],
      optional: true,
    },

    errorToast: {
      note: 'Snackbar / alert used for errors. VERIFY.',
      css: ['mat-snack-bar-container', '.mat-mdc-snack-bar-container', '[role="alert"]', '[role="status"]'],
      optional: true,
    },

    // Anything modal that might be a verification, limit or CAPTCHA prompt.
    blockingDialog: {
      note: 'Modal dialogs. Any visible one stops the queue so you can review it.',
      css: [
        '[role="alertdialog"]',
        '[role="dialog"]',
        'mat-dialog-container',
        '.mat-mdc-dialog-container',
        'iframe[src*="recaptcha"]',
        'iframe[title*="recaptcha" i]',
      ],
      optional: true,
    },
  };

  // Status text patterns, matched against a bubble with the message text removed.
  S.patterns = {
    sending: /\bsending\b/i,
    failed: /not sent|couldn.t send|could not send|failed to send|message failed|tap to retry|try again/i,
  };

  globalThis.GVSH_SELECTORS = Object.freeze(S);
})();
