import type { Config } from "tailwindcss";

/**
 * AutoCut design tokens (PRD §0c) — warm-paper / creative-studio.
 * Colors are CSS variables defined in app/globals.css so components reference
 * `bg-card`, `text-ink`, `bg-coral`, etc.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        card: "var(--card)",
        sink: "var(--sink)",
        ink: "var(--ink)",
        text: "var(--text)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        line: "var(--line)",
        coral: "var(--coral)",
        pass: "var(--pass)",
        passSoft: "var(--pass-soft)",
        amber: "var(--amber)",
        amberSoft: "var(--amber-soft)",
        fail: "var(--fail)",
        failSoft: "var(--fail-soft)",
      },
      fontFamily: {
        serif: ["var(--font-fraunces)", "Georgia", "serif"],
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      borderRadius: {
        card: "14px",
      },
      boxShadow: {
        soft: "3px 4px 0 rgba(34,33,29,.07)",
        hair: "0 0 0 1px var(--line)",
      },
    },
  },
  plugins: [],
};

export default config;
