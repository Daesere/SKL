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

module.exports = { EventEmitter };
