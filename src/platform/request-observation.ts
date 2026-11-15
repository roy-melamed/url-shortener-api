/** Feature-owner hooks only: no authentication, redirect or GeoIP decisions. */
export interface RequestObservation {
  principal: { type: 'anonymous'; id: null } | { type: 'user' | 'apikey'; id: string };
  outcome: {
    redirect?: 'active' | 'expired' | 'unknown';
    cache?: 'hit' | 'miss';
    country?: 'resolved' | 'none';
  };
}
const observations = new WeakMap<object, RequestObservation>();
export function requestObservation(request: object): RequestObservation {
  return observations.get(request) ?? { principal: { type: 'anonymous', id: null }, outcome: {} };
}
export function setRequestObservation(request: object, input: RequestObservation): void {
  const { principal, outcome } = input;
  if (
    !principal ||
    !outcome ||
    !['anonymous', 'user', 'apikey'].includes(principal.type) ||
    (principal.type === 'anonymous'
      ? principal.id !== null
      : !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          principal.id,
        )) ||
    Object.entries(outcome).some(
      ([key, value]) =>
        !(
          {
            redirect: ['active', 'expired', 'unknown'],
            cache: ['hit', 'miss'],
            country: ['resolved', 'none'],
          } as Record<string, string[]>
        )[key]?.includes(value),
    )
  ) {
    throw new Error('Invalid request observation');
  }
  observations.set(request, {
    principal: { type: principal.type, id: principal.id } as RequestObservation['principal'],
    outcome: { ...outcome },
  });
}
