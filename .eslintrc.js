module.exports = {
  env: {
    browser: true,
    node: true
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "tsconfig.json",
    sourceType: "module"
  },
  plugins: [
    "react",
    "@typescript-eslint",
    // "@typescript-eslint/tslint",
    "jsx-a11y",
    "prettier",
    "react-hooks"
  ],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react/recommended",
    "plugin:jsx-a11y/strict",
    "prettier",
    "prettier/@typescript-eslint",
    "plugin:prettier/recommended",
    "prettier/react"
  ],
  rules: {
    // this rule was deprecated in favor of another
    // not sure why it is still giving errors
    "jsx-a11y/label-has-for": 0,
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "@typescript-eslint/no-empty-interface": 0,
    "@typescript-eslint/no-use-before-define": [
      "error",
      { functions: false, variables: false }
    ],
    // disabling this bc it is checked by typescript so it is
    // redundant and doesn't function properly
    "react/prop-types": 0,
    // update the no unused var rule to allow _var
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        vars: "all",
        args: "after-used",
        // ignore underscore _vars or jsx imports or React imports
        argsIgnorePattern: "^_.*|^jsx|",
        ignoreRestSiblings: true
      }
    ],
    // these are meant to allow jsx to mark react as used. Not working right now though
    "react/jsx-uses-vars": "error",
    "react/jsx-uses-react": "error",
    // disable this rule because it is unnecessarily strict for TS
    "@typescript-eslint/explicit-function-return-type": 0,
    // if we want this, we should turn disallow any in tsconfig not here
    "@typescript-eslint/no-explicit-any": 0,
    "@typescript-eslint/no-var-requires": 0,
    "@typescript-eslint/class-name-casing": "error",
    "@typescript-eslint/prefer-namespace-keyword": "error",
    camelcase: "error",
    eqeqeq: ["error", "smart"],
    "id-blacklist": [
      "error",
      "any",
      "Number",
      "number",
      "String",
      "string",
      "Boolean",
      "boolean",
      "Undefined"
    ],
    "id-match": "error",
    "no-eval": "error",
    "no-redeclare": "error",
    "no-underscore-dangle": "error",
    "no-var": "error"
  },
  settings: {
    react: {
      version: "detect"
    }
  }
};
