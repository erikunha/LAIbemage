---
applyTo: 'packages/core/src/processor/**'
---

# Processor module rules
## Purpose

This module owns all Sharp image processing. It must never import OpenAI.

## Key invariants

- Output format: JPEG, `quality: 100`, `chromaSubsampling: '4:4:4'`, `mozjpeg: false`
- Always call `.withMetadata()` to preserve EXIF data
- Timestamp overlay: red, bold Arial, centered horizontally, 3% gap from bottom
- Font size: `calculateFontSize(height)` — base ratio 3.5%, XL boost ×1.4, Large boost ×1.25, clamped 56–320px
- Images with `skipOverlay: true` in the export options skip overlay — JPEG conversion only. This is a config-driven decision made by the caller (`packages/core/src/index.ts`), not a hardcoded category list. The processor module has no knowledge of specific category names — it is domain-agnostic.
- Dry-run mode: log with `logger.verbose()`, write nothing to disk

## Pure functions (overlay.ts)

`calculateFontSize`, `formatTimestamp`, `buildTimestampSvg`, `calculateOverlayPosition` are pure —
no I/O, fully testable without mocks. Keep them that way.

## Output filename format

```
NNN. Photo of category name dated DD-MM-YYYY.jpeg
```

Numbers are zero-padded to 3 digits. Category underscores are replaced with spaces.
