import L from "leaflet";
import "leaflet/dist/leaflet.css";
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
const PARIS: L.LatLngTuple = [48.8606, 2.3522];

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
}

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
    const p = gallery.player;
    $("player").textContent = `${p.name} · ${fmt(p.found)} invaders · ${fmt(p.score)} pts · #${fmt(p.rank)}`;
    const fresh = before.size ? gallery.flashes.filter((f) => !before.has(f.id)).length : 0;
    render();
    if (fit) fitDay();
    setStatus(
      `Mis à jour à ${parisTime(new Date(gallery.fetchedAt))}` +
        (fresh ? ` · ${fresh} nouveau${fresh > 1 ? "x" : ""}` : ""),
    );
  } catch (e) {
    setStatus(`${(e as Error).message} Réessaie dans un instant.`, true);
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
map.on("locationfound", (e) => {
  me?.remove();
  me = L.circleMarker(e.latlng, { radius: 7, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1 }).addTo(map);
  setStatus(`Position trouvée (± ${Math.round(e.accuracy)} m)`);
});
map.on("locationerror", () => setStatus("Localisation refusée ou indisponible. Autorise-la dans les réglages du navigateur.", true));

/* ---------------- démarrage */

(async () => {
  renderDay();
  try {
    const raw = await getJson<Position[]>("/api/positions");
    positions = new Map(raw.map(([id, status, lat, lng]) => [normId(id), { status, latlng: [lat, lng] }]));
  } catch (e) {
    setStatus(`Carte des positions indisponible : ${(e as Error).message}`, true);
  }
  await refresh({ fit: true });
})();
