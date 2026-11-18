const preferences = document.querySelector('.page-analytics');
const status = preferences.querySelector('[role="status"]');
const storageKey = 'ff_reconcile_analytics';
let frame;
let counted = false;

function applyPreference(choice) {
  if (choice === 'yes' && !counted) {
    frame = document.createElement('iframe');
    frame.hidden = true;
    frame.title = 'Page view analytics';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.referrerPolicy = 'no-referrer';
    frame.src = 'https://filefreely.com/assets/page-analytics.html' +
      (location.pathname.startsWith('/reconcile-setup') ? '#setup' : '');
    preferences.append(frame);
    counted = true;
  }
  if (choice === 'no') frame?.remove();
  status.textContent = choice === 'yes' ? 'Analytics allowed.' : 'Analytics declined.';
}

try {
  if (location.origin !== 'https://filefreely.com') preferences.hidden = true;
  const choice = localStorage.getItem(storageKey) || localStorage.getItem('ff_consent');
  if (!preferences.hidden && (choice === 'yes' || choice === 'no')) applyPreference(choice);
} catch {
  // The preference can still be used for this page if storage is unavailable.
}

for (const button of preferences.hidden ? [] : preferences.querySelectorAll('[data-analytics]')) {
  button.addEventListener('click', () => {
    const choice = button.dataset.analytics;
    try { localStorage.setItem(storageKey, choice); } catch {}
    applyPreference(choice);
  });
}
