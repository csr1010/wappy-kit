import tseslint from "typescript-eslint";

export default tseslint.config(
  // fixtures/generated holds frozen user projects (B7): checked by booting them, never edited.
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", ".wappy/**", "fixtures/generated/**", "packages/e2e/.old-projects/**"] },
  ...tseslint.configs.recommended,
);
