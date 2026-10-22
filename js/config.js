// Shared-key relay (Supabase Edge Function, source in supabase/functions/targmanich-live).
// Visitors without a key of their own translate through it; the key never reaches the page.
export const RELAY = '@relay';
export const RELAY_WS = 'wss://vlraleulstltymsqcffc.supabase.co/functions/v1/targmanich-live';
export const RELAY_HEALTH = 'https://vlraleulstltymsqcffc.supabase.co/functions/v1/targmanich-live';

export async function relayReady() {
  try {
    const res = await fetch(RELAY_HEALTH, { cache: 'no-store' });
    return Boolean((await res.json()).ready);
  } catch {
    return false;
  }
}
