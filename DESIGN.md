---
name: Hekayati (حكايتي)
description: Citrus Playground design language for the local operator app and print identity.
colors:
  leaf: '#1F6F4A'
  leaf-bright: '#2F9E6A'
  leaf-deep: '#134A32'
  orange: '#FF8A1F'
  lemon: '#FFE566'
  paper: '#FFF8E8'
  paper-deep: '#F3EBD4'
  ink: '#2B2A28'
  ink-soft: '#5C574F'
  success: '#1F6F4A'
  warning: '#FF8A1F'
  danger: '#C43C2F'
  focus: '#1F6F4A'
typography:
  display:
    fontFamily: "Lemonada, 'Segoe UI', sans-serif"
    fontSize: '2.5rem'
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: 'normal'
  headline:
    fontFamily: "Lemonada, 'Segoe UI', sans-serif"
    fontSize: '1.75rem'
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 'normal'
  title:
    fontFamily: "Lemonada, 'Segoe UI', sans-serif"
    fontSize: '1.25rem'
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 'normal'
  body:
    fontFamily: "'Source Sans 3', 'IBM Plex Sans Arabic', system-ui, sans-serif"
    fontSize: '1rem'
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 'normal'
  label:
    fontFamily: "'Source Sans 3', 'IBM Plex Sans Arabic', system-ui, sans-serif"
    fontSize: '0.875rem'
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '0.01em'
  story:
    fontFamily: "'Source Sans 3', 'IBM Plex Sans Arabic', system-ui, sans-serif"
    fontSize: '1.125rem'
    fontWeight: 400
    lineHeight: 1.75
    letterSpacing: 'normal'
rounded:
  none: '0px'
  sm: '4px'
  md: '8px'
  lg: '12px'
spacing:
  xs: '4px'
  sm: '8px'
  md: '16px'
  lg: '24px'
  xl: '40px'
  2xl: '64px'
components:
  button-primary:
    backgroundColor: '{colors.leaf}'
    textColor: '{colors.paper}'
    rounded: '{rounded.md}'
    padding: '10px 16px'
  button-primary-hover:
    backgroundColor: '{colors.leaf-deep}'
    textColor: '{colors.paper}'
    rounded: '{rounded.md}'
    padding: '10px 16px'
  button-accent:
    backgroundColor: '{colors.lemon}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: '10px 16px'
  button-secondary:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.leaf}'
    rounded: '{rounded.md}'
    padding: '10px 16px'
  input-default:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.sm}'
    padding: '10px 12px'
  nav-active:
    backgroundColor: '{colors.leaf}'
    textColor: '{colors.lemon}'
    rounded: '{rounded.sm}'
    padding: '8px 12px'
  badge-warning:
    backgroundColor: '{colors.orange}'
    textColor: '{colors.ink}'
    rounded: '{rounded.sm}'
    padding: '4px 8px'
  surface-panel:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: '16px'
---

<!-- SEED: sourced from brand-kits/02-citrus-playground.html (canonical). Re-run /impeccable document after UI code exists. -->

# Design System: Citrus Playground (ملعب الليمون)

## Overview

**Canonical kit:** `brand-kits/02-citrus-playground.html`
**Scene:** An employee building gift books on a bright Mac desk by day; the UI should feel like a sunlit workshop with citrus energy, not a dark ops console and not a toy store explosion.

**Color strategy**

- **Product chrome (default):** Restrained. Paper ground, ink text, leaf as the primary action/selection color (~≤10–15% of pixels). Orange reserved for warnings / “needs attention.” Lemon for high-signal CTAs and brand chips.
- **Brand moments (committed):** Hero empty states, ending PDF page, watermark wordmark, first-run splash, Single Image Studio header may use leaf fields + lemon/orange shapes like the kit hero.

**Direction:** RTL-first Arabic product UI. Lemonada for brand/display only. Source Sans 3 (+ Arabic-capable fallback) for all operator chrome, forms, tables, and labels. No display font inside dense data or buttons except intentional brand CTAs.

**Source of truth order:** `PRODUCT.md` → this `DESIGN.md` → `brand-kits/02-citrus-playground.html` → CSS tokens in app code.

The brand-kit HTML may load web fonts for documentation preview only. Product UI and PDF rendering MUST bundle verified font files locally; no CDN/font request is permitted at runtime.

## Colors

OKLCH-oriented roles (hex above is normative for Stitch/export; keep chroma moderated at extremes).

| Role        | Hex       | Use                                                         |
| ----------- | --------- | ----------------------------------------------------------- |
| Leaf        | `#1F6F4A` | Primary actions, links, focus ring, success                 |
| Leaf bright | `#2F9E6A` | Hover lift, charts, soft fills                              |
| Leaf deep   | `#134A32` | Primary pressed, hero gradients                             |
| Orange      | `#FF8A1F` | Warning, quota pause, “needs review”                        |
| Lemon       | `#FFE566` | Brand highlight, secondary CTA, active accents on dark leaf |
| Paper       | `#FFF8E8` | App background, panels                                      |
| Paper deep  | `#F3EBD4` | Alternating rows, recessed wells                            |
| Ink         | `#2B2A28` | Body text (never pure black)                                |
| Ink soft    | `#5C574F` | Secondary text, captions                                    |
| Danger      | `#C43C2F` | Destructive / hard errors only                              |

Atmosphere on paper surfaces: soft citrus radial washes (lemon / orange / leaf at low opacity), matching the kit. Do not flatten to a single solid white.

**Semantic map**

- Success → leaf
- Warning / pause → orange
- Danger → danger red (not orange)
- Focus → leaf ring, 2px, offset visible on paper and on leaf buttons

## Typography

| Token                      | Family                                            | Product use                                                        |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| display / headline / title | **Lemonada**                                      | App name, page titles, empty-state headlines, ending-page wordmark |
| body / label               | **Source Sans 3** + IBM Plex Sans Arabic fallback | All UI copy, forms, tables, job reasons                            |
| story                      | Source Sans 3 (or print-embedded Arabic later)    | In-app story preview; print fonts locked in print pipeline         |

Scale (product, fixed rem, ~1.2 ratio): 12 / 14 / 16 / 20 / 28 / 40. Cap prose ~70ch. Dense tables may run wider.

## Elevation

Prefer **tonal layering** over heavy shadows.

- Level 0: paper ambient background with soft radial citrus washes
- Level 1: paper panels with 1px `ink` at ~8–12% opacity border
- Level 2: rare floating menus: soft shadow `0 8px 24px` ink at 8% opacity
- No multi-layer glow stacks; no glass blur as default

Hero / brand blocks: solid leaf gradient field (kit formula: leaf → `#185C3D` → leaf-deep) with lemon square + orange circle accents (opacity controlled).

## Components

**Buttons**

- Primary: leaf fill, paper text, md radius, 150–200ms hover to leaf-deep
- Accent / gift CTA: lemon fill, ink text
- Secondary: paper fill, leaf text, leaf border 1px
- Danger: danger fill, paper text; confirm inline before destructive

**Navigation**

- Top or side shell on paper-deep / paper
- Active item: leaf field + lemon label (kit mark energy, product-sized)
- Single Image tab («توليد صورة») uses same nav language

**Inputs**

- Paper field, ink text, sm radius, leaf focus ring
- Error: danger border + text; warning: orange

**Jobs / status**

- Queued / running: leaf
- Paused (quota): orange badge + plain-language Arabic reason
- Failed permanent: danger
- Waiting review: lemon chip on paper

**Cards**

- Default: no cards. Use sections + borders.
- Cards only for selectable entities (customer, character, page thumb) where the container itself is the hit target.

**Watermark (preview PDF)**

- Diagonal «حكايتي» in leaf at ~18–22% opacity
- Footer: `معاينة — غير مخصصة للطباعة`

**Ending page**

- Orange field, lemon wordmark, paper/white child dedication line (kit ending block)

## Do's and Don'ts

**Do**

- Load `/impeccable` context (`PRODUCT.md` + this file) and `/frontend-design` before any frontend UI work
- Keep operator chrome restrained; spend citrus on identity and attention
- Design RTL first; mirror logic, not just text alignment
- Use Lemonada sparingly for brand moments
- Match kit 02 swatches exactly unless amending this file

**Don't**

- Introduce purple, indigo SaaS gradients, or cream+terracotta editorial kits
- Use Inter / Roboto / Arial / Space Grotesk as primary UI fonts
- Put Lemonada on table headers, form labels, or dense controls
- Auto-dark-mode the whole app “because tools are dark”
- Side-stripe accent borders, gradient text, glass cards as defaults
- Invent a second competing palette for Studio vs Books; one citrus system

**Agent rule:** Frontend implementation and visual iteration must run under Impeccable + frontend-design skills. If either context is missing, stop and load/teach before painting UI.
