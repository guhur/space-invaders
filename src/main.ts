import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { readCache, writeCache } from "./cache";
import { haversine, nearest, shortestPath, type Point } from "./route";
import "./style.css";

type Flash = { id: string; points: number; cityId: number; flashedAt: string; image: string };
type Gallery = {
  fetchedAt: string;
  player: { name: string; score: number; rank: number; found: number; cities: number };
  cities: { id: number; name: string; total: number }[];
  flashes: Flash[];
};
type Status = "OK" | "damaged" | "destroyed" | "hidden";
type Position = [id: string, status: Status, lat: number, lng: number];

const TZ = "Europe/Paris";
const STALE_MS = 2 * 60 * 1000;
/** Les positions bougent peu : même fraîcheur côté navigateur que le cache du Worker. */
const POSITIONS_STALE_MS = 6 * 60 * 60 * 1000;
const PARIS: L.LatLngTuple = [48.8606, 2.3522];
/** Les distances sont à vol d'oiseau : les rues rallongent la marche d'environ un tiers. */
const DETOUR = 1.3;
const WALK_M_PER_MIN = 4500 / 60;
/** Google Maps n'accepte que 9 étapes intermédiaires dans une URL. */
const GMAPS_MAX_WAYPOINTS = 9;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => n.toLocaleString("fr-FR");

/** "PA_01" et "PA_1" désignent le même invader selon les sources. */
const normId = (id: string) => {
  const [city, num] = id.split("_");
  return num && /^\d+$/.test(num) ? `${city}_${Number(num)}` : id;
};

const parisDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

const parisTime = (d: Date) =>
  new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d);

const shiftDay = (day: string, delta: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

const minutesOf = (flashedAt: string) => {
  const [h, m] = flashedAt.slice(11, 16).split(":").map(Number);
  return h * 60 + m;
};

const duration = (mins: number) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
};

const STATUS_LABEL: Record<Status, string> = {
  OK: "intact",
  damaged: "abîmé",
  destroyed: "détruit",
  hidden: "masqué",
};

/* ---------------- état */

let gallery: Gallery | null = null;
let positions = new Map<string, { status: Status; latlng: L.LatLngTuple }>();
let selectedDay = parisDate(new Date());
let lastFetch = 0;
const markers = new Map<string, L.CircleMarker>();

const setPositions = (raw: Position[]) => {
  positions = new Map(raw.map(([id, status, lat, lng]) => [normId(id), { status, latlng: [lat, lng] }]));
};

const showPlayer = (p: Gallery["player"]) => {
  $("player").textContent = `${p.name} · ${fmt(p.found)} invaders · ${fmt(p.score)} pts · #${fmt(p.rank)}`;
};

/* ---------------- carte */

const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView(PARIS, 13);
L.control.zoom({ position: "topright" }).addTo(map);

const dark = window.matchMedia("(prefers-color-scheme: dark)");
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
dark.addEventListener("change", () => render());

const layers = {
  gone: L.layerGroup(),
  done: L.layerGroup(),
  todo: L.layerGroup(),
  day: L.layerGroup(),
};
const filters: Record<keyof typeof layers, HTMLInputElement> = {
  day: $("f-day"),
  todo: $("f-todo"),
  done: $("f-done"),
  gone: $("f-gone"),
};
(Object.keys(layers) as (keyof typeof layers)[]).forEach((k) => {
  const sync = () => (filters[k].checked ? layers[k].addTo(map) : layers[k].remove());
  filters[k].addEventListener("change", sync);
  sync();
});

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function popupHtml(id: string, flash: Flash | undefined, status: Status | undefined) {
  const bits = [`<strong class="pop-id">${id}</strong>`];
  if (status) bits.push(`<span class="pop-status">${STATUS_LABEL[status]}</span>`);
  if (flash) {
    const [d, t] = [flash.flashedAt.slice(0, 10), flash.flashedAt.slice(11, 16)];
    const when = d === selectedDay ? `à ${t}` : `le ${new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}`;
    bits.push(`<span>Flashé ${when} · ${flash.points} pts</span>`);
    bits.push(`<img src="${flash.image}" alt="Mosaïque ${id}" loading="lazy" width="120" height="120" />`);
  } else {
    bits.push(`<span>Pas encore flashé</span>`);
  }
  return `<div class="pop">${bits.join("")}</div>`;
}

function render() {
  Object.values(layers).forEach((l) => l.clearLayers());
  markers.clear();

  const flashes = new Map((gallery?.flashes ?? []).map((f) => [normId(f.id), f]));
  const style = {
    day: { radius: 9, color: css("--ink"), weight: 2, fillColor: css("--day"), fillOpacity: 1 },
    todo: { radius: 5, color: css("--map-ring"), weight: 1, fillColor: css("--todo"), fillOpacity: 0.95 },
    done: { radius: 4, color: css("--map-ring"), weight: 1, fillColor: css("--done"), fillOpacity: 0.7 },
    gone: { radius: 3, color: css("--gone"), weight: 1, fillColor: css("--gone"), fillOpacity: 0.6 },
  };

  for (const [id, pos] of positions) {
    const flash = flashes.get(id);
    const kind: keyof typeof layers = flash
      ? flash.flashedAt.startsWith(selectedDay)
        ? "day"
        : "done"
      : pos.status === "OK" || pos.status === "damaged"
        ? "todo"
        : "gone";
    const m = L.circleMarker(pos.latlng, style[kind]).bindPopup(popupHtml(id, flash, pos.status));
    m.addTo(layers[kind]);
    markers.set(id, m);
  }
  renderDay();
  if (route) drawRoute();
}

/* ---------------- parcours */

let route: { start: Point; count: number; loop: boolean } | null = null;
const routeLayer = L.layerGroup().addTo(map);

const isTodo = (id: string, status: Status, flashed: Set<string>) =>
  !flashed.has(id) && (status === "OK" || status === "damaged");

const km = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km`);

function gmapsUrl(start: Point, stops: Point[], loop: boolean): string | null {
  const dest = loop ? start : stops.at(-1)!;
  const waypoints = loop ? stops : stops.slice(0, -1);
  if (waypoints.length > GMAPS_MAX_WAYPOINTS) return null;
  const ll = (p: Point) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const q = new URLSearchParams({ api: "1", origin: ll(start), destination: ll(dest), travelmode: "walking" });
  if (waypoints.length) q.set("waypoints", waypoints.map(ll).join("|"));
  return `https://www.google.com/maps/dir/?${q}`;
}

function drawRoute() {
  routeLayer.clearLayers();
  if (!route) return;
  const flashed = new Set((gallery?.flashes ?? []).map((f) => normId(f.id)));
  const todo = [...positions]
    .filter(([id, p]) => isTodo(id, p.status, flashed))
    .map(([id, p]) => ({ id, lat: p.latlng[0], lng: p.latlng[1] }));
  const picked = nearest(route.start, todo, route.count);

  if (!picked.length) {
    $("route-result").hidden = true;
    setStatus("Plus aucun invader à flasher dans le coin.", true);
    return;
  }

  const { order, length } = shortestPath([route.start, ...picked], route.loop);
  const stops = order.slice(1).map((i) => picked[i - 1]);
  const line: L.LatLngTuple[] = [route.start, ...stops].map((p) => [p.lat, p.lng]);
  if (route.loop) line.push([route.start.lat, route.start.lng]);

  L.polyline(line, { color: css("--route"), weight: 4, opacity: 0.9, dashArray: "1 8", lineCap: "round" }).addTo(routeLayer);
  L.circleMarker([route.start.lat, route.start.lng], { radius: 6, color: css("--ink"), weight: 2, fillColor: css("--surface"), fillOpacity: 1 })
    .bindTooltip("Départ")
    .addTo(routeLayer);
  stops.forEach((p, i) =>
    L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: "route-pin", html: String(i + 1), iconSize: [22, 22] }),
      keyboard: false,
    })
      .on("click", () => markers.get(p.id)?.openPopup())
      .addTo(routeLayer),
  );

  const walk = Math.round((length * DETOUR) / WALK_M_PER_MIN);
  $("route-summary").textContent =
    `${stops.length} invader${stops.length > 1 ? "s" : ""} · ${km(length)} à vol d'oiseau · ≈ ${duration(walk)} à pied` +
    (stops.length < route.count ? ` (seulement ${stops.length} à flasher dans le coin)` : "");

  const list = $("route-stops");
  list.replaceChildren(
    ...stops.map((p, i) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      const leg = haversine(i === 0 ? route!.start : stops[i - 1], p);
      btn.innerHTML = `<span class="n">${i + 1}</span><span class="t">${km(leg)}</span><span class="id">${p.id}</span>`;
      btn.addEventListener("click", () => {
        map.setView([p.lat, p.lng], Math.max(map.getZoom(), 17));
        markers.get(p.id)?.openPopup();
        if (window.matchMedia("(max-width: 760px)").matches) setCollapsed(true);
      });
      li.append(btn);
      return li;
    }),
  );

  const url = gmapsUrl(route.start, stops, route.loop);
  const link = $<HTMLAnchorElement>("route-gmaps");
  link.hidden = !url;
  if (url) link.href = url;
  $("route-result").hidden = false;
}

/** Départ : la position GPS si on l'a, sinon on la demande, sinon le centre de la carte. */
function routeStart(): Promise<{ point: Point; label: string }> {
  if (me) return Promise.resolve({ point: me.getLatLng(), label: "depuis ta position" });
  const center = () => ({ point: map.getCenter(), label: "depuis le centre de la carte" });
  if (!navigator.geolocation) return Promise.resolve(center());
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        showMe(L.latLng(pos.coords.latitude, pos.coords.longitude));
        resolve({ point: me!.getLatLng(), label: "depuis ta position" });
      },
      () => resolve(center()),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    ),
  );
}

$("route-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("route-count");
  const count = Math.round(Number(input.value));
  if (!input.checkValidity() || !count) {
    input.reportValidity();
    return;
  }
  if (!positions.size) {
    setStatus("Les positions des invaders ne sont pas encore chargées.", true);
    return;
  }
  const btn = $<HTMLButtonElement>("route-go");
  btn.disabled = true;
  setStatus("Recherche du point de départ…");
  try {
    const { point, label } = await routeStart();
    route = { start: { lat: point.lat, lng: point.lng }, count, loop: $<HTMLInputElement>("route-loop").checked };
    drawRoute();
    const line = routeLayer.getLayers().find((l): l is L.Polyline => l instanceof L.Polyline);
    if (line) map.fitBounds(line.getBounds(), { padding: [48, 48], maxZoom: 17 });
    if (!$("route-result").hidden) setStatus(`Parcours calculé ${label}.`);
  } finally {
    btn.disabled = false;
  }
});

$("route-clear").addEventListener("click", () => {
  route = null;
  routeLayer.clearLayers();
  $("route-result").hidden = true;
  setStatus("");
});

/* ---------------- panneau */

function renderDay() {
  const list = $("flashes");
  list.replaceChildren();
  const dayFlashes = (gallery?.flashes ?? [])
    .filter((f) => f.flashedAt.startsWith(selectedDay))
    .sort((a, b) => a.flashedAt.localeCompare(b.flashedAt));

  const points = dayFlashes.reduce((s, f) => s + f.points, 0);
  $("stat-count").textContent = gallery ? fmt(dayFlashes.length) : "–";
  $("stat-points").textContent = gallery ? fmt(points) : "–";
  $("stat-span").textContent =
    dayFlashes.length > 1
      ? duration(minutesOf(dayFlashes.at(-1)!.flashedAt) - minutesOf(dayFlashes[0].flashedAt))
      : "–";

  if (gallery && !dayFlashes.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Aucun flash ce jour-là.";
    list.append(li);
  }

  const cityName = new Map(gallery?.cities.map((c) => [c.id, c.name]));
  dayFlashes.forEach((f, i) => {
    const id = normId(f.id);
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `<span class="n">${i + 1}</span><span class="t">${f.flashedAt.slice(11, 16)}</span><span class="id">${f.id}</span><span class="pts">${f.points}</span>`;
    const marker = markers.get(id);
    if (marker) {
      btn.addEventListener("click", () => {
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 17));
        marker.openPopup();
        if (window.matchMedia("(max-width: 760px)").matches) setCollapsed(true);
      });
    } else {
      btn.disabled = true;
      btn.title = `Position inconnue (${cityName.get(f.cityId) ?? "ville inconnue"})`;
    }
    li.append(btn);
    list.append(li);
  });

  $<HTMLInputElement>("day").value = selectedDay;
  $<HTMLButtonElement>("next-day").disabled = selectedDay >= parisDate(new Date());
}

function fitDay() {
  const pts = (gallery?.flashes ?? [])
    .filter((f) => f.flashedAt.startsWith(selectedDay))
    .map((f) => markers.get(normId(f.id))?.getLatLng())
    .filter((p): p is L.LatLng => !!p);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 17 });
}

function setStatus(text: string, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Erreur ${res.status}`);
  return body as T;
}

async function refresh({ fit = false } = {}) {
  const btn = $<HTMLButtonElement>("refresh");
  btn.disabled = true;
  btn.classList.add("spinning");
  setStatus("Mise à jour…");
  const before = new Set(gallery?.flashes.map((f) => f.id));
  try {
    gallery = await getJson<Gallery>("/api/gallery");
    lastFetch = Date.now();
    writeCache("gallery", gallery);
    showPlayer(gallery.player);
    const fresh = before.size ? gallery.flashes.filter((f) => !before.has(f.id)).length : 0;
    render();
    if (fit) fitDay();
    setStatus(
      `Mis à jour à ${parisTime(new Date(gallery.fetchedAt))}` +
        (fresh ? ` · ${fresh} nouveau${fresh > 1 ? "x" : ""}` : ""),
    );
  } catch (e) {
    const fallback = gallery ? ` Affichage du dernier scan (${parisTime(new Date(gallery.fetchedAt))}).` : " Réessaie dans un instant.";
    setStatus(`${(e as Error).message}${fallback}`, true);
  } finally {
    btn.disabled = false;
    btn.classList.remove("spinning");
  }
}

/* ---------------- interactions */

$("refresh").addEventListener("click", () => refresh());

const goToDay = (day: string) => {
  selectedDay = day;
  render();
  fitDay();
};
$<HTMLInputElement>("day").addEventListener("change", (e) => {
  const v = (e.target as HTMLInputElement).value;
  if (v) goToDay(v);
});
$("prev-day").addEventListener("click", () => goToDay(shiftDay(selectedDay, -1)));
$("next-day").addEventListener("click", () => goToDay(shiftDay(selectedDay, 1)));

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastFetch > STALE_MS) refresh();
});

const panel = $("panel");
const setCollapsed = (collapsed: boolean) => {
  panel.classList.toggle("collapsed", collapsed);
  $("grab").setAttribute("aria-expanded", String(!collapsed));
  setTimeout(() => map.invalidateSize(), 220);
};
$("grab").addEventListener("click", () => setCollapsed(!panel.classList.contains("collapsed")));

let me: L.CircleMarker | null = null;
$("locate").addEventListener("click", () => {
  setStatus("Localisation…");
  map.locate({ setView: true, maxZoom: 17, enableHighAccuracy: true });
});
function showMe(latlng: L.LatLng) {
  me?.remove();
  me = L.circleMarker(latlng, { radius: 7, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1 }).addTo(map);
}
map.on("locationfound", (e) => {
  showMe(e.latlng);
  setStatus(`Position trouvée (± ${Math.round(e.accuracy)} m)`);
});
map.on("locationerror", () => setStatus("Localisation refusée ou indisponible. Autorise-la dans les réglages du navigateur.", true));

/* ---------------- démarrage */

/** Renvoie vrai quand les positions ont pu être rechargées depuis le réseau. */
async function loadPositions(): Promise<boolean> {
  try {
    const raw = await getJson<Position[]>("/api/positions");
    setPositions(raw);
    writeCache("positions", raw);
    return true;
  } catch (e) {
    // Une révalidation en fond qui échoue est muette : les positions en cache restent affichées.
    if (!positions.size) setStatus(`Carte des positions indisponible : ${(e as Error).message}`, true);
    return false;
  }
}

(async () => {
  const cachedPositions = readCache<Position[]>("positions");
  const cachedGallery = readCache<Gallery>("gallery");
  if (cachedPositions) setPositions(cachedPositions.data);
  if (cachedGallery) {
    gallery = cachedGallery.data;
    lastFetch = cachedGallery.savedAt;
    showPlayer(gallery.player);
  }
  render();
  if (cachedGallery) {
    fitDay();
    setStatus(`Dernier scan à ${parisTime(new Date(cachedGallery.data.fetchedAt))}`);
  }

  // Sans positions en cache il n'y a rien à dessiner : on attend le réseau, sinon on révalide en fond.
  if (!cachedPositions) {
    if (await loadPositions()) render();
  } else if (Date.now() - cachedPositions.savedAt > POSITIONS_STALE_MS) {
    void loadPositions().then((ok) => ok && render());
  }

  if (!cachedGallery || Date.now() - cachedGallery.savedAt > STALE_MS) {
    await refresh({ fit: !cachedGallery });
  }
})();
