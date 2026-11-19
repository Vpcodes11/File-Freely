// Cloudflare Pages Function: POST /api/license  { key }
// Checks a FileFreely Pro license key against Gumroad and reports the plan.
// Gumroad's verify endpoint needs no secret, only the product ID.
// Product IDs can also be set with a GUMROAD_PRODUCTS environment variable (same JSON shape).
const PRODUCTS = [
  { id: 'Aw-E8X1ATRAdThBlu1RYJA==', plan: 'monthly' },  // FileFreely Pro (vaistack3.gumroad.com/l/filefreely-pro)
  { id: 'KrJ3bbKiJMM_JLzeum_6fg==', plan: 'pass7' },    // FileFreely 7-Day Pass (vaistack3.gumroad.com/l/filefreely-7-day-pass)
  { id: 'zT7Cf2W2Q_MXegT74j1Q6w==', plan: 'day1' },     // FileFreely: Just This File, 24-hour unlock (vaistack3.gumroad.com/l/filefreely-one-file)
];
const PASS_LENGTH = { pass7: 7 * 86400e3, day1: 86400e3 };
const PASS_NAME = { pass7: '7-day pass', day1: '24-hour unlock' };

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

async function verify(productId, key) {
  const body = new URLSearchParams({ product_id: productId, license_key: key, increment_uses_count: 'false' });
  const r = await fetch('https://api.gumroad.com/v2/licenses/verify', { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  return j && j.success ? j : null;
}

export async function onRequestPost({ request, env }) {
  let products = PRODUCTS;
  try { if (env.GUMROAD_PRODUCTS) products = JSON.parse(env.GUMROAD_PRODUCTS); } catch (e) { }
  if (!products.length) return json({ ok: false, error: 'Paid plans are not open yet.' }, 503);
  let key = '';
  try { key = String((await request.json()).key || '').trim(); } catch (e) { }
  if (!/^[A-Za-z0-9-]{8,64}$/.test(key)) return json({ ok: false, error: 'That does not look like a license key. Copy it from your Gumroad receipt.' }, 400);

  for (const p of products) {
    const j = await verify(p.id, key);
    if (!j) continue;
    const s = j.purchase || {};
    if (s.refunded || s.chargebacked || s.disputed) return json({ ok: false, error: 'This purchase was refunded, so the key is no longer active.' }, 403);
    if (p.plan === 'monthly') {
      if (s.subscription_ended_at || s.subscription_failed_at) return json({ ok: false, error: 'This subscription has ended or a payment failed. Renew it on Gumroad to continue.' }, 403);
      return json({ ok: true, plan: 'monthly', expires: 0 });
    }
    const sold = Date.parse(s.sale_timestamp || s.created_at || '');
    const expires = (isFinite(sold) ? sold : Date.now()) + (PASS_LENGTH[p.plan] || PASS_LENGTH.pass7);
    if (expires < Date.now()) return json({ ok: false, error: 'This ' + (PASS_NAME[p.plan] || 'pass') + ' has expired.' }, 403);
    return json({ ok: true, plan: p.plan, expires });
  }
  return json({ ok: false, error: 'That license key was not recognised. Copy it exactly from your Gumroad receipt.' }, 404);
}

export const onRequest = () => json({ ok: false, error: 'Use POST.' }, 405);
