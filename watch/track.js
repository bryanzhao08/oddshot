// Anonymous usage counting: a random id in this browser, events posted to /api/track.
// On Vercel it also loads Vercel Web Analytics (page views / visitors). Never blocks the page.
const uid = localStorage.getItem('tw.uid') || (() => { const v = Math.random().toString(36).slice(2, 12); localStorage.setItem('tw.uid', v); return v; })();
export const userId = uid;
const onVercel = !location.hostname.endsWith('github.io') && location.protocol === 'https:';

export function track(event) {
  if (!onVercel) return;
  const body = JSON.stringify({ event, uid });
  try {
    if (!navigator.sendBeacon?.('/api/track', new Blob([body], { type: 'application/json' }))) {
      fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch { /* ignore */ }
}

if (onVercel && !document.querySelector('script[src*="_vercel/insights"]')) {
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  const s = document.createElement('script');
  s.defer = true; s.src = '/_vercel/insights/script.js';
  document.head.appendChild(s);
}
