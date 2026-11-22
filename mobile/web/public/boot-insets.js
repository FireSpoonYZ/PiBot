// Synchronous pre-first-frame theme, language, and safe-area bootstrap for mobile WebView (F3 + G4).
// Loaded via classic blocking <script src="./boot-insets.js"> in <head> to satisfy script-src 'self'.
(function () {
  var root = document.documentElement;
  if (!root) return;
  var style = root.style;

  // 1. Apply cached theme & language before CSS / first paint to prevent flash (G4).
  var storedTheme = null;
  var storedLang = null;
  try {
    storedTheme = localStorage.getItem('pibot.ui-theme.v1');
    storedLang = localStorage.getItem('pibot.ui-language.v1');
  } catch (e) {
    // Ignore storage access errors.
  }
  var themePref =
    storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system'
      ? storedTheme
      : 'system';
  var isDark =
    themePref === 'dark' ||
    (themePref === 'system' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  var resolvedTheme = isDark ? 'dark' : 'light';
  root.dataset.themePref = themePref;
  root.dataset.theme = resolvedTheme;
  style.colorScheme = resolvedTheme;
  try {
    var themeMeta = document.querySelector('meta[name="theme-color"]');
    var themeColor = isDark ? '#141614' : '#F7F6F2';
    if (themeMeta) {
      themeMeta.setAttribute('content', themeColor);
    } else if (document.head) {
      var meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.content = themeColor;
      document.head.appendChild(meta);
    }
  } catch (e) {
    // Ignore head manipulation errors before DOM readiness.
  }

  if (storedLang === 'zh' || storedLang === 'en') {
    root.lang = storedLang;
  } else if (storedLang === 'system' && typeof navigator !== 'undefined' && navigator.language) {
    root.lang = navigator.language;
  }

  // 2. If Android native addDocumentStartJavaScript already injected insets, preserve them as-is.
  if (root.dataset.insetsReady === '1') return;

  // 3. Otherwise hydrate cached safe-area insets synchronously from localStorage (F3).
  var cached = false;
  try {
    var raw = localStorage.getItem('pibot.safe-area-insets.v1');
    if (raw) {
      var parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.top === 'number' &&
        isFinite(parsed.top) &&
        parsed.top >= 0 &&
        typeof parsed.bottom === 'number' &&
        isFinite(parsed.bottom) &&
        parsed.bottom >= 0
      ) {
        style.setProperty('--safe-area-inset-top', Math.round(parsed.top) + 'px');
        style.setProperty('--safe-area-inset-bottom', Math.round(parsed.bottom) + 'px');
        style.setProperty('--ime-bottom', '0px');
        root.dataset.insetsReady = '1';
        cached = true;
      }
    }
  } catch (e) {
    // Ignore malformed or inaccessible safe-area cache.
  }

  // 4. First install inside Android Tauri WebView (no cache & no doc-start insets yet):
  // keep hidden briefly until native dispatches pibot:insets-ready, with a hard 250ms reveal cap.
  // Window/WebView background is already painted with the matching theme color by TauriMainActivity.
  var isTauriMobile =
    typeof window.__TAURI_INTERNALS__ !== 'undefined' ||
    (typeof location !== 'undefined' && location.hostname === 'tauri.localhost');
  if (!cached && isTauriMobile) {
    style.visibility = 'hidden';
    var revealed = false;
    var reveal = function () {
      if (revealed) return;
      revealed = true;
      style.visibility = '';
      window.removeEventListener('pibot:insets-ready', reveal);
    };
    window.addEventListener('pibot:insets-ready', reveal, { once: true });
    setTimeout(reveal, 250);
  }
})();
