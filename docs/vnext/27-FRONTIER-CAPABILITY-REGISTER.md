# 2027–2030+ capability watchlist (not mandatory release scope)

Every proposed frontier capability must have a clear customer/research use case, source/licensing review, new domain entities, an independent benchmark and a cost/safety gate. Do not promise unsupported sensor/robotics behavior.

| Theme | Candidate capability | Trigger to activate | Primary risk |
|---|---|---|---|
| Video intelligence | frame/event indexing, tracking, temporal retrieval, clip-level evals | suitable video dataset + real query set | storage, temporal error |
| Physical AI data | multi-camera timestamp sync, depth, pose, calibration, sensor bundles | robotics partner and ground truth | physical safety, simulation gap |
| Synthetic visual factory | scenario synthesis with label fidelity checks | rare failure class and real holdout improvement | label corruption, license |
| Open-vocabulary segmentation | concept prompts + region masks | evaluated precision for real domain | false positives and latency |
| Visual RAG | region-level grounded retrieval, OCR + visual embedding | retrieval relevance set and citation protocol | hallucinated evidence |
| Document intelligence | layout, OCR, extraction, provenance | document workload and field-level evals | privacy, schema variance |
| Fine-tuning low-rank / distillation | teacher-student cascade | measured TCO reduction under quality floor | inherited teacher errors |
| On-device/edge inference | exported ONNX/Core ML on compatible devices | device demand and measurement | hardware drift |
| Collaborative annotation | adjudication and quality analytics | multiple reviewers and real throughput need | RBAC/audit complexity |
| Domain knowledge graph | typed object relations and visual evidence | graph queries outperform SQL joins | ontology explosion |
| Federated/private ML | local training and restricted aggregation | verified legal/commercial need | privacy, reproducibility |
| Agents across organizations | A2A/MCP bounded collaboration | multiple independent organizations + contracts | trust and authority boundaries |

## Promotion gate

A research spike becomes a release candidate only if it documents actual sample size, benchmark, architecture impact, owner, operational burden and a falsifiable expected benefit. `R9` stays research until these exist.
