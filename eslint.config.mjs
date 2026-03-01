// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const FS_FORBIDDEN_MESSAGE =
  "Direct file system access is forbidden. Use SKLFileSystem from src/services/SKLFileSystem.ts.";

const PATH_FORBIDDEN_MESSAGE =
  "Path manipulation is restricted to SKLFileSystem and src/utils/. Use SKLFileSystem for file path operations.";

/** Modules that constitute direct file system access. */
const FS_RESTRICTED_PATHS = [
  { name: "fs", message: FS_FORBIDDEN_MESSAGE },
  { name: "fs/promises", message: FS_FORBIDDEN_MESSAGE },
  { name: "node:fs", message: FS_FORBIDDEN_MESSAGE },
  { name: "node:fs/promises", message: FS_FORBIDDEN_MESSAGE },
];

/** Path modules. */
const PATH_RESTRICTED_PATHS = [
  { name: "path", message: PATH_FORBIDDEN_MESSAGE },
  { name: "node:path", message: PATH_FORBIDDEN_MESSAGE },
  { name: "path/posix", message: PATH_FORBIDDEN_MESSAGE },
  { name: "path/win32", message: PATH_FORBIDDEN_MESSAGE },
  { name: "node:path/posix", message: PATH_FORBIDDEN_MESSAGE },
  { name: "node:path/win32", message: PATH_FORBIDDEN_MESSAGE },
];

export default tseslint.config(
  // ── Global ignores ───────────────────────────────────────────────
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "*.cjs",           // CJS test harness files
      "src/testing/**",  // test mock infrastructure
    ],
  },

  // ── Base TypeScript config for all src/**/*.ts ───────────────────
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },

  // ── fs + path ban: everything except SKLFileSystem.ts and test files
  //    Also bans vscode.workspace.fs via no-restricted-syntax.
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/services/SKLFileSystem.ts",
      "src/services/HookInstaller.ts", // operates on .git/hooks/, not .skl/
      "src/services/ConflictDetectionService.ts", // needs path.normalize for path comparison
      "src/services/StateWriterService.ts", // needs path.normalize for deriveStateId
      "src/test-filesystem.ts", // legitimately needs direct fs for integration tests
      "src/testing/**",
      "src/utils/**",            // utils may use path (see next config)
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...FS_RESTRICTED_PATHS, ...PATH_RESTRICTED_PATHS],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.type='MemberExpression'][object.object.name='vscode'][object.property.name='workspace'][property.name='fs']",
          message: FS_FORBIDDEN_MESSAGE,
        },
      ],
    },
  },

  // ── src/utils/ — allow path, still ban fs ────────────────────────
  {
    files: ["src/utils/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...FS_RESTRICTED_PATHS],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.type='MemberExpression'][object.object.name='vscode'][object.property.name='workspace'][property.name='fs']",
          message: FS_FORBIDDEN_MESSAGE,
        },
      ],
    },
  },

  // ── HookInstaller.ts: operates on .git/hooks/, not .skl/ — allow fs + path
  {
    files: ["src/services/HookInstaller.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": "off",
    },
  },

  // ── test-filesystem.ts: no fs/path restrictions (integration tests) ──
  {
    files: ["src/test-filesystem.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": "off",
    },
  },
);
