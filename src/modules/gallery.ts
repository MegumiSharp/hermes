// Gallery Downloader module (SPEC 6): gallery-dl with a preview grid and built-in filters.
// Hermes reads only a preview (the first PREVIEW files: some sites pause seconds per file, e-hentai ~4 s),
// then gallery-dl downloads the whole URL in one pass with the filters and manual picks as one
// "image-filter" expression (gallery-filter.ts) in a per-job config file (no command-line length limit).
import { invoke } from "@tauri-apps/api/core";
import { toolStatus, binariesReady } from "../binaries";
import { cookieArgs, cookieLabel, cookiesModal, isCookieError, markBroken } from "../cookies";
import { SITES, siteForUrl } from "../cookies-validate";
import { banner, clearers, h, memory, saveSettingsSoon, settings } from "../core";
import { icon } from "../icons";
import { addJobs, mountQueue, Step } from "../queue";
import { eagleControls, folderField, liveStatus, paths } from "./common";
import { Filters, filterExpr, Kind, kindOf, TEXT_KEYS, words } from "./gallery-filter";

const PREVIEW = 60;
type Prefs = { folder: string; eagle: boolean; filters: Filters; url: string; offKeys: string[]; previews: boolean };
type Item = {
  key: string; url: string; ext: string; kind: Kind; w: number; h: number; date: number | null; author: string; off: boolean;
  title: string; // post title / description / caption, for text filters and the list view
};

const DEFAULT_FILTERS: Filters = {
  types: { image: true, video: true, gif: true }, extOff: [], minW: 0, minH: 0,
  sizeMin: 0, sizeMax: 0, dateFrom: "", dateTo: "", limit: 200, skipDownloaded: true, titleHas: "", titleNot: "",
};
const textOf = (m: Record<string, any>) =>
  TEXT_KEYS.map((k) => m[k]).find((v) => typeof v === "string" && v.trim())?.replace(/\s+/g, " ").trim() ?? "";

/** Author/user name: extractors name it differently and sometimes nest it. */
function authorOf(m: Record<string, any>): string {
  for (const k of ["author", "user", "artist", "username", "uploader", "owner", "creator", "channel"]) {
    const v = m[k];
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object") {
      const n = v.name ?? v.nick ?? v.username ?? v.display_name;
      if (typeof n === "string" && n) return n;
    }
  }
  return "";
}

/** gallery-dl dates are "YYYY-MM-DD HH:MM:SS" strings (UTC). */
const parseDate = (d: unknown) => (typeof d === "string" && /^\d{4}-\d\d-\d\d/.test(d) ? Date.parse(d.replace(" ", "T") + "Z") : null);

/** Messages from `gallery-dl -j`: [3, url, meta] is a file. */
function parse(messages: unknown[]): { items: Item[]; category: string; queued: number; total: number } {
  const items: Item[] = [];
  let category = "";
  let queued = 0;
  let total = 0; // files at the URL, when the site says (e-hentai "filecount", some "count")
  for (const m of messages as any[]) {
    if (!Array.isArray(m)) continue;
    if (m[0] === 6) queued++;
    if (m[0] !== 3 || typeof m[1] !== "string") continue;
    const meta = m[2] ?? {};
    category ||= meta.category ?? "";
    total ||= Number(meta.filecount ?? meta.count) || 0;
    const ext = String(meta.extension ?? m[1].split("?")[0].split(".").pop() ?? "").toLowerCase();
    items.push({
      key: `${meta.filename ?? ""}.${ext}`, url: m[1], ext, kind: kindOf(ext),
      w: Number(meta.width) || 0, h: Number(meta.height) || 0, date: parseDate(meta.date), author: authorOf(meta), off: false,
      title: textOf(meta),
    });
  }
  return { items, category, queued, total };
}

function passes(i: Item, f: Filters): boolean {
  if (!f.types[i.kind] || f.extOff.includes(i.ext)) return false;
  // unknown dimensions/dates pass: not every site reports them
  if (f.minW && i.w && i.w < f.minW) return false;
  if (f.minH && i.h && i.h < f.minH) return false;
  if (f.dateFrom && i.date && i.date < Date.parse(f.dateFrom)) return false;
  if (f.dateTo && i.date && i.date > Date.parse(f.dateTo) + 86400000 - 1) return false;
  const text = `${i.title} ${i.key}`.toLowerCase();
  const has = words(f.titleHas), not = words(f.titleNot);
  if (has.length && !has.some((w) => text.includes(w))) return false; // any of the words
  if (not.some((w) => text.includes(w))) return false;
  return true;
}


// module scope: a read started on an earlier visit finishes into the page that is open now (`ui`),
// and coming back to the tool shows the list already read instead of reading it again
let items: Item[] = [];
let source = { url: "", category: "", total: 0 };
let probing = 0;
let reading = false;
const live = liveStatus("gallery-read");
let ui = { loading: (_on: boolean) => {}, show: () => {}, fail: (_msg: string) => {} };

export function renderGallery(view: HTMLElement) {
  const { state: prefs, save } = memory<Prefs>("gallery", { folder: "", eagle: true, url: "", offKeys: [], previews: false, filters: DEFAULT_FILTERS });
  prefs.filters = { ...DEFAULT_FILTERS, ...prefs.filters, types: { ...DEFAULT_FILTERS.types, ...prefs.filters.types } };
  /** Manual picks survive restarts: stored as the keys of the files turned off. */
  const saveOff = () => { prefs.offKeys = items.filter((i) => i.off).map((i) => i.key); save(); };

  const page = h(`<div class="page gallery">
    <div class="head">
      <div><h3>Gallery Downloader</h3><div class="sub">Images and videos from galleries, profiles and posts</div></div>
      <div class="right"><span class="chip" id="g-tool"><span class="dot"></span>gallery-dl</span>
        <button class="chip chip-btn" id="g-cookies" hidden>${icon("cookie")}<span></span></button></div>
    </div>
    <form class="url" id="g-form">
      <label class="field">${icon("link")}<input id="g-url" placeholder="Paste a gallery, profile or post URL" autocomplete="off" spellcheck="false"></label>
      <button class="btn" id="g-fetch" type="submit">Fetch</button>
    </form>
    <div class="g-body">
      <div class="g-results">
        <div id="g-live"></div>
        <div class="g-bar"><span id="g-summary" class="sub">Fetch a URL to preview its files</span>
          <div class="right"><label class="f-check g-prev"><input type="checkbox" id="g-previews">Show previews</label>
            <button class="btn sm ghost" id="g-all">Select all</button><button class="btn sm ghost" id="g-none">Select none</button></div></div>
        <div class="g-grid" id="g-grid"></div>
      </div>
      <aside class="g-filters" id="g-filters"></aside>
    </div>
    <div class="opts one"></div>
    <div class="row2"><button class="btn primary" id="g-add" disabled>${icon("download")}Add to queue</button></div>
  </div>`);
  const $ = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  const grid = $("#g-grid");
  const addBtn = $<HTMLButtonElement>("#g-add");
  page.querySelector(".opts")!.append(folderField(prefs, save, "g-folder"));
  page.querySelector(".row2")!.prepend(...eagleControls(prefs, save, "g-eagle"));

  toolStatus("gallery-dl").then((s) => {
    $("#g-tool").lastChild!.textContent = s?.version ? `gallery-dl ${s.version}` : "gallery-dl missing";
    $("#g-tool").classList.toggle("bad", !s?.ok);
  });

  // ----- cookies (only for sites we know how to validate) -----
  const site = () => (SITES[source.category] ? source.category : "");
  const cookieChip = $<HTMLButtonElement>("#g-cookies");
  const refreshCookies = async () => {
    cookieChip.hidden = !site();
    if (site()) cookieChip.querySelector("span")!.textContent = await cookieLabel(site());
  };
  cookieChip.onclick = async () => { if (await cookiesModal(site())) { refreshCookies(); probe(); } };
  const siteCookies = async (category: string) => (SITES[category] ? cookieArgs(category) : []);

  // ----- filters panel -----
  const fp = $("#g-filters");
  function renderFilters() {
    const f = prefs.filters;
    const exts = [...new Set(items.map((i) => i.ext))].sort();
    fp.innerHTML = `
      <div class="f-group"><div class="field-label">Title contains</div>
        <input type="text" data-text="titleHas" placeholder="e.g. sketch, wip"><div class="sub">Any of the words (comma separated)</div></div>
      <div class="f-group"><div class="field-label">Title excludes</div>
        <input type="text" data-text="titleNot" placeholder="e.g. ad, promo"></div>
      <div class="f-group"><div class="field-label">Media type</div>
        ${(["image", "video", "gif"] as Kind[]).map((k) => `<label class="f-check"><input type="checkbox" data-type="${k}" ${f.types[k] ? "checked" : ""}>${k === "gif" ? "GIFs" : k === "image" ? "Images" : "Videos"}<span class="sub">${items.filter((i) => i.kind === k).length}</span></label>`).join("")}</div>
      ${exts.length ? `<div class="f-group"><div class="field-label">Extensions</div><div class="f-exts">
        ${exts.map((e) => `<button type="button" class="f-ext ${f.extOff.includes(e) ? "" : "on"}" data-ext="${e}">${e}</button>`).join("")}</div></div>` : ""}
      <div class="f-group"><div class="field-label">Minimum resolution</div>
        <div class="f-pair"><input type="number" min="0" step="100" data-num="minW" value="${f.minW || ""}" placeholder="Width"><span>×</span><input type="number" min="0" step="100" data-num="minH" value="${f.minH || ""}" placeholder="Height"></div></div>
      <div class="f-group"><div class="field-label">Date</div>
        <div class="f-pair"><input type="date" data-str="dateFrom" value="${f.dateFrom}"><span>to</span><input type="date" data-str="dateTo" value="${f.dateTo}"></div></div>
      <div class="f-group"><div class="field-label">File size (MB)</div>
        <div class="f-pair"><input type="number" min="0" data-num="sizeMin" value="${f.sizeMin || ""}" placeholder="Min"><span>to</span><input type="number" min="0" data-num="sizeMax" value="${f.sizeMax || ""}" placeholder="Max"></div>
        <div class="sub">Checked while downloading</div></div>
      <div class="f-group"><div class="field-label">Download at most</div>
        <input type="number" min="1" step="50" data-num="limit" value="${f.limit}"><div class="sub">Files, counted after the filters. The preview shows the first ${PREVIEW}.</div></div>
      <label class="f-check"><input type="checkbox" data-bool="skipDownloaded" ${f.skipDownloaded ? "checked" : ""}>Skip already downloaded</label>`;
    fp.querySelectorAll<HTMLInputElement>("[data-text]").forEach((t) => (t.value = (f as any)[t.dataset.text!]));
  }
  fp.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (!t.dataset.text) return;
    (prefs.filters as any)[t.dataset.text] = t.value; // live while typing
    save(true);
    renderGrid();
  });
  fp.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    const f = prefs.filters;
    if (t.dataset.type) f.types[t.dataset.type as Kind] = t.checked;
    if (t.dataset.num) (f as any)[t.dataset.num] = Math.max(0, Number(t.value) || 0) || (t.dataset.num === "limit" ? 200 : 0);
    if (t.dataset.str) (f as any)[t.dataset.str] = t.value;
    if (t.dataset.bool) (f as any)[t.dataset.bool] = t.checked;
    save();
    renderGrid();
  });
  fp.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ext]");
    if (!b) return;
    const off = prefs.filters.extOff;
    const ext = b.dataset.ext!;
    prefs.filters.extOff = off.includes(ext) ? off.filter((x) => x !== ext) : [...off, ext];
    b.classList.toggle("on");
    save();
    renderGrid();
  });

  // ----- grid -----
  const selected = () => items.filter((i) => !i.off && passes(i, prefs.filters));
  /** The preview is only the start of the URL: more files than it shows. */
  const partial = () => items.length >= PREVIEW || source.total > items.length;
  /** How many files the download will take: known exactly only when the preview holds everything. */
  const expected = () => {
    const f = prefs.filters;
    if (!partial()) return Math.min(selected().length, f.limit);
    return Math.min(source.total || f.limit, f.limit);
  };
  function renderGrid() {
    const visible = items.filter((i) => passes(i, prefs.filters));
    const sel = selected();
    const more = partial()
      ? ` · preview of the first ${items.length}${source.total ? ` of ${source.total}` : ""}: the filters apply to every file, up to ${prefs.filters.limit}`
      : "";
    $("#g-summary").textContent = items.length
      ? `${sel.length} of ${items.length} selected${visible.length < items.length ? ` · ${items.length - visible.length} hidden by filters` : ""}${more}`
      : "Fetch a URL to preview its files";
    addBtn.disabled = partial() ? !items.length : !sel.length;
    $("#g-all").hidden = $("#g-none").hidden = !prefs.previews;
    if (!prefs.previews) {
      // previews off (default): no per-file list, only the counts; the filters decide what downloads
      grid.replaceChildren();
      return;
    }
    grid.replaceChildren(...visible.map((i) => {
      const t = h(`<button type="button" class="tile ${i.off ? "off" : ""}" data-key="" title="">
        ${i.kind === "video" ? `<span class="t-icon">${icon("film")}</span>` : `<img loading="lazy" alt="" referrerpolicy="no-referrer">`}
        <span class="t-check">${icon("check")}</span><span class="t-meta mono"></span></button>`);
      t.dataset.key = i.key;
      t.title = i.title || i.key;
      t.querySelector(".t-meta")!.textContent = [i.ext.toUpperCase(), i.w && i.h ? `${i.w}×${i.h}` : ""].filter(Boolean).join(" · ");
      const img = t.querySelector("img");
      if (img) {
        img.src = i.url;
        img.onerror = () => img.replaceWith(h(`<span class="t-icon">${icon("image")}</span>`)); // hotlink-protected sites
      }
      return t;
    }));
  }
  grid.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(".tile");
    if (!t) return;
    items.filter((i) => i.key === t.dataset.key).forEach((i) => (i.off = !i.off));
    saveOff();
    renderGrid();
  });
  clearers.set("gallery", () => {
    Object.assign(prefs, { url: "", offKeys: [] });
    settings.galleryDraft = "";
    save();
  });
  const previews = $<HTMLInputElement>("#g-previews");
  previews.checked = prefs.previews;
  previews.onchange = () => { prefs.previews = previews.checked; save(); renderGrid(); };
  $("#g-all").onclick = () => { items.forEach((i) => (i.off = false)); saveOff(); renderGrid(); };
  $("#g-none").onclick = () => { items.forEach((i) => (i.off = true)); saveOff(); renderGrid(); };

  $("#g-live").append(live.el);
  ui = {
    loading: (on) => { if (on) { renderGrid(); $("#g-summary").textContent = ""; } grid.classList.toggle("loading", on); },
    show: () => { grid.classList.remove("loading"); refreshCookies(); renderFilters(); renderGrid(); },
    fail: (msg) => fail(msg),
  };

  // ----- probe -----
  async function probe() {
    const url = $<HTMLInputElement>("#g-url").value.trim();
    if (!url) return;
    const id = ++probing;
    items = [];
    reading = true;
    ui.loading(true);
    live.set(`Reading the first ${Math.min(PREVIEW, prefs.filters.limit)} files for the preview`);
    await binariesReady;
    const run = (cookies: string[]) => invoke<unknown[]>("tool_json", {
      id: live.stream(), bin: "gallery-dl.exe", args: ["--resolve-json", "--range", `1-${Math.min(PREVIEW, prefs.filters.limit)}`, ...cookies, url],
    });
    // the category (= cookie site) is only known after a first read
    const known = siteForUrl(url);
    let result: unknown[];
    try {
      result = await run(await siteCookies(known));
    } catch (e) {
      if (!(known && isCookieError(String(e)))) return id === probing && done(() => ui.fail(String(e)));
      markBroken(known);
      cookiesModal(known, String(e)).then((c) => c && probe());
      live.set("Browser cookies unreadable: reading without them");
      try { result = await run([]); } catch (e2) { return id === probing && done(() => ui.fail(String(e2))); }
    }
    if (id !== probing) return;
    reading = false;
    live.done();
    const parsed = parse(result);
    items = parsed.items;
    if (url === prefs.url) items.forEach((i) => (i.off = prefs.offKeys.includes(i.key))); // restore picks for the same URL
    else { prefs.url = url; prefs.offKeys = []; save(); }
    source = { url, category: parsed.category || known, total: parsed.total };
    ui.show();
    if (!items.length) {
      ui.fail(parsed.queued ? "This page only links to other galleries. Open one of them instead." : "No files found at this URL.");
    }
  }
  /** A read that ended without a list. */
  function done(then: () => void) { reading = false; live.done(); then(); return true; }
  function fail(msg: string) {
    live.done();
    grid.classList.remove("loading");
    $("#g-summary").textContent = "";
    grid.replaceChildren(h(`<div class="g-error">${icon("alert")}<span></span></div>`));
    grid.querySelector(".g-error span")!.textContent = msg;
    if (/login|log in|sign in|401|403|cookies/i.test(msg) && site()) {
      const b = h(`<button class="btn sm">${icon("cookie")}Set up cookies</button>`);
      b.onclick = async () => { if (await cookiesModal(site())) probe(); };
      grid.querySelector(".g-error")!.append(b);
    }
  }
  $<HTMLFormElement>("#g-form").onsubmit = (e) => { e.preventDefault(); probe(); };
  $("#g-url").addEventListener("paste", () => setTimeout(probe, 0));
  // typing is remembered; the picks are tied to the URL they were made on (prefs.url updates on fetch)
  $("#g-url").addEventListener("input", () => { settings.galleryDraft = $<HTMLInputElement>("#g-url").value; saveSettingsSoon({}); });

  // ----- add -----
  addBtn.onclick = async () => {
    const sel = selected();
    if (!sel.length && !partial()) return;
    const f = prefs.filters;
    const n = expected();
    const { data } = await paths;
    // one pass over the whole URL: gallery-dl applies the filters and skips the files turned off in the preview
    const off = [...new Set(items.filter((i) => i.off).map((i) => i.key))];
    const config = await invoke<string>("write_job_file", {
      name: `gallery-${Date.now()}.json`,
      text: JSON.stringify({ extractor: { "image-filter": filterExpr(f, off) } }),
    });
    const args = [
      "--config", config, "-d", prefs.folder, "--range", `1-${f.limit}`,
      "--sleep", "0.5-1.5", // polite spacing between files; sites answer bursts with 429
      ...(f.sizeMin ? ["--filesize-min", `${f.sizeMin}M`] : []), ...(f.sizeMax ? ["--filesize-max", `${f.sizeMax}M`] : []),
      ...(f.skipDownloaded ? ["--download-archive", `${data}\\gallery-archive.sqlite3`] : []),
      ...(await siteCookies(source.category)), source.url,
    ];
    const steps: Step[] = [{ type: "run", label: "Downloading", bin: "gallery-dl.exe", parser: "galleryDl", duration: n, args }];
    if (prefs.eagle) steps.push({ type: "eagle" });
    const author = sel.find((i) => i.author)?.author ?? "";
    const upTo = partial() ? "up to " : ""; // filters and picks apply to files Hermes has not read
    const title = `${author || source.category || "Gallery"} · ${upTo}${n} file${n > 1 ? "s" : ""}`;
    await addJobs([{ module: "gallery", title, pill: source.category || "gallery", steps, eagle: { website: source.url, tags: [author, source.url].filter(Boolean) } }]);
    banner({ id: "gallery-added", icon: "check", text: `Added <b>${upTo}${n}</b> file${n > 1 ? "s" : ""} to the queue.${partial() ? " The progress is in the queue below; closing Hermes resumes it next time." : ""}` });
  };

  renderFilters();
  renderGrid();
  // restore after a restart: the typed URL, and the last fetched gallery with its picks
  $<HTMLInputElement>("#g-url").value = settings.galleryDraft ?? prefs.url;
  const typed = $<HTMLInputElement>("#g-url").value;
  if (reading) ui.loading(true); // still reading from an earlier visit: it will fill this page
  else if (!(items.length && source.url === typed) && prefs.url && typed === prefs.url) probe(); // first visit after a restart
  mountQueue(page, "gallery");
  view.append(page);
}
