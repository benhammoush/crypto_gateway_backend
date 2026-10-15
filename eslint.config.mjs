import js from "@eslint/js";
import ts from "typescript-eslint";

export default ts.config(
  { ignores: ["dist/**", "node_modules/**", ".wrangler/**"] },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  js.configs.recommended,
  ...ts.configs.recommended,
);
