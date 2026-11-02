# Adaptive layout

CostcoTracker Analytics is a web app (Vite, React, Tailwind CSS v4), not a native SwiftUI/UIKit app. This document explains how it applies Apple's layout guidance on the web, so the same UI works on:
- a compact iPhone display;
- the compact outer display and the larger inner display of iPhone Duo;
- iPad, resizable windows and desktop browsers.

Native APIs such as `horizontalSizeClass`, `NavigationSplitView` or `ReservedRegion` do not exist here. Their concepts are mapped to CSS container queries and one small measuring hook.

## Sources (primary authority)

Read from Apple's documentation on 2026-11-02:

| Document | Used for |
|---|---|
| HIG: Layout (updated 2026-09-09) | Size classes; deciding by available space, not device or orientation; keeping functionality when size changes; safe areas and layout guides; readable width; Dynamic Type; visual hierarchy (leading/top) |
| HIG: Designing for iPhone Duo (2026-09-09) | Compact outer and regular inner layout; "don't reinvent your app when it resizes"; keeping state and functionality across displays; showing an additional level of hierarchy on the larger display (the Mail example); avoiding fixed widths; avoiding extreme layout changes; even grid columns across the fold |
| HIG: Designing for iOS | Focus on primary tasks; secondary details discoverable; adapting to orientation and Dynamic Type |
| HIG: Split views | Use a split view only in a regular environment; persistently highlight the selection that leads to the detail |
| Developer: Preparing your app for iPhone Duo | Size views relative to their container, not to screen or device dimensions; never use idiom or orientation for layout; use scene and container geometry |
| SwiftUI: Layout fundamentals, UserInterfaceSizeClass, ViewThatFits | Containers adapt to content and space; size classes change at runtime; the first presentation that fits wins |

**Secondary review layer:** Emil Kowalski's `apple-design`, `mobile-native`, `break-ui` and `emil-design-eng` skills. Where they and Apple differ, Apple wins. What they caught is listed under [Review findings](#review-findings).

## Audit of the existing UI (before this change)

| Finding | Where | Effect |
|---|---|---|
| Layout keyed to **viewport** breakpoints (`sm`/`md`/`lg`/`xl`/`2xl`, `min-[420px]`, `min-[400px]`), about 40 occurrences in 20 files | Sections, details, cloud panels, shells | A grid inside a 48rem drawer followed the window width. A narrower region (a pane) could not adapt |
| No safe-area handling: no `viewport-fit=cover`, no `env(safe-area-inset-*)` | `index.html`, page shells, drawer | Content relied on browser letterboxing; side-placed system controls were not considered |
| The drawer was always a **modal overlay**, full-height, `max-w-3xl` | `DrillDrawer` | On wide displays it covered the list; there was no list/detail presentation |
| Fixed table minimum widths (`min-w-[56rem]` and others) | Items, Price index, Warehouses, Categories, Returns, details | Fine: they scroll inside their own region. Kept |
| The AI review table needed 48rem: on a phone, **Accept / Change / Leave were off-screen** behind a sideways scroll | `AiSuggestionsPanel` | Compact review was hard to operate |
| Prose spanning the full panel width (up to 100rem) | Panel subtitles, management screens (`max-w-5xl`) | Long lines on wide displays |
| `px` font sizes (`text-[15px]`, `[11px]`, `[10px]`, `[9px]`) and a fixed-size info icon | `ui.tsx`, Items | Did not follow the user's text size |
| Figures were truncated (`truncate` on stat values) | `StatCard` | Large amounts could be cut off |
| Badges and readout rows could not wrap | `Badge`, chart readouts | Overflowed the page at 200% text in compact width |
| Text fields under 16px | All inputs (`text-sm`) | iOS zooms into the page on focus |
| Tap highlight, double-tap delay and long-press selection on controls | Global | "Website" feel on iPhone |
| No orientation, device-name or user-agent logic | — | Good: nothing to remove |
| State that would be lost when layout changes | — | None yet. Any layout that rendered different component trees per size would have reset search, filters and open forms; the design below avoids that |

## The adaptive system

### 1. Semantic width tokens

`src/index.css` (`@theme`) holds the widths; `src/ui/layout/tokens.ts` mirrors them, and a test keeps both in sync.

| Token | Width | Meaning |
|---|---|---|
| `pair` | 24rem | Two small cards fit side by side |
| `readable` | 42rem | Measure for running text (UIKit's readable content guide, about 70 characters) |
| `regular` | 44rem | **Horizontal size class:** below this a region is *compact*, from here *regular* |
| `sheet` | 48rem | Maximum width of a detail sheet |
| `wide` | 60rem | More columns for summaries; the full review table |
| `content` | 64rem | Maximum width of management pages |
| `split` | 52rem | Room for a list and a detail pane side by side: pane minimum 22rem + gap 1rem + primary minimum 29rem (wider than any compact-width iPhone column) |
| `spacious`, `panoramic` | 76rem, 92rem | Extra columns for very wide regions |
| `page` | 100rem | Maximum page width; content stays centered |

Each token gives a container-query variant (`@regular:grid-cols-2`) and a width utility (`max-w-readable`). **No component uses a viewport breakpoint**, and a test enforces this.

**Why container queries:** Apple decides from "the actual space available". A container query asks the region itself (a page, a panel, a pane, a sheet, a form) how wide it is. The window, the screen and the orientation are never consulted. `<main>`, every `Panel`, the detail body and the identity form are size containers.

**Tuned on real hardware:** the first version used 64rem. On an iPhone Duo, unfolded in landscape, Safari's content width stayed below that, so the detail remained a sheet despite visible room for two panes. The threshold is now derived from the smallest two-pane layout that stays usable, not from any device. A test checks the derivation.

The tokens are in `rem`, so **larger text means less effective room**. At 200% text, a 1180px window falls back from split to sheet, and grids drop columns. This is Apple's Dynamic Type guidance: let adjacent views stack when text grows.

### 2. Primitives

| Primitive | File | Role |
|---|---|---|
| Page shell | `src/ui/layout/shell.ts` | Bounded, centered page row. Margins are `max(gutter, safe-area inset)` on each side. Header pads the top inset, footer the bottom inset. `<main>` is a container |
| `useContainerWidth` | `src/ui/layout/useContainerWidth.ts` | ResizeObserver width of an element: the web equivalent of reading a view's geometry. It returns `null` until measured, which means the compact presentation |
| `widthClassOf`, `canSplit` | `src/ui/layout/tokens.ts` | Compact/regular and "room for two panes" from a measured width |
| `readable-flow`, `max-w-readable` | `src/index.css` | Running text keeps a readable measure while tables and charts use the width |
| `page-gutter`, `safe-top`, `safe-bottom` | `src/index.css` | Safe-area-aware padding |
| Adaptive table rows | `AiSuggestionsPanel` | ARIA table; CSS grid; stacked when compact, subgrid columns when wide |

### 3. Detail presentation (master/detail)

The dashboard measures its own width:
- **Compact, or regular without room for two usable panes (below 52rem of dashboard width):** a drill-down opens as a **modal sheet**. It has a dimming scrim, `aria-modal`, and Escape closes it. This is the existing behavior.
- **Room for two panes:** it docks as the **secondary pane of a split view**, beside the dashboard. It is non-modal (`role="region"`), sticky, and scrolls on its own. The list stays visible and usable.
  - Selecting another row **replaces** the detail, as in a split view's primary list.
  - Drilling further inside the detail **pushes**, so Back works.
  - The selected Items row is **persistently highlighted** (`aria-current`), as Apple's split-view guidance asks.
  - Escape closes the pane only when focus is inside it.

**Same element tree in both forms:** the sheet and the pane render the same tree, and only classes and ARIA roles change. A resize, rotation or fold therefore never remounts the detail or the dashboard. Things that survive:
- the selected item and the drill-down stack (Back);
- the active tab;
- the Items search, category filter, pattern filter and sort;
- the AI review session;
- an open owner-confirmed identity form with its unsaved text.

### 4. Screens at regular width

- **Dashboard (all tabs):** list and detail side by side when there is room. Summary grids add columns at `wide`, `spacious` and `panoramic` widths, measured on the dashboard region, so they shrink back when the pane docks.
- **Item detail:** a docked pane. Its stat grid is 2×2 in the pane and four across in a wide sheet.
- **Categories → AI suggestions:**
  - compact: each suggestion is a stacked card, with labels and its actions in reach;
  - `wide`: five aligned columns (CSS subgrid);
  - the reason column keeps a readable measure.
- **Management (Cloud status, Sync, iPhones, Import, Backup):** bounded to 64rem. Running text is capped at 42rem.
- **Unchanged layouts:**
  - Items, Price index, Warehouses and Returns tables keep their columns. They scroll inside their own region when the space is narrower than the table, rather than hiding data.
  - Charts, branding, colors, navigation order and control density at compact width.

### 5. Mobile-web details

- `viewport-fit=cover` and `interactive-widget=resizes-content`; `theme-color` set to the header color.
- No tap highlight. `touch-action: manipulation` on controls; long-press doesn't select control labels. Content text stays selectable.
- Text fields are at least 16px on touch screens (`pointer: coarse`), so iOS doesn't zoom on focus.
- Sheet and pane scroll areas use `overscroll-behavior: contain`.
- Hover styles are already capability-gated (Tailwind v4 `hover:` uses `@media (hover: hover)`).
- Never disables zoom.

## Manual viewport matrix

Run on the production build (`vite preview`, local-file mode) and on `wrangler pages dev` with a local D1 (cloud mode, synthetic data, Workers AI responses mocked), in Chromium via Playwright.

**These sizes are representative only.** Apple does not publish iPhone Duo display sizes for the web, so none of them claims to be a Duo display. Layout depends on available width only.

Region width is the dashboard's measured width (the viewport minus page margins). Only the region decides.

| Viewport (CSS px) | Represents | Region | Dashboard layout | Detail |
|---|---|---|---|---|
| 320×568 | Narrowest supported width | 288px (18.0rem) | single | sheet |
| 375×667 | Compact iPhone, portrait | 343px (21.4rem) | single | sheet |
| 390×844 | Compact, tall | 358px (22.4rem) | single | sheet |
| 844×390 | Phone in landscape | 802px (50.1rem) | single | sheet |
| 932×430 | Large phone in landscape (Apple treats these as regular width) | 885px (55.3rem) | split | pane |
| 768×1024 | Regular width, tall | 730px (45.6rem) | single | sheet |
| 820×1180 | Regular width, tall (portrait-like) | 779px (48.7rem) | single | sheet |
| 880×700 | Just above the split threshold | 836px (52.2rem) | split | pane |
| 1024×768 | Regular width, landscape-like | 973px (60.8rem) | split | pane (was sheet at 64rem) |
| 1180×820 | Wide | 1121px (70.1rem) | split | pane |
| 1440×900 | Desktop | 1376px (86.0rem) | split | pane |

With the change from 64rem to 52rem, three rows changed from sheet to pane: 932×430, 880×700 and 1024×768. Compact phones in portrait, phones in landscape up to about 870px, and portrait-like regular widths below 52rem keep the sheet.

**Results:**
- No page-level horizontal overflow at any size, with demo data or worst-case data (long online-order titles, a $592,821.37 item, long warehouse names). This also holds at 200% text in compact and wide.
- **Transitions with an item open, search "1" and a pattern filter active:** 1180×820 → 375×667 → 820×1180 → 1180×820 → 320×568 → 1440×900. The same item, search and filter stayed at every step; the detail switched pane → sheet → sheet → pane → sheet → pane.
- **Management pages:** no overflow. The longest paragraph is 672px (42rem) at every wide size.
- **AI review:** Accept is inside the viewport at every size. At 1180 the header and rows align.

## Needs real hardware

These could not be validated without a physical iPhone Duo or Safari on one:
- **The fold** (Apple's *reserved regions*). The web has no `ReservedRegion` API in Safari. A docked pane is not centered on the fold, and a partially folded inner display may place the fold inside the dashboard or the pane. Apple's guidance is to keep important elements clear of the center; we follow it only through general margins.
- **Side-placed system bars on the outer display:** Safari's own chrome and the safe-area insets it reports there. The layout pads left and right insets separately, but the actual values are unverified.
- **Inner display widths in CSS px, and Safari Split View widths.** Unfolded landscape did not reach 64rem on the device; at 52rem it should dock if the dashboard region is at least 832px. Portrait may stay a sheet, which is acceptable. To confirm on the device, run this in Safari Web Inspector: `document.querySelector('[data-testid=dashboard-layout]').getBoundingClientRect().width`.
- **Real Dynamic Type in Safari:** the app scales with the root text size and browser zoom. It does not opt into `font: -apple-system-body`, because that would change the current iPhone text size.
- **Touch feel:** tap highlight, input zoom, and keyboard behavior with `interactive-widget`.
- **Text size controls:** touch-target sizes of the small `text-xs` controls, kept to preserve the current control density, and VoiceOver order in split layout.

## Review findings

The four skills were used as a secondary review layer under Apple's documentation.

| Skill | Caught | Changed |
|---|---|---|
| `apple-design` | A modal task needs a dimming scrim; a parallel panel must not have one. Spatial consistency: detail enters from the trailing side in both forms. Typography should use rem, not px | The sheet keeps its scrim and `aria-modal`; the pane has neither. px font sizes became rem; the info icon is em-sized |
| `mobile-native` | Inputs under 16px zoom the page on iOS. Tap highlight. Missing `viewport-fit=cover`. Overscroll chaining from the sheet | Unlayered 16px rule for `pointer: coarse` (a layered rule lost to `text-sm`). Tap highlight removed. `touch-action` and `user-select` on controls. `viewport-fit=cover` plus `env()` insets. `overscroll-behavior: contain` on detail scroll areas |
| `break-ui` | At 200% text in compact width, chart readouts, a "Records for …" button and "Low coverage" badges overflowed the page. Stat values were truncated. Item names in the narrow list had no full-value fallback | Readout rows wrap. The button can shrink to the available width. Badges wrap only when space runs out. Figures are never truncated. Truncated names get a `title`, and the full name is in the detail |
| `emil-design-eng` | The AI review rows did not line up at wide width (each row sized its own columns). "Confirm identity" touched the item number | A shared column grid through CSS subgrid. The button sits on its own line |
