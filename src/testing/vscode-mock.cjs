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

module.exports = {
  EventEmitter,
  lm,
  LanguageModelChatMessage,
  __setSelectChatModels,
  __resetLmMock,
};
