// Gallery Downloader module (SPEC 6): paste a URL and press Download. No preview read (some sites pause seconds
// per file, so reading first doubled the time): gallery-dl downloads the URL straight into the queue (pause / stop
// there) with every filter as one "image-filter" expression (gallery-filter.ts) in a per-job config file.
// Cookies: every site can have them; the first download from a site asks once (cookiesModal `first`).
import { invoke } from "@tauri-apps/api/core";
import { toolStatus, binariesReady } from "../binaries";
import { cookieArgs, cookieLabel, cookiesAsked, cookiesModal } from "../cookies";
import { cookieSite } from "../cookies-validate";
import { banner, clearers, h, memory } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, Step } from "../queue";
import { eagleControls, folderField, paths } from "./common";
import { Filters, filterExpr, Kind } from "./gallery-filter";

type Prefs = { folder: string; eagle: boolean; filters: Filters; url: string };

const DEFAULT_FILTERS: Filters = {
  types: { image: true, video: true, gif: true }, extOff: [], minW: 0, minH: 0,
  sizeMin: 0, sizeMax: 0, dateFrom: "", dateTo: "", limit: 1000, skipDownloaded: true, titleHas: "", titleNot: "",
};

export function renderGallery(view: HTMLElement) {
  const { state: prefs, save } = memory<Prefs>("gallery", { folder: "", eagle: true, url: "", filters: DEFAULT_FILTERS });
  prefs.filters = { ...DEFAULT_FILTERS, ...prefs.filters, types: { ...DEFAULT_FILTERS.types, ...prefs.filters.types } };

  const page = h(`<div class="page gallery">
    <div class="head">
      <div><h3>Gallery Downloader</h3><div class="sub">Images and videos from galleries, profiles and posts</div></div>
      <div class="right"><span class="chip" id="g-tool"><span class="dot"></span>gallery-dl</span>
        <button class="chip chip-btn" id="g-cookies" hidden>${icon("cookie")}<span></span></button></div>
    </div>
    <form class="url" id="g-form">
      <label class="field">${icon("link")}<input id="g-url" placeholder="Paste a gallery, profile or post URL" autocomplete="off" spellcheck="false"></label>
      <button class="btn primary" id="g-add" type="submit">${icon("download")}Download</button>
    </form>
    <div class="g-body">
      <div class="g-results"><div class="sub g-how">Hermes downloads everything at the URL that passes the filters, straight into the queue below: pause or stop it there. Already downloaded files are skipped.</div></div>
      <aside class="g-filters" id="g-filters"></aside>
    </div>
    <div class="opts one"></div>
    <div class="row2"></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  const urlInput = $<HTMLInputElement>("#g-url");
  page.querySelector(".opts")!.append(folderField(prefs, save, "g-folder"));
  page.querySelector(".row2")!.prepend(...eagleControls(prefs, save, "g-eagle"));

  toolStatus("gallery-dl").then((s) => {
    $("#g-tool").lastChild!.textContent = s?.version ? `gallery-dl ${s.version}` : "gallery-dl missing";
    $("#g-tool").classList.toggle("bad", !s?.ok);
  });

  // ----- cookies: the chip follows the site of the typed URL -----
  const cookieChip = $<HTMLButtonElement>("#g-cookies");
  const site = () => cookieSite(urlInput.value.trim());
  const refreshCookies = async () => {
    const s = site();
    cookieChip.hidden = !s;
    if (s) {
      cookieChip.querySelector("span")!.textContent = cookiesAsked(s) ? await cookieLabel(s) : "Cookies";
      cookieChip.title = `Cookies for ${s}`;
    }
  };
  cookieChip.onclick = async () => { if (site() && (await cookiesModal(site()))) refreshCookies(); };

  // ----- filters panel (applied by gallery-dl to every file) -----
  const fp = $("#g-filters");
  function renderFilters() {
    const f = prefs.filters;
    fp.innerHTML = `
      <div class="f-group"><div class="field-label">Title contains</div>
        <input type="text" data-text="titleHas" placeholder="e.g. sketch, wip"><div class="sub">Any of the words (comma separated)</div></div>
      <div class="f-group"><div class="field-label">Title excludes</div>
        <input type="text" data-text="titleNot" placeholder="e.g. ad, promo"></div>
      <div class="f-group"><div class="field-label">Media type</div>
        ${(["image", "video", "gif"] as Kind[]).map((k) => `<label class="f-check"><input type="checkbox" data-type="${k}" ${f.types[k] ? "checked" : ""}>${k === "gif" ? "GIFs" : k === "image" ? "Images" : "Videos"}</label>`).join("")}</div>
      <div class="f-group"><div class="field-label">Skip extensions</div>
        <input type="text" data-ext placeholder="e.g. webp, zip"></div>
      <div class="f-group"><div class="field-label">Minimum resolution</div>
        <div class="f-pair"><input type="number" min="0" step="100" data-num="minW" value="${f.minW || ""}" placeholder="Width"><span>×</span><input type="number" min="0" step="100" data-num="minH" value="${f.minH || ""}" placeholder="Height"></div></div>
      <div class="f-group"><div class="field-label">Date</div>
        <div class="f-pair"><input type="date" data-str="dateFrom" value="${f.dateFrom}"><span>to</span><input type="date" data-str="dateTo" value="${f.dateTo}"></div></div>
      <div class="f-group"><div class="field-label">File size (MB)</div>
        <div class="f-pair"><input type="number" min="0" data-num="sizeMin" value="${f.sizeMin || ""}" placeholder="Min"><span>to</span><input type="number" min="0" data-num="sizeMax" value="${f.sizeMax || ""}" placeholder="Max"></div></div>
      <div class="f-group"><div class="field-label">Download at most</div>
        <input type="number" min="1" step="50" data-num="limit" value="${f.limit}"><div class="sub">Files, counted after the filters</div></div>
      <label class="f-check"><input type="checkbox" data-bool="skipDownloaded" ${f.skipDownloaded ? "checked" : ""}>Skip already downloaded</label>`;
    fp.querySelectorAll<HTMLInputElement>("[data-text]").forEach((t) => (t.value = (f as any)[t.dataset.text!]));
    fp.querySelector<HTMLInputElement>("[data-ext]")!.value = f.extOff.join(", ");
  }
  fp.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.text) (prefs.filters as any)[t.dataset.text] = t.value;
    else if (t.dataset.ext !== undefined) prefs.filters.extOff = t.value.split(",").map((x) => x.trim().replace(/^\./, "").toLowerCase()).filter(Boolean);
    else return;
    save(true);
  });
  fp.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    const f = prefs.filters;
    if (t.dataset.type) f.types[t.dataset.type as Kind] = t.checked;
    if (t.dataset.num) (f as any)[t.dataset.num] = Math.max(0, Number(t.value) || 0) || (t.dataset.num === "limit" ? DEFAULT_FILTERS.limit : 0);
    if (t.dataset.str) (f as any)[t.dataset.str] = t.value;
    if (t.dataset.bool) (f as any)[t.dataset.bool] = t.checked;
    save();
  });
  clearers.set("gallery", () => { prefs.url = ""; save(); });

  // ----- download -----
  const addBtn = $<HTMLButtonElement>("#g-add");
  const sync = () => { addBtn.disabled = !site(); };
  urlInput.addEventListener("input", () => { prefs.url = urlInput.value; save(true); sync(); refreshCookies(); });
  $<HTMLFormElement>("#g-form").onsubmit = async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    const s = cookieSite(url);
    if (!s) return;
    if (!cookiesAsked(s)) { await cookiesModal(s, undefined, true); refreshCookies(); } // first download from this site: ask once
    await binariesReady;
    const f = prefs.filters;
    const { data } = await paths;
    const config = await invoke<string>("write_job_file", {
      name: `gallery-${Date.now()}.json`,
      text: JSON.stringify({ extractor: { "image-filter": filterExpr(f) } }),
    });
    const args = [
      "--config", config, "-d", prefs.folder, "--range", `1-${f.limit}`,
      "--sleep", "0.5-1.5", // polite spacing between files; sites answer bursts with 429
      ...(f.sizeMin ? ["--filesize-min", `${f.sizeMin}M`] : []), ...(f.sizeMax ? ["--filesize-max", `${f.sizeMax}M`] : []),
      ...(f.skipDownloaded ? ["--download-archive", `${data}\\gallery-archive.sqlite3`] : []),
      ...(await cookieArgs(s)), url,
    ];
    // duration < 0: the total is unknown, at most |duration| files (the queue shows "n files")
    const steps: Step[] = [{ type: "run", label: "Downloading", bin: "gallery-dl.exe", parser: "galleryDl", duration: -f.limit, args }];
    if (prefs.eagle) steps.push({ type: "eagle" });
    const path = url.replace(/^https?:\/\/[^/]+\/?/, "").slice(0, 60);
    await addJobs([{ module: "gallery", title: path ? `${s} · ${path}` : s, pill: s, steps, eagle: { website: url, tags: [url] } }]);
    banner({ id: "gallery-added", icon: "check", text: "Download started. Pause or stop it in the queue below; closing Hermes resumes it next time." });
    urlInput.value = prefs.url = "";
    save();
    sync();
    refreshCookies();
  };

  renderFilters();
  urlInput.value = prefs.url;
  sync();
  refreshCookies();
  mountQueue(page, "gallery");
  view.append(page);
}
