/**
 * CJS require-hook that intercepts `require("vscode")` and returns
 * the lightweight mock so tests can run outside the extension host.
 *
 * Usage: npx tsx --require ./src/testing/register-vscode-mock.cjs src/test-filesystem.ts
 */
"use strict";

const Module = require("module");
const path = require("path");

const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "vscode") {
    return path.resolve(__dirname, "vscode-mock.cjs");
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
