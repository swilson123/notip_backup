"""AprilTag detection layer.

    Camera -> AprilTag Detection -> Pose Estimation -> ...

Takes a grayscale frame and produces zero or more `TagDetection` values
(pixel-space corners, no 3D information yet -- that is `pose.py`'s job).
Depends only on `models.py`.

Grayscale conversion is the caller's responsibility (see
`scripts/test_apriltags.py`), not this module's: `camera.py` hands out
BGR frames because that is what OpenCV/display code wants, but the
AprilTag detector only ever operates on a single-channel image, so
`TagDetector.detect()` takes that grayscale frame directly rather than
silently converting a BGR frame internally -- this keeps the color-space
conversion visible at the call site instead of hidden inside detection.

`pupil-apriltags` is an optional algorithm dependency (the `apriltag`
extra in pyproject.toml) -- it is never imported at module import time,
only lazily inside `AprilTagDetector.detect()`, so this module (and the
rest of the package) imports cleanly on a machine without it installed.
Attempting to actually detect tags without it installed raises
`AprilTagUnavailableError` with an actionable message.

TODO(vision-docking): decide how to expose per-family configuration if a
    future deployment needs more than one AprilTag family simultaneously
    -- config/tags.yaml currently assumes a single family.
"""
from __future__ import annotations

import logging
from typing import Any, Protocol

import numpy as np

from .models import TagDetection

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class TagDetectorError(Exception):
    """Base class for every error this module raises."""


class AprilTagUnavailableError(TagDetectorError):
    """Raised when AprilTag detection is used but `pupil-apriltags` is not installed."""


class InvalidTagImageError(TagDetectorError):
    """Raised when `detect()` is given an image that isn't a valid grayscale frame."""


class TagDetectionError(TagDetectorError):
    """Raised when the underlying AprilTag detector fails to construct or run."""


# ---------------------------------------------------------------------------
# Interface
# ---------------------------------------------------------------------------


class TagDetector(Protocol):
    """Interface every tag-detection backend in this package must satisfy.

    Consumers (`pose.py` and above) depend only on this Protocol, never
    on a specific AprilTag library -- swapping detection libraries later
    means writing a new class here, not touching any downstream module.
    """

    def detect(self, frame_gray: np.ndarray, timestamp: float) -> list[TagDetection]:
        """Return every tag detected in *frame_gray*, captured at *timestamp*.

        *frame_gray* must be a contiguous 2D `uint8` array -- callers are
        responsible for converting a BGR frame to grayscale first.
        """
        ...


def _import_pupil_apriltags() -> Any:
    """Import `pupil_apriltags`, raising an actionable error if it is missing."""
    try:
        import pupil_apriltags
    except ImportError as exc:
        raise AprilTagUnavailableError(
            "pupil-apriltags is required for AprilTag detection but is not "
            "installed. Install the optional AprilTag extra with: "
            "pip install -e '.[apriltag]'"
        ) from exc
    return pupil_apriltags


class AprilTagDetector:
    """`TagDetector` implementation backed by the `pupil-apriltags` library.

    Constructor takes explicit tuning parameters (mirroring
    `config/tags.yaml`'s `detector` section) rather than reading
    configuration itself, so it stays independently testable and
    swappable via dependency injection -- see `tests/test_detector.py`,
    which substitutes a fake `pupil_apriltags` module rather than
    requiring the real dependency.

    The underlying `pupil_apriltags.Detector` is constructed lazily, on
    first `detect()` call, so importing/instantiating this class never
    requires `pupil-apriltags` to be installed -- only actually detecting
    does.
    """

    def __init__(
        self,
        *,
        family: str,
        quad_decimate: float = 2.0,
        quad_sigma: float = 0.0,
        nthreads: int = 2,
        min_decision_margin: float = 35.0,
        refine_edges: bool = True,
        decode_sharpening: float = 0.25,
        debug: bool = False,
    ) -> None:
        self._family = family
        self._quad_decimate = quad_decimate
        self._quad_sigma = quad_sigma
        self._nthreads = nthreads
        self._min_decision_margin = min_decision_margin
        self._refine_edges = refine_edges
        self._decode_sharpening = decode_sharpening
        self._debug = debug
        self._detector: Any = None

    def detect(self, frame_gray: np.ndarray, timestamp: float) -> list[TagDetection]:
        """Return every tag detected in *frame_gray* above the configured
        minimum decision margin.

        Raises:
            InvalidTagImageError: *frame_gray* is not a 2D `uint8` array,
                or has a zero width/height.
            AprilTagUnavailableError: `pupil-apriltags` is not installed.
            TagDetectionError: the underlying detector failed to
                construct or run.
        """
        _validate_grayscale_image(frame_gray)
        image = np.ascontiguousarray(frame_gray)

        detector = self._get_or_create_detector()
        try:
            raw_detections = detector.detect(image)
        except Exception as exc:
            raise TagDetectionError(f"pupil_apriltags.Detector.detect() failed: {exc}") from exc

        detections = []
        for raw in raw_detections:
            decision_margin = float(raw.decision_margin)
            if decision_margin < self._min_decision_margin:
                continue
            detections.append(_map_raw_detection(raw, timestamp))
        return detections

    def _get_or_create_detector(self) -> Any:
        if self._detector is not None:
            return self._detector

        pupil_apriltags = _import_pupil_apriltags()
        try:
            self._detector = pupil_apriltags.Detector(
                families=self._family,
                nthreads=self._nthreads,
                quad_decimate=self._quad_decimate,
                quad_sigma=self._quad_sigma,
                refine_edges=1 if self._refine_edges else 0,
                decode_sharpening=self._decode_sharpening,
                debug=1 if self._debug else 0,
            )
        except Exception as exc:
            raise TagDetectionError(
                f"Failed to construct pupil_apriltags.Detector(families={self._family!r}): {exc}"
            ) from exc
        return self._detector


def _validate_grayscale_image(image: np.ndarray) -> None:
    if not isinstance(image, np.ndarray):
        raise InvalidTagImageError(
            f"Expected a numpy.ndarray, got {type(image).__name__}."
        )
    if image.ndim != 2:
        raise InvalidTagImageError(
            f"Expected a 2D grayscale image, got an array with shape "
            f"{image.shape} ({image.ndim} dimensions) -- convert BGR frames "
            "to grayscale before calling detect()."
        )
    if image.dtype != np.uint8:
        raise InvalidTagImageError(
            f"Expected dtype uint8, got {image.dtype}."
        )
    height, width = image.shape
    if width == 0 or height == 0:
        raise InvalidTagImageError(f"Image has a zero dimension: shape={image.shape}.")


def _map_raw_detection(raw: Any, timestamp: float) -> TagDetection:
    """Map one `pupil_apriltags.Detection` into this package's `TagDetection`.

    Keeps the third-party detection object entirely inside this module --
    nothing downstream ever sees a `pupil_apriltags` type.
    """
    tag_family = raw.tag_family
    family = tag_family.decode("ascii") if isinstance(tag_family, bytes) else str(tag_family)
    center = raw.center
    return TagDetection(
        tag_id=int(raw.tag_id),
        corners=np.asarray(raw.corners, dtype=np.float64),
        center=(float(center[0]), float(center[1])),
        decision_margin=float(raw.decision_margin),
        timestamp=timestamp,
        hamming=int(raw.hamming),
        family=family,
    )
