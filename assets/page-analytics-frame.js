const measurementId = 'G-27045MHGX7';
const setupPage = location.hash === '#setup';

window.dataLayer = window.dataLayer || [];
function gtag() { window.dataLayer.push(arguments); }

gtag('consent', 'default', {
  analytics_storage: 'granted',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied'
});
gtag('js', new Date());
gtag('config', measurementId, {
  // The analytics frame is on a separate site. Its cookies must be scoped to the embedding site.
  cookie_domain: 'none',
  cookie_flags: 'SameSite=None;Secure;Partitioned',
  allow_google_signals: false,
  allow_ad_personalization_signals: false,
  page_location: 'https://filefreely.com/' + (setupPage ? 'reconcile-setup/' : 'reconcile/'),
  page_title: setupPage ? 'Recurring Supplier Statement Layout Setup' : 'Supplier Statement Reconciliation',
  page_referrer: ''
});
