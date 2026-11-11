# Upstream VisA annotation fixtures

These two `image_anno.csv` files reproduce the **real upstream VisA** annotation
shape, which differs from the repository's synthetic fixture in three ways that
break naive readers:

| | upstream VisA | `benchmarks/fixtures/synthetic-fixture` |
|---|---|---|
| `image` cell | **part-prefixed**, relative to the DATASET ROOT (`candle/Data/Images/Normal/0000.JPG`) | relative to the CSV's own directory (`Data/Images/Normal/0000.JPG`) |
| `label` cell | `normal`, or the **defect type name** (`chunk of wax missing`) | `normal` / `anomaly` |
| columns | `image,label,mask` only | `image,mask,label,defect_type,session` |

Upstream has **no** `session`, `defect_type` or `class` column, and a label cell
may be quoted when it holds a comma-separated list of several defect names.

* `candle/image_anno.csv` — the upstream convention: the `image` cell is
  part-prefixed, i.e. relative to the dataset root.
* `capsules/image_anno.csv` — the CSV-directory relative convention, so that
  the SECOND resolution branch (the repository's own synthetic-fixture shape)
  is covered by the fixtures too. It also carries the defect-type label
  `bubble`.

The image files themselves are **not** committed: the tests copy these CSVs
into a temporary tree and write tiny placeholder images next to them (the split
generator hashes image bytes, so the bytes must exist, but they carry no
information).
