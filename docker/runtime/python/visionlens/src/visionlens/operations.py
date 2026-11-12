"""The five frozen operations with deterministic simulated behavior.

Every operation is a pure function of its params plus the resolved model:
no network, no weights, no wall-clock dependence in the results. Progress is
reported through the context so the worker keeps the frame sequence rules,
and the checkpoint callable stops the operation on cancel or deadline.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Callable, Mapping, Tuple

from .encoder import DTYPE, digest_of, embed_bytes, preprocessing_fingerprint, unit_interval
from .errors import ErrorCode, WorkerError
from .registry import ModelRegistry, ModelSpec, UnknownModelError

#: The frozen label set the simulated predictor draws from.
LABELS: Tuple[str, ...] = ("label.bicycle", "label.boat", "label.cat", "label.dog", "label.plane")

#: The frozen label set the simulated dataset audit classifies into.
AUDIT_CLASSES: Tuple[str, ...] = ("bicycle", "boat", "cat", "dog")


@dataclass(frozen=True)
class Recipe:
    """A frozen training recipe: step count, per-step delay and token cost."""

    steps: int
    sleep_seconds: float
    tokens_per_step: int


#: The frozen recipe table of the simulated trainer.
RECIPES: dict[str, Recipe] = {
    "quick": Recipe(steps=4, sleep_seconds=0.0, tokens_per_step=100),
    "standard": Recipe(steps=12, sleep_seconds=0.005, tokens_per_step=250),
    "slow": Recipe(steps=100, sleep_seconds=0.05, tokens_per_step=10),
}


@dataclass(frozen=True)
class OperationContext:
    """What an operation may touch: the registry, the budget and the worker."""

    registry: ModelRegistry
    installed_extras: Tuple[str, ...]
    max_tokens: int | None
    progress: Callable[[int, int], None]
    checkpoint: Callable[[], None]
    sleep: Callable[[float], None]


def _string_param(params: Mapping[str, object], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise WorkerError(ErrorCode.MALFORMED_FRAME, "params." + key + " must be a non-empty string")
    return value


def _string_list_param(params: Mapping[str, object], key: str) -> list[str]:
    value = params.get(key)
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise WorkerError(ErrorCode.MALFORMED_FRAME, "params." + key + " must be an array of strings")
    return value


def _resolve_model(ctx: OperationContext, model_id: str) -> ModelSpec:
    try:
        spec = ctx.registry.resolve(model_id)
    except UnknownModelError as exc:
        raise WorkerError(ErrorCode.MALFORMED_FRAME, str(exc)) from None
    if spec.required_extra is not None and spec.required_extra not in ctx.installed_extras:
        raise WorkerError(
            ErrorCode.MISSING_EXTRA,
            "model '"
            + model_id
            + "' requires the '"
            + spec.required_extra
            + "' extra; install visionlens["
            + spec.required_extra
            + "] to use it",
        )
    return spec


def _embed_images(
    params: Mapping[str, object], ctx: OperationContext, model_id: str
) -> Tuple[list[str], list[list[float]], ModelSpec]:
    images = _string_list_param(params, "images")
    requested_device = params.get("device", "cpu")
    if not isinstance(requested_device, str):
        raise WorkerError(ErrorCode.MALFORMED_FRAME, "params.device must be a string")
    if requested_device not in ("cpu", "auto"):
        raise WorkerError(
            ErrorCode.UNSUPPORTED_PROTOCOL,
            "device '"
            + requested_device
            + "' is not supported; this worker serves: cpu",
        )
    spec = _resolve_model(ctx, model_id)
    # CPU is the reference behavior; "auto" resolves to cpu on this worker and
    # no fallback ever happens, so fallbackReason is never emitted.
    chosen = "cpu"
    if chosen not in spec.device_support:
        raise WorkerError(
            ErrorCode.UNSUPPORTED_PROTOCOL,
            "model '"
            + model_id
            + "' does not support device '"
            + chosen
            + "'; supported: "
            + ", ".join(spec.device_support),
        )
    total = len(images)
    ctx.checkpoint()
    ctx.progress(0, total)
    vectors: list[list[float]] = []
    for index, reference in enumerate(images, start=1):
        ctx.checkpoint()
        vectors.append(embed_bytes(reference.encode("utf-8"), spec))
        ctx.progress(index, total)
    return images, vectors, spec


def run_embed(params: Mapping[str, object], ctx: OperationContext) -> dict[str, object]:
    """vision.embed: deterministic vectors derived from the ModelSpec."""
    model_id = _string_param(params, "model")
    images, vectors, spec = _embed_images(params, ctx, model_id)
    return {
        "model": model_id,
        "dimension": spec.dimension,
        "dtype": DTYPE,
        "count": len(images),
        "vectors": vectors,
        "artifactSha256": digest_of(
            {
                "modelId": spec.model_id,
                "revision": spec.revision,
                "preprocessingFingerprint": preprocessing_fingerprint(spec),
                "vectors": vectors,
            }
        ),
        "preprocessingFingerprint": preprocessing_fingerprint(spec),
        "device": "cpu",
    }


def run_predict(params: Mapping[str, object], ctx: OperationContext) -> dict[str, object]:
    """vision.predict: deterministic labels and probabilities per image."""
    model_id = _string_param(params, "model")
    images, _vectors, spec = _embed_images(params, ctx, model_id)
    seed_domain = b"visionlens.predict\0" + spec.model_id.encode("utf-8") + b"\0"
    predictions: list[dict[str, object]] = []
    for reference in images:
        seed = seed_domain + reference.encode("utf-8")
        digest = hashlib.sha256(seed).digest()
        label = LABELS[int.from_bytes(digest[:8], "big") % len(LABELS)]
        probability = round(unit_interval(seed, 0) * 0.98 + 0.01, 6)
        predictions.append({"image": reference, "labelKey": label, "probability": probability})
    return {
        "model": model_id,
        "predictions": predictions,
        "artifactSha256": digest_of(
            {"modelId": spec.model_id, "revision": spec.revision, "predictions": predictions}
        ),
    }


def run_dataset_audit(params: Mapping[str, object], ctx: OperationContext) -> dict[str, object]:
    """dataset.audit: deterministic counts derived from the dataset root."""
    root = _string_param(params, "root")
    ctx.checkpoint()
    ctx.progress(0, 1)
    digest = hashlib.sha256(b"visionlens.dataset.audit\0" + root.encode("utf-8")).digest()
    class_counts: dict[str, int] = {}
    for class_name in AUDIT_CLASSES:
        class_digest = hashlib.sha256(digest + class_name.encode("utf-8")).digest()
        class_counts[class_name] = 1 + int.from_bytes(class_digest[:4], "big") % 40
    samples = sum(class_counts.values())
    duplicates = int.from_bytes(digest[:4], "big") % (samples // 4 + 1)
    missing_hashes = int.from_bytes(digest[4:8], "big") % 3
    license_gaps = int.from_bytes(digest[8:12], "big") % 3
    ctx.progress(1, 1)
    return {
        "samples": samples,
        "duplicates": duplicates,
        "missingHashes": missing_hashes,
        "classCounts": class_counts,
        "licenseGaps": license_gaps,
    }


def run_eval(params: Mapping[str, object], ctx: OperationContext) -> dict[str, object]:
    """eval.run: deterministic quality metrics for a split and predictions."""
    split = _string_param(params, "split")
    predictions = _string_param(params, "predictions")
    ctx.checkpoint()
    ctx.progress(0, 1)
    seed = (
        b"visionlens.eval.run\0" + split.encode("utf-8") + b"\0" + predictions.encode("utf-8")
    )
    per_class = {
        label: round(unit_interval(seed, index), 6)
        for index, label in enumerate(LABELS)
    }
    macro_f1 = round(sum(per_class.values()) / len(per_class), 6)
    balanced_accuracy = round(unit_interval(seed + b"\0bal", 0), 6)
    ece = round(unit_interval(seed + b"\0ece", 0) * 0.2, 6)
    support = 1 + int.from_bytes(hashlib.sha256(seed).digest()[:4], "big") % 200
    ctx.progress(1, 1)
    return {
        "macroF1": macro_f1,
        "perClass": per_class,
        "balancedAccuracy": balanced_accuracy,
        "ece": ece,
        "support": support,
    }


def run_train(params: Mapping[str, object], ctx: OperationContext) -> dict[str, object]:
    """model.train: deterministic step loop honoring cancel, deadline and tokens."""
    dataset = _string_param(params, "dataset")
    recipe_name = _string_param(params, "recipe")
    recipe = RECIPES.get(recipe_name)
    if recipe is None:
        raise WorkerError(
            ErrorCode.MALFORMED_FRAME,
            "unknown recipe '"
            + recipe_name
            + "'; known recipes: "
            + ", ".join(sorted(RECIPES)),
        )
    token_cost = recipe.steps * recipe.tokens_per_step
    if ctx.max_tokens is not None and token_cost > ctx.max_tokens:
        raise WorkerError(
            ErrorCode.BUDGET_EXCEEDED,
            "simulated token cost "
            + str(token_cost)
            + " exceeds budget.maxTokens "
            + str(ctx.max_tokens),
        )
    ctx.checkpoint()
    ctx.progress(0, recipe.steps)
    for step in range(1, recipe.steps + 1):
        ctx.checkpoint()
        ctx.sleep(recipe.sleep_seconds)
        ctx.checkpoint()
        ctx.progress(step, recipe.steps)
    seed = (
        b"visionlens.model.train\0"
        + dataset.encode("utf-8")
        + b"\0"
        + recipe_name.encode("utf-8")
    )
    model_id = "sim-" + hashlib.sha256(seed).hexdigest()[:12]
    metrics = {
        "steps": recipe.steps,
        "finalLoss": round(unit_interval(seed, 0), 6),
        "accuracy": round(unit_interval(seed, 1), 6),
    }
    return {
        "modelId": model_id,
        "artifactSha256": digest_of(
            {
                "dataset": dataset,
                "recipe": recipe_name,
                "modelId": model_id,
                "metrics": metrics,
            }
        ),
        "metrics": metrics,
    }


#: The frozen operation table: every advertised operation has one handler.
OPERATION_HANDLERS: dict[
    str, Callable[[Mapping[str, object], OperationContext], dict[str, object]]
] = {
    "vision.embed": run_embed,
    "vision.predict": run_predict,
    "dataset.audit": run_dataset_audit,
    "eval.run": run_eval,
    "model.train": run_train,
}
