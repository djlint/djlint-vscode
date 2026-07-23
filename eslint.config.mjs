/* eslint-disable @typescript-eslint/naming-convention */
import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginUnicorn from "eslint-plugin-unicorn";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist"] },
  eslint.configs.all,
  eslintPluginUnicorn.configs.all,
  tseslint.configs.all,
  eslintConfigPrettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      parserOptions: { projectService: true },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": false },
      ],
      "@typescript-eslint/explicit-member-accessibility": [
        "error",
        { accessibility: "no-public" },
      ],
      "@typescript-eslint/init-declarations": "off",
      "@typescript-eslint/max-params": "off",
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
      "@typescript-eslint/no-magic-numbers": "off",
      "@typescript-eslint/parameter-properties": [
        "error",
        { prefer: "parameter-property" },
      ],
      "@typescript-eslint/prefer-readonly-parameter-types": "off",
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowNullableBoolean: true,
          allowNullableNumber: true,
          allowNullableString: true,
        },
      ],
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
      curly: "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "func-style": ["error", "declaration"],
      "id-length": "off",
      "max-classes-per-file": "off",
      "max-depth": "off",
      "max-lines": "off",
      "max-lines-per-function": "off",
      "max-nested-callbacks": "off",
      "max-statements": "off",
      "no-continue": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-eq-null": "off",
      "no-ex-assign": "off",
      "no-new": "off",
      "no-ternary": "off",
      "no-void": "off",
      "one-var": ["error", "never"],
      radix: "off",
      "sort-imports": "off",
      "unicorn/catch-error-name": ["error", { name: "e" }],
      "unicorn/consistent-class-member-order": "off",
      "unicorn/explicit-length-check": "off",
      "unicorn/name-replacements": "off",
      "unicorn/no-keyword-prefix": "off",
      "unicorn/no-null": "off",
      "unicorn/no-unreadable-new-expression": "off",
      "unicorn/prefer-json-parse-buffer": "off",
      "unicorn/prefer-top-level-await": "off",
      "unicorn/try-complexity": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/__tests__/**", "vitest.config.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "sort-keys": "off",
      "unicorn/filename-case": "off",
    },
  },
);
