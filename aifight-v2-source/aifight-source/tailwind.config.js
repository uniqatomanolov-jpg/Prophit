/** @type {import('tailwindcss').Config} */
export default {
  // Tailwind only emits the classes it can see in these files. If a class
  // ever renders as unstyled in production but works in dev, this glob is
  // the first place to look.
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // `font-mono` is the arena's voice, so it is bound explicitly rather
        // than left to whatever monospace the OS picks.
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
      },
      colors: {
        obsidian: "#050508",
      },
    },
  },
  plugins: [],
};
