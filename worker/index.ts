interface Env {
  ASSETS: Fetcher;
  FLASH_UID: string;
}

const GALLERY_URL = "https://api.space-invaders.com/flashinvaders_v3_pas_trop_predictif/api/gallery";
const POSITIONS_URL = "https://pnote.eu/projects/invaders/map/invaders.json";
const POSITIONS_TTL = 6 * 60 * 60;

type UpstreamGallery = {
  code: number;
  message: string;
  invaders: Record<string, {
    name: string;
    point: number;
    city_id: number;
    date_pos: string;
    date_flash: string;
    image_url: string;
  }>;
  cities: { id: number; name: string; si_count: number }[];
  player: { name: string; score: number; rank: number; si_found: number; city_found: number };
};

type UpstreamPosition = {
  id: string;
  status: string;
  obf_lat: number | null;
  obf_lng: number | null;
};

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
  });

async function gallery(env: Env): Promise<Response> {
  if (!env.FLASH_UID) {
    return json({ error: "FLASH_UID manquant : lance `wrangler secret put FLASH_UID`." }, { status: 500 });
  }
  const res = await fetch(`${GALLERY_URL}?uid=${encodeURIComponent(env.FLASH_UID)}`, {
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) {
    return json({ error: `L'API FlashInvaders a répondu ${res.status}.` }, { status: 502 });
  }
  const data = (await res.json()) as UpstreamGallery;
  if (data.code !== 0) {
    return json({ error: `L'API FlashInvaders a refusé la requête : ${data.message}` }, { status: 502 });
  }

  // On ne renvoie jamais l'UID ni l'email du compte au navigateur.
  return json(
    {
      fetchedAt: new Date().toISOString(),
      player: {
        name: data.player.name,
        score: data.player.score,
        rank: data.player.rank,
        found: data.player.si_found,
        cities: data.player.city_found,
      },
      cities: data.cities.map((c) => ({ id: c.id, name: c.name, total: c.si_count })),
      flashes: Object.values(data.invaders).map((i) => ({
        id: i.name,
        points: i.point,
        cityId: i.city_id,
        flashedAt: i.date_flash,
        image: i.image_url,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function positions(request: Request, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const key = new Request(new URL("/api/positions", request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const res = await fetch(POSITIONS_URL);
  if (!res.ok) {
    return json({ error: `Impossible de charger les positions (pnote.eu a répondu ${res.status}).` }, { status: 502 });
  }
  const data = (await res.json()) as UpstreamPosition[];
  const out = json(
    data
      .filter((p) => p.obf_lat !== null && p.obf_lng !== null)
      .map((p) => [p.id, p.status, Math.round(p.obf_lat! * 1e5) / 1e5, Math.round(p.obf_lng! * 1e5) / 1e5]),
    { headers: { "cache-control": `public, max-age=${POSITIONS_TTL}` } },
  );
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/gallery") return gallery(env);
    if (pathname === "/api/positions") return positions(request, ctx);
    if (pathname.startsWith("/api/")) return json({ error: "Route inconnue." }, { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
