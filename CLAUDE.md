# Hermes

Portable Windows utility app (no installer) that wraps CLI repos the owner uses daily.
Personal use, public GitHub repo, unsigned exe is fine.

- Full spec: [docs/SPEC.md](docs/SPEC.md) — read it before changing behavior.
- Design mockups: [design/mockups.html](design/mockups.html). Chosen: **01 Graphite / Amber**. App mark: feather.
- Work in tranches (SPEC section 9); finish and commit one before starting the next.

## Conventions
- UI text in English. Owner talks in Italian.
- Minimal, dark, one accent color, clean SVG icons. No emoji anywhere in UI.
- Every tool is a self-contained module; adding a tool must not touch other tools.
- Settings, queue state, binaries live next to the exe (truly portable).

## Owner hardware
- GPU: NVIDIA RTX 3060 Ti (use NVENC for MP4 conversion). Editing target: Adobe Premiere.
