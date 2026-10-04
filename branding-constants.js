(function (root, factory) {
  var brand = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = brand;
  }
  if (root) {
    root.__BRAND = brand;
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  return {
    PRODUCT_NAME: 'Corporate Games Command Center',
    UI_LABEL: 'Corporate Games Command Center',
    ACTIVE_FLIGHT_CODE: 'FL051126',
    LEGACY_FLIGHT_CODES: [],
    PALETTE: {
      // Wreath Signal: evergreen accent on a light neutral canvas, charcoal
      // text, restrained gold reserved for small highlight details only.
      background: '#F7F5F0',
      surface: '#FFFFFF',
      accent: '#1E5631',
      accentDeep: '#16432A',
      accentSoft: 'rgba(30, 86, 49, 0.12)',
      gold: '#7A5E18',
      goldSoft: 'rgba(122, 94, 24, 0.14)',
      border: 'rgba(30, 86, 49, 0.28)',
      text: '#262B27',
      muted: '#55594F'
    }
  };
}));

(function addFloorsEmbedToHead() {
  if (typeof document === 'undefined') return;
  var existing = document.querySelector('script[src="https://floorsjs.com/embed.js"]');
  if (existing) return;
  var script = document.createElement('script');
  script.src = 'https://floorsjs.com/embed.js';
  script.setAttribute('data-key', 'flr_3f66ddabed1644528c594d4f');
  document.head.appendChild(script);
})();
