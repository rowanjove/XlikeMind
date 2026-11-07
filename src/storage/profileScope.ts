export const DEFAULT_PROFILE_ID = 'default';

export function getPageProfileId(): string {
  if (typeof location === 'undefined') return DEFAULT_PROFILE_ID;
  const id = new URLSearchParams(location.search).get('profile');
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : DEFAULT_PROFILE_ID;
}

export function profileStorageKey(base: string, profileId = DEFAULT_PROFILE_ID): string {
  return profileId === DEFAULT_PROFILE_ID ? base : `${base}:${profileId}`;
}
