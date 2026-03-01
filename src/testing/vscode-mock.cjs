/**
 * Minimal mock of the `vscode` module for running tests outside the
 * VS Code extension host.  Only the APIs consumed by SKLFileSystem
 * (EventEmitter + Event) are reproduced here.
 */
"use strict";

class EventEmitter {
  constructor() {
    this._listeners = [];
    this.event = (listener) => {
      this._listeners.push(listener);
      return { dispose: () => {
        const idx = this._listeners.indexOf(listener);
        if (idx >= 0) this._listeners.splice(idx, 1);
      }};
    };
  }

  fire(data) {
    for (const fn of this._listeners) fn(data);
  }

  dispose() {
    this._listeners.length = 0;
  }
}

/* ── LM mock infrastructure ──────────────────────────────────────── */

/** @type {Function} */
let _selectChatModelsImpl = async () => [];

const lm = {
  selectChatModels: async function (...args) {
    return _selectChatModelsImpl(...args);
  },
};

const LanguageModelChatMessage = {
  User: (content) => ({ role: "user", content }),
};

/**
 * Replace the selectChatModels implementation for a test.
 * @param {Function} impl
 */
function __setSelectChatModels(impl) {
  _selectChatModelsImpl = impl;
}

/** Reset LM mock to default (no models available). */
function __resetLmMock() {
  _selectChatModelsImpl = async () => [];
}

/* ── Webview panel mock ───────────────────────────────────────────── */

class MockWebviewPanel {
  constructor() {
    this._html = '';
    this._messageListeners = [];
    this._disposeListeners = [];
    const self = this;
    this.webview = {
      get html() { return self._html; },
      set html(v) { self._html = v; },
      postMessage: async () => true,
      onDidReceiveMessage: (handler) => {
        self._messageListeners.push(handler);
        return { dispose: () => {} };
      },
    };
  }
  reveal() {}
  onDidDispose(handler) {
    this._disposeListeners.push(handler);
    return { dispose: () => {} };
  }
  dispose() {
    for (const h of this._disposeListeners) h();
  }
  /** Test helper: simulate an incoming message from the webview. */
  simulateMessage(msg) {
    for (const h of this._messageListeners) h(msg);
  }
}

/* ── Window mock ─────────────────────────────────────────────────── */

const window = {
  createWebviewPanel: () => new MockWebviewPanel(),
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
};

const ViewColumn = { One: 1, Two: 2, Three: 3, Beside: -2 };

const Uri = {
  file: (p) => ({ fsPath: p, scheme: 'file', path: p }),
  joinPath: (...args) => ({ fsPath: args.map(a => a.fsPath || a).join('/'), scheme: 'file' }),
};

const commands = {
  executeCommand: async () => undefined,
};

const workspace = {
  createFileSystemWatcher: () => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  fs: {
    readFile: async () => new Uint8Array(),
  },
};

module.exports = {
  EventEmitter,
  lm,
  LanguageModelChatMessage,
  __setSelectChatModels,
  __resetLmMock,
  window,
  ViewColumn,
  Uri,
  commands,
  workspace,
  MockWebviewPanel,
};
