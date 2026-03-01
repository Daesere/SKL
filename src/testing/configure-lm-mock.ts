/**
 * configure-lm-mock.ts
 *
 * Typed helpers for configuring the vscode LM mock in tests.
 * This file lives in src/testing/ which is ESLint-ignored.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const mock = require("./vscode-mock.cjs") as VscodeMockModule;

/** Shape of a mock LM model. */
export interface MockModel {
  sendRequest(
    messages: unknown[],
    options: Record<string, unknown>,
  ): Promise<{ text: AsyncIterable<string> }>;
}

type SelectChatModelsFn = (...args: unknown[]) => Promise<MockModel[]>;

interface VscodeMockModule {
  __setSelectChatModels: (impl: SelectChatModelsFn) => void;
  __resetLmMock: () => void;
}

/** Override selectChatModels for the next test. */
export function setSelectChatModels(impl: SelectChatModelsFn): void {
  mock.__setSelectChatModels(impl);
}

/** Reset to default (no models available). */
export function resetLmMock(): void {
  mock.__resetLmMock();
}

/**
 * Create a mock model that returns the given text as a single chunk.
 */
export function createMockModel(responseText: string): MockModel {
  return {
    sendRequest: async () => ({
      text: (async function* () {
        yield responseText;
      })(),
    }),
  };
}
