// Load only the surface requested by the native window.
if (new URLSearchParams(window.location.search).get('view') === 'pet') {
  void import('./pet/main');
} else {
  void import('./desktopMain');
}
