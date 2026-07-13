# `.impeccable/`

Impeccable project runtime + design sidecar for Hekayati (**Citrus Playground**).

## Layout

| Path          | Purpose                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `design.json` | Design-system sidecar (ramps, motion, component snippets for live panel)       |
| `live/`       | Live visual iteration config + sessions (created when `/impeccable live` runs) |
| `critique/`   | Written critique reports from `/impeccable critique`                           |

## Source of truth (do not move)

Keep these at **repo root** (Impeccable loader default):

- `PRODUCT.md` — strategy / register
- `DESIGN.md` — tokens + six Stitch sections
- `brand-kits/02-citrus-playground.html` — visual canonical kit
- `brand-kits/citrus-playground.tokens.css` — CSS variables

Regenerate `design.json` whenever `DESIGN.md` changes (`/impeccable document`).

## Agent rule

Frontend UI work: load `/impeccable` + `/frontend-design` first. See `AGENTS.md`.
