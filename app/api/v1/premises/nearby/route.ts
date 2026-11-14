import { ok, route } from '@/lib/http/api';
import { NearbyQuery, nearbyPremises } from '@/lib/domain/premises';

export const dynamic = 'force-dynamic';

/** GET /api/v1/premises/nearby?lat=&lng=&radius= (metres, max 500) */
export const GET = route('premises:read', async ({ request, ids }) => {
  const q = NearbyQuery.parse(Object.fromEntries(request.nextUrl.searchParams));
  return ok({ premises: await nearbyPremises(q), center: { lat: q.lat, lng: q.lng }, radius: q.radius, fetched_at: new Date().toISOString() }, ids);
});
