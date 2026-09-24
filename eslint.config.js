// ESLint flat config. Run with `npm run lint`.
const js = require("@eslint/js");
const globals = require("globals");

const security = {
  // No string-to-code paths anywhere.
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
  "no-script-url": "error",
  "no-proto": "error",
  "no-extend-native": "error",
};

module.exports = [
  { ignores: ["node_modules/", "playwright-report/", "test-results/", ".firebase/"] },
  js.configs.recommended,
  {
    files: ["js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, GoalCalc: "readonly", LedgerEngine: "readonly", module: "readonly", define: "readonly" },
    },
    rules: {
      ...security,
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-shadow": "off",
    },
  },
  {
    files: ["js/cloud.js"],
    languageOptions: { sourceType: "module" },
  },
  {
    files: ["tests/**/*.js", "*.config.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: { ...globals.node, ...globals.browser } },
    // Tests deliberately feed javascript: URLs to the app to prove they are blocked.
    rules: { ...security, "no-script-url": "off", "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }] },
  },
];
