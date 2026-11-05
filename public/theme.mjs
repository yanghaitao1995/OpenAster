const THEME_COLORS = Object.freeze({ light: '#ffffff', dark: '#1c1c1e' });

// The page owns its theme. The native bridge only mirrors the fixed palette;
// missing or failed bridges must never prevent the workbench from loading.
export function createThemeAppearance({
  document = globalThis.document,
  capacitor = globalThis.Capacitor,
  userAgent = globalThis.navigator?.userAgent || '',
} = {}) {
  let appearance = null;
  try {
    if (!/\bElectron\//.test(userAgent) && capacitor?.isNativePlatform?.() === true && capacitor?.getPlatform?.() === 'android') {
      // Capacitor's Android JSExport injects Plugins directly into this shell.
      // registerPlugin is optional for shells also loading the core JS bundle.
      const plugin = capacitor.Plugins?.OpenAsterAppearance ?? capacitor.registerPlugin?.('OpenAsterAppearance');
      if (typeof plugin?.setTheme === 'function') appearance = plugin;
    }
  } catch {}

  let pending = null, applying = false;
  async function applyPending() {
    applying = true;
    try {
      while (pending !== null) {
        const theme = pending;
        pending = null;
        try { await appearance.setTheme({ theme }); } catch {}
        // A later user choice or foreground event replaces the queued choice.
        // Failure alone never queues another request.
      }
    } finally { applying = false; }
  }

  return {
    sync(theme) {
      if (theme !== 'light' && theme !== 'dark') return;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
      if (!appearance) return;
      pending = theme;
      if (!applying) void applyPending();
    },
  };
}
