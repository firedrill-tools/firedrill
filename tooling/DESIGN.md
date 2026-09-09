---
name: Firedrill Tool apps
description: Shared visual system for optional local Tool-owned apps.
colors:
  canvas: "#fcfcfd"
  surface: "#ffffff"
  subtle: "#f7f7f8"
  selected: "#f1f3fb"
  text: "#1b1d22"
  muted: "#5d6169"
  border: "#dfe0e4"
  accent: "#3157d5"
  action: "#2948b5"
  danger: "#b43a32"
  on-accent: "#ffffff"
  focus: "#3157d5"
  scrim: "rgb(17 19 24 / 44%)"
  canvas-dark: "#0a0b0d"
  surface-dark: "#0f1013"
  subtle-dark: "#15171b"
  selected-dark: "#1b2444"
  text-dark: "#faf8f3"
  muted-dark: "#d0d4dc"
  border-dark: "#363b45"
  action-dark: "#c9d2fa"
  danger-dark: "#f5a9a1"
  focus-dark: "#7d93ec"
  scrim-dark: "rgb(2 3 4 / 66%)"
typography:
  headline:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.5
  detail:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  field: "6px"
  button: "7px"
  dialog: "12px"
spacing:
  compact: "4px"
  small: "8px"
  control-gap: "12px"
  mobile-gutter: "16px"
  desktop-gutter: "24px"
  document-gutter: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-accent}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "8px 14px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "8px 14px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "9px 11px"
  navigation-current:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.action}"
    rounded: "{rounded.button}"
    padding: "8px 14px"
  list-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    padding: "17px 24px"
    width: "100%"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.dialog}"
    padding: "28px"
    width: "min(480px, calc(100vw - 32px))"
---

# Design System: Firedrill Tool apps

## Overview

**Creative North Star: "Familiar local apps"**

Neutral surfaces, Inter type and restrained cobalt actions keep these compact
service apps clear and usable. Flat lists and visible controls put synthetic
content and the next action first.

This system covers the shared static kit in `tool-app-ui/`, currently used by
Mailbox and Object storage. It does not define the inspector or other Firedrill
surfaces. The built stylesheet is the implementation source of truth.

**Key Characteristics:**

- Neutral light and dark surfaces with one cobalt accent.
- Flat app navigation and full-width working lists.
- Labeled native fields, visible actions and centered confirmation dialogs.

## Colors

### Primary

Cobalt (`accent`) marks primary buttons; `action` colors active navigation,
links and app icons. Primary button text stays `on-accent` in both themes.

### Neutral

`canvas` holds the app; `surface` holds controls and rows; `subtle` separates
navigation and feedback. `text`, `muted` and `border` establish hierarchy without
decorative panels. `selected` identifies the current folder and control hover.
`danger` identifies destructive actions and errors; `focus` marks keyboard focus;
`scrim` isolates a modal.

The `-dark` tokens replace their matching roles through the system dark-mode
preference. Cobalt and primary-button text remain unchanged. Component references
above describe the light defaults; the stylesheet supplies theme mapping.
Primary-button hover keeps the light `action` color in either theme.

**The Action Accent Rule.** Use cobalt for actions and selection, not large
decorative surfaces; pair destructive color with an explicit action label.

## Typography

Inter is bundled locally, with system sans-serif fallbacks. This is a compact UI
ramp, not a display system: `title` styles app/editor headings, `headline` styles
section, message and dialog headings, `body` carries content, `label` carries
controls, and `detail` carries metadata and pagination. Current navigation uses
semibold weight. Long-form text keeps normal UI type with looser line height
(1.8); textareas use (1.7). Preserve wrapping for subjects, keys and metadata.

## Layout

The app fills the dynamic viewport. A non-shrinking, minimum-height header (64px)
stays above a flexible workspace; content scrolls within it. Toolbars wrap and
pagination stays outside the scrolling content. Mailbox has a left navigation
column (200px); Object storage places bucket/prefix controls above its list.
Reading and editing occupy the workspace, with a maximum content width (900px).

At widths up to (700px), the header wraps, the synthetic notice gets its own
line, folder navigation becomes horizontal and wrapping, and paired fields
stack. Side gutters contract to `mobile-gutter`. List rows become two-column
layouts and column headings disappear. Keep minimum sizes and flex-shrink rules
so tall mobile content cannot compress the header or hide actions.

## Elevation & Depth

**The Flat Boundary Rule.** Separate working regions with surface tone and thin
borders, not elevated cards. The only authored shadow is an inset row-hover
outline; dialogs use a dimmed backdrop and a border, not a drop shadow.

## Shapes

Thin solid borders (1px), mildly rounded fields and buttons, and a softer dialog
corner define the shared shape language. List rows have square edges and span
the workspace. Small inline SVG app icons accompany readable app names.

## Components

- **Buttons:** outlined secondary controls, filled primary controls and labeled
  danger controls remain visible at rest. Minimum height is (38px). Hover changes
  surface/border color; disabled controls reduce opacity and use a disabled cursor.
- **Fields:** labels sit above inputs and textareas. Native validation remains
  active; locked edit identities and unresolved write forms become read-only.
  Textareas resize vertically. Keyboard focus uses a solid outline (2px), offset
  from the control (3px).
- **Navigation:** folder buttons use `aria-current="page"` for the selected
  surface, action-colored text and semibold weight. No icon-only navigation is
  needed. Previous/Next pagination uses visible labeled buttons.
- **Lists:** each full row is a native button with a primary content label and
  supporting metadata. Empty lists show a heading and a useful next action.
- **Feedback:** an inline status region sits below the header; errors add danger
  text. Pending actions set busy state and disable competing buttons.
- **Dialogs:** native modal dialogs name the action and affected content. Cancel
  receives initial focus; the destructive button remains separately labeled.
  The dialog scrolls within the viewport; confirmation controls stay enabled.

## Do's and Don'ts

### Do:

- Do use the shared stylesheet and its semantic theme roles.
- Do keep actions visibly clickable and fields explicitly labeled.
- Do keep synthetic-state and actor context legible in the header.
- Do verify long content, keyboard focus and mobile wrapping in both themes.

### Don't:

- Don't replace flat working lists with decorative cards or editing drawers.
- Don't hide essential actions behind hover or unlabeled icons.
- Don't apply this Tool-app system as a product-wide redesign specification.
