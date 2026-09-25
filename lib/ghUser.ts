// Client side of /api/gh-user. The house info card and the profile panel ask
// for the same login one after the other, and each request costs the server
// several GitHub API calls, so complete answers are shared per login for the
// session. Rate-limited or failed answers are not kept, so "Retry" refetches.

export type GhRepo = {
  name: string;
  owner: string;
  description: string | null;
  stars: number;
  lang: string | null;
  langColor: string;
  url: string;
  pushedAt: string | null;
  fork: boolean;
};

export type GhUser = {
  login: string;
  name: string;
  bio: string | null;
  avatarUrl: string;
  followers: number;
  following: number;
  location: string | null;
  company: string | null;
  blog: string | null;
  twitter: string | null;
  publicRepos: number;
  htmlUrl: string;
  pinned: GhRepo[];
  pinnedIsFallback: boolean;
  repos: GhRepo[];
  readmeHtml: string | null;
  rateLimited?: boolean;
  error?: string;
};

const cache = new Map<string, Promise<GhUser>>();

export function fetchGhUser(login: string): Promise<GhUser> {
  const hit = cache.get(login);
  if (hit) return hit;
  const request = fetch(`/api/gh-user?login=${encodeURIComponent(login)}`)
    .then((r) => (r.ok ? (r.json() as Promise<GhUser>) : Promise.reject(new Error(`gh-user ${r.status}`))))
    .then(
      (user) => {
        if (user.error || user.rateLimited) cache.delete(login);
        return user;
      },
      (err: unknown) => {
        cache.delete(login);
        throw err;
      },
    );
  cache.set(login, request);
  return request;
}
