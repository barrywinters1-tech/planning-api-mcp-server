# Design conventions

How the Planner interface is built, for people and for the agents that work on it. One set of rules, written down, so a component made next month looks like one made today. The foundations follow the same reasoning Meta's open design system [Astryx](https://github.com/meta/astryx) documents (spacing hierarchy, type roles, concentric radii, elevation tiers, alpha overlays, motion bands); the values are ours and live in `web/styles.css` `:root`.

We do not use the Astryx library itself: the app is dependency-free vanilla HTML/CSS/JS bundled into one file for the shared test link, and Astryx is a React 19 + StyleX component library. We take its conventions, not its code.

## Tokens, never raw values

Every visual value in `web/styles.css` references a token. Themes (light, dark) change token values; they never change which token a component uses.

| Role | Tokens | Rule |
|---|---|---|
| Spacing | `--space-1..10` (4px grid) | Gaps grow with grouping level: label→input < fields in a group < groups in a section < sections. Never one value everywhere. 2px half-steps only for optical alignment. |
| Type | `--fs-xs 12 · sm 13 · base 14 · lg 17 · xl 20 · 2xl 24 · 3xl 29 · 4xl 35` (ratio 1.2 from 14) with `--lh-body 1.43`, `--lh-heading 1.25`, `--lh-supporting 1.5` and weights `--w-regular/medium/semibold/bold` | Adjacent roles differ by at least 1.2×. Body never below 12px. Line length 65–75ch for prose. No all-caps body, no justified text. Uppercase is for 11–12px section labels with letter-spacing only. |
| Radius | `--r-inner 6 · --r-element 10 · --r-container 12 · --r-page 28 · --r-full` | Chosen by role. A nested element's radius is its parent's minus the padding between them, so curves stay parallel: a 12px panel with 16px padding holds square-cornered content; with 4px padding, 8px. Pills (`--r-full`) are for buttons and chips only. |
| Elevation | `--shadow-low` (cards, tiles) · `--shadow-med` (popovers, dropdowns) · `--shadow-high` (sheets, modals) | Shadow tier matches stacking order: base < dropdown (`--z-dropdown`) < sticky (`--z-sticky`) < overlay (`--z-overlay`) < toast (`--z-toast`) < tooltip (`--z-tooltip`). Never a hairline border and a wide diffuse shadow on the same surface. No tinted glows. |
| Colour | `--ink`, `--ink-2`, `--ink-3` text; `--surface`, `--surface-2`, `--raised`, `--bg` surfaces; `--accent`; status `--ok`, `--warn`, `--crit` with `-soft` tints; chart colours `--bar`, `--crit`, `--dd`, `--baseline`, `--period` | Foreground and background are chosen together and pass WCAG AA in both modes. Surfaces are tinted, never pure `#fff`/`#000`. Status is never colour alone: it carries text or an icon. One primary action per view. |
| Interaction | `--overlay-hover`, `--overlay-pressed` (alpha tints); `--accent` and `--accent-soft` for selection | Hover is a neutral alpha overlay, pressed is a stronger one plus `scale(.98)`. Selection uses the accent: filled for toggles, a surface lift for segmented controls, an edge bar for tabs, a tinted row for lists. Focus is a 2px accent outline at 3px offset, or the inset ring on fields. |
| Motion | `--dur-fast 125ms` (micro), `--dur-medium 300ms` (enter/exit), `--dur-slow 700ms` (large), `--ease-standard` | Animate `transform` and `opacity` only. No bounce or elastic easing on presentation; the interruptible springs in `app.js` run critically damped (`damping: 1`) except on a gesture release, where the carried velocity is the point. `prefers-reduced-motion` collapses transitions. |

## States every control shows

Rest, hover, pressed, focus-visible, disabled (with a reason where the control explains it), loading (dimensions stay stable), selected. A status (On track / At risk / Late, pass / fail) is a chip with text; the dot is decoration, the words carry the meaning.

## Composition

- Space groups things; containers do not. No cards inside cards. A panel holds lists, tables and text, not more panels.
- Dense surfaces (the grid, the Gantt, the toolbar) use the small end of the type scale and the 4px grid; reading surfaces (Overview, briefing, dialogs) use base type and wider gaps.
- No accent stripe down the side of a rounded card. A card's status shows in its chip or its surface tint.
- Popovers and tooltips escape their containers (`overflow` must not clip them).
- Every drag has a 1:1 preview and a visible drop target; commit on release; one undo step.

## Checking a change

Objective (can be checked by anyone or an agent): values on the 4px grid; type from the role scale; radius from the role scale and concentric; AA contrast both modes; hover and pressed are alpha overlays; no bounce easing; `transform`/`opacity` only; `prefers-reduced-motion` honoured; z-index from the role list.

Judgement (a person decides): the right representation for the state; proportion and density; whether the hierarchy survives the squint test.

Run the browser checks in the scratchpad (`shell_check.py`, `t1_check.py`, `drag_check.py`) after any stylesheet change: layout changes break drag targets more often than they break looks.
