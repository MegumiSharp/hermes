# Hermes

Portable Windows utility app (no installer) for a content creator. Personal use, public repo
`MegumiSharp/hermes`, unsigned exe is fine.

- Full spec: [docs/SPEC.md](docs/SPEC.md) — read before changing behavior.
- Design: [design/mockups.html](design/mockups.html), chosen **01 Graphite / Amber**. App mark: feather ([design/icon.svg](design/icon.svg)).
- Work in tranches (SPEC section 9); finish, test and commit one before starting the next.
  Done: T0, T1, T2.

## Conventions
- UI text in English. Owner talks in Italian.
- Minimal, dark, one accent color, Lucide line icons. No emoji anywhere in UI.
- Each module is self-contained; adding one touches only the registry in `src/main.ts`.
- Everything the app writes lives in `hermes-data/` next to the exe. Never commit it.
- External tools run hidden (no console window).

## Code map (keep this current; it exists so code doesn't need re-reading)

### Frontend (`src/`, vanilla TS + Vite, top-level await OK)
| File | Contents |
|---|---|
| `main.ts` | Entry. `Module` type `{id,name,icon,section:"tools"\|"system",render(view)}`, `modules[]` registry, `open(id)` (sets `.nav.on`, renders into `#view`, persists `settings.lastModule`), sidebar build, title-bar buttons `#wc-min/#wc-max/#wc-close`, `renderSettings` (ids `#data-path #open-data #update-status #check-update`), calls `startUpdateChecks()` |
| `core.ts` | Shared UI services. `settings` (object loaded from backend), `saveSettings(patch)`, `h(html)` → element, `banner({id,text(html),icon?,tone?:"accent"\|"warn",actions?})` → close fn (one per id, into `#banners`), `modal({title,body,actions?})` → close fn (`actions: []` = no buttons; Esc/backdrop close). `Action = {label,primary?,run?}` (click runs then closes) |
| `icons.ts` | `icon(name)` → SVG string, `IconName`. Add Lucide paths here |
| `update.ts` | `checkForUpdate()` (shows `app-update` banner, throws on error), `startUpdateChecks()` (launch + 6 h, silent), install modal with progress from `update-progress` event |
| `styles.css` | Tokens on `:root` (Graphite/Amber). Components: `.btn(.sm/.primary/.ghost)`, `.card .row .k .v`, `.banner(.warn)`, `.overlay .modal .m-head .m-body .m-foot`, `.bar > i`, `.progress`, `.empty`, `.page`, `.head`, `.mono` |

### Backend (`src-tauri/src/`)
| File | Contents |
|---|---|
| `lib.rs` | `data_dir()` = `<exe dir>/hermes-data` (created on demand). Commands: `data_path`, `load_settings` → JSON (`{}` if missing), `save_settings(settings)` (atomic tmp+rename). Registers all commands |
| `update.rs` | `check_update` → `Option<{version,url}>` (GitHub latest release, 404 = None, semver compare vs `package_info().version`), `install_update(url)` (download → `Hermes.exe.new`, emits `update-progress` `[done,total]`, checks size + `MZ`, rename running → `.old`, new → exe, relaunch, exit; disabled in debug builds), `cleanup_old_exe()` on startup |

Config: `tauri.conf.json` (frameless, 1180×760, min 960×620, `bundle.active=false` → bare exe), capabilities in `capabilities/default.json` (window min/max/close/drag, opener).

## Build, test, release
- Rust is at `%USERPROFILE%\.cargo\bin` (add to PATH in new shells).
- Dev: `npx tauri dev`. Release exe: `npx tauri build --no-bundle` → `src-tauri/target/release/Hermes.exe`.
- **Testing (mandatory after every change):** build release, then `node scripts/smoke.mjs`.
  It launches the real exe with WebView2 DevTools on port 9333 and drives it with playwright-core.
  Feature tests import `{ launch, connect, check, OUT }` from `scripts/smoke.mjs` (`connect(port)` attaches to an
  already running instance); screenshots go to `test-output/`. Extend the smoke test for every new feature.
- Self-update E2E: `node scripts/update-test.mjs <dir with older Hermes.exe> <published version>` — real GitHub
  download, swap, relaunch, cleanup. Run after touching `update.rs`/`update.ts`.
- Release: `node scripts/release.mjs X.Y.Z` (bumps tauri.conf.json + package.json, commits, tags, pushes).
  `.github/workflows/release.yml` builds on the tag and publishes `Hermes.exe` to the Release; the tag must match the version.

## Owner hardware
- GPU: NVIDIA RTX 3060 Ti (use NVENC for MP4 conversion). Editing target: Adobe Premiere.
