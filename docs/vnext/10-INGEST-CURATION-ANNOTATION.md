# Visual data ingestion, curation and annotation

## Workflow: import

1. User creates dataset with ontology and source/license policy.
2. Ingest adapter enumerates allowed paths/cloud objects; rejects MIME/path/size violations; reads bytes via bounded stream; hashes source; normalizes orientation as **derived** asset (original immutable).
3. Decode gathers dimensions, EXIF provenance if permitted, optical metadata and quality probes. Store original, thumbnail and optional tiles as separate artifacts with lineage.
4. Dedup: exact SHA256; near-duplicate pHash/dHash with labeled thresholds and false-positive review. Never delete likely duplicates automatically.
5. Create samples, ontology version and immutable snapshot; stage split manifest with counts by label, domain, capture group and provenance.
6. Run data audit and produce a versioned `QualityReport`. User may propose corrections but only reviewer confirmation creates an approved label.

## Supported input types by horizon

- F1: JPEG/PNG/WebP/TIFF; COCO image classification where compatible; common classification directory layout; import/export Label Studio classification.
- F2: bounding box/polygon/mask formats with explicit geometry validity; do not generate fake `full_image` YOLO detection boxes to express class labels.
- F5: video frames/tracks, multisensor capture timestamps, DICOM only under a separate regulated ADR, 3D point clouds via optional adapters.

## Quality audit checks

| Check | Method | Output |
|---|---|---|
| Corrupt/unsafe | decoder + MIME + dimension guards | quarantine reason |
| Exact/near duplicates | SHA256, pHash Hamming, visual embedding neighbors | candidate groups |
| Leakage | image-hash and near-duplicate cluster across splits | flagged pair IDs |
| Class distribution | counts, entropy, rare classes | imbalance report |
| Label conflict | multiple approved labels or model disagreement | adjudication queue |
| Outliers | embedding density/cluster boundaries | samples, not automatic deletions |
| Domain shift | capture metadata, embeddings, per-class rate | slice report |
| Licensing | dataset/model license manifest | allowed/prohibited uses |
| Image quality | blur, exposure, resolution, aspect ratio | feature values and policy |

## Annotation

Annotation types: whole-image category and multi-label (first), bounding box/rotated box, polygon, mask, keypoints, OCR regions (next), temporal event/tracks (frontier). Tooling must support zoom/pan/keyboard, class shortcuts, undo/redo, adjudication, annotations per ontology version and provenance. AI proposed labels remain separate from approved human ground truth, with reviewer action and timestamp. Prevent bulk review accidents with preview/confirm, transaction scope and undo actions.

## Dedup & split policy

Avoid time-window-only grouping as a universal signal. Prefer real acquisition group IDs (camera run, product batch, scene, patient/entity where permitted) with explicit strategy and a fallback when group coverage is absent. The current VisA split degenerates when it assumes capture groups that are not present. A future F1 gate must produce nonempty train/val/test, audited class coverage and duplicate leakage checks; if a class cannot meet the constraints, document exclusion or a leave-group-out alternative rather than fabricating test coverage.

## Export

Dataset cards plus manifest in JSON/Parquet; classification directories for Ultralytics classification; COCO detection exports only when real boxes exist; segmentation export only with masks; manifest records ontology mapping, license, conversion version and loss of semantics. Round-trip tests preserve IDs and geometry where format supports them.
