# Add Category

Add a new category to the taxonomy. Argument: `$ARGUMENTS` (e.g. `water-damage - photos showing water stains or flooding`)

## Steps

### 1. Edit `examples/categories.json` (or the project's active categories file)

Add a new entry to `categories[]`:
```json
{
  "name": "snake_case_name",
  "description": "One sentence describing what photos belong here, written from the perspective of someone viewing the image. Be specific — avoid overlap with existing categories."
}
```

Name rules (enforced by `CategoryConfigSchema` in `packages/core/src/config/index.ts`):
- **lowercase snake_case only**: regex `/^[a-z][a-z0-9_]*$/` — underscores, no hyphens
- Examples: `water_damage`, `mold_growth`, `misc` — NOT `water-damage`

### 2. Decide placement flags

Consider whether this category should be in:
- `pinnedLast`: shown at end regardless of image count (e.g. `misc`, `unknown`)
- `immune`: never overridden by temporal consensus (e.g. categories where every image is intentionally distinct)
- `overridable`: can be overridden by temporal consensus (e.g. `unknown`)

Add the category name to the appropriate array(s) in `categories.json`.

### 3. Verify category config parses cleanly

```bash
pnpm run typecheck && pnpm test
```

The `CategoryConfigSchema` will reject:
- Names not matching the regex
- `pinnedLast`/`immune`/`overridable` entries not present in `categories[].name`
- Invalid IANA timezone in `timezone`

### 4. Check for description overlap

Read all existing category descriptions and compare with the new one.
If two descriptions could apply to the same image, rewrite one to be more specific.

### 5. Test with a dry run

```bash
node packages/cli/dist/index.js \
  --input ./sample-photos \
  --output ./out \
  --categories ./examples/categories.json \
  --dry-run --verbose
```

Look for the new category appearing in the output. If images that should match it are classified elsewhere, revise the description.
