import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // channel-worker build output (npm postbuild → tsconfig.worker.json)
      "dist/**",
    ],
  },
  {
    // The PM2 worker entry point and its stub are CommonJS by necessity: they
    // install a require-time module resolver before loading the compiled tree,
    // which an ESM entry cannot do. `require()` is the correct construct here.
    files: ["scripts/channel-worker.cjs", "scripts/server-only-stub.cjs", "ecosystem.config.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];

export default eslintConfig;
