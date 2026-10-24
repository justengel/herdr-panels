interface Palette {
  scheme: "dark" | "light";
  bg: string;
  elev: string;
  panel: string;
  term: string;
  line: string;
  lineStrong: string;
  text: string;
  muted: string;
  accent: string;
  idle: string;
  working: string;
  blocked: string;
  done: string;
  unknown: string;
  shell: string;
}

function dark(
  bg: string,
  elev: string,
  panel: string,
  term: string,
  line: string,
  lineStrong: string,
  text: string,
  muted: string,
  accent: string,
): Palette {
  return {
    scheme: "dark",
    bg,
    elev,
    panel,
    term,
    line,
    lineStrong,
    text,
    muted,
    accent,
    idle: "#a6e3a1",
    working: "#f9e2af",
    blocked: "#f38ba8",
    done: "#89b4fa",
    unknown: muted,
    shell: text,
  };
}

function light(
  bg: string,
  elev: string,
  panel: string,
  term: string,
  line: string,
  lineStrong: string,
  text: string,
  muted: string,
  accent: string,
): Palette {
  return {
    scheme: "light",
    bg,
    elev,
    panel,
    term,
    line,
    lineStrong,
    text,
    muted,
    accent,
    idle: "#40a02b",
    working: "#df8e1d",
    blocked: "#d20f39",
    done: "#1e66f5",
    unknown: muted,
    shell: text,
  };
}

const PALETTES: Record<string, Palette> = {
  catppuccin: dark("#1e1e2e", "#181825", "#11111b", "#11111b", "#313244", "#45475a", "#cdd6f4", "#a6adc8", "#f5c2e7"),
  "catppuccin-latte": light("#eff1f5", "#e6e9ef", "#dce0e8", "#e6e9ef", "#ccd0da", "#bcc0cc", "#4c4f69", "#6c6f85", "#8839ef"),
  terminal: dark("#101114", "#181b20", "#12151a", "#101318", "#2a2f38", "#3c4451", "#e7e4dc", "#9aa3b2", "#e2b657"),
  "tokyo-night": dark("#1a1b26", "#16161e", "#1a1b26", "#1a1b26", "#292e42", "#3b4261", "#c0caf5", "#9aa5ce", "#7aa2f7"),
  "tokyo-night-day": light("#e1e2e7", "#d5d6db", "#e1e2e7", "#e1e2e7", "#c4c8da", "#a8adcc", "#3760bf", "#6172b0", "#2e7de9"),
  dracula: dark("#282a36", "#21222c", "#282a36", "#282a36", "#44475a", "#6272a4", "#f8f8f2", "#bfbfbf", "#bd93f9"),
  nord: dark("#2e3440", "#242933", "#2e3440", "#2e3440", "#3b4252", "#434c5e", "#eceff4", "#d8dee9", "#88c0d0"),
  gruvbox: dark("#282828", "#1d2021", "#282828", "#282828", "#3c3836", "#504945", "#ebdbb2", "#a89984", "#fabd2f"),
  "gruvbox-light": light("#fbf1c7", "#f2e5bc", "#fbf1c7", "#fbf1c7", "#d5c4a1", "#bdae93", "#3c3836", "#665c54", "#b57614"),
  "one-dark": dark("#282c34", "#21252b", "#282c34", "#282c34", "#3e4451", "#4b5263", "#abb2bf", "#828997", "#61afef"),
  "one-light": light("#fafafa", "#f0f0f0", "#fafafa", "#fafafa", "#e5e5e6", "#d0d0d1", "#383a42", "#696c77", "#4078f2"),
  solarized: dark("#002b36", "#073642", "#002b36", "#002b36", "#073642", "#586e75", "#839496", "#657b83", "#268bd2"),
  "solarized-light": light("#fdf6e3", "#eee8d5", "#fdf6e3", "#fdf6e3", "#eee8d5", "#93a1a1", "#657b83", "#586e75", "#268bd2"),
  kanagawa: dark("#1f1f28", "#16161d", "#1f1f28", "#1f1f28", "#2a2a37", "#363646", "#dcd7ba", "#727169", "#957fb8"),
  "kanagawa-lotus": light("#f2ecbc", "#e5ddb0", "#f2ecbc", "#f2ecbc", "#d5cea3", "#c9c298", "#545464", "#716e61", "#624c83"),
  "rose-pine": dark("#191724", "#1f1d2e", "#191724", "#191724", "#26233a", "#403d52", "#e0def4", "#908caa", "#c4a7e7"),
  "rose-pine-dawn": light("#faf4ed", "#fffaf3", "#faf4ed", "#faf4ed", "#f2e9e1", "#dfdad9", "#575279", "#797593", "#907aa9"),
  vesper: dark("#101010", "#161616", "#101010", "#101010", "#2a2a2a", "#3a3a3a", "#ffffff", "#a0a0a0", "#ffc799"),
};

export function applyTheme(name: string) {
  const palette = PALETTES[name] ?? PALETTES.catppuccin;
  const root = document.documentElement;
  const pairs: [string, string][] = [
    ["--bg", palette.bg],
    ["--bg-elev", palette.elev],
    ["--bg-panel", palette.panel],
    ["--term", palette.term],
    ["--line", palette.line],
    ["--line-strong", palette.lineStrong],
    ["--text", palette.text],
    ["--muted", palette.muted],
    ["--accent", palette.accent],
    ["--idle", palette.idle],
    ["--working", palette.working],
    ["--blocked", palette.blocked],
    ["--done", palette.done],
    ["--unknown", palette.unknown],
    ["--shell", palette.shell],
  ];
  for (const [key, value] of pairs) root.style.setProperty(key, value);
  root.style.colorScheme = palette.scheme;
  window.dispatchEvent(new Event("herdr-theme"));
}
