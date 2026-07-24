import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", ".wappy/**"] },
  ...tseslint.configs.recommended,
);
