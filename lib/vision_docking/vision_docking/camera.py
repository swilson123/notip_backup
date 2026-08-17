"""Camera layer: the entry point of the docking pipeline.

    Camera -> AprilTag Detection -> Pose Estimation -> ...

Responsible for producing raw color frames and the `CameraIntrinsics`
that describe them. Everything downstream (`detector.py`, `pose.py`, ...)
depends only on those two things -- never on a specific camera SDK -- so
this module defines a small `CameraSource` interface first and a
RealSense-backed implementation second. A future simulated or
recorded-video camera source only needs to satisfy the same interface.

`pyrealsense2` is an optional hardware dependency (the `realsense` extra
in pyproject.toml) -- it is never imported at module import time, only
lazily inside `RealSenseCamera.open()`, so this module (and the rest of
the package) imports cleanly on a machine without the RealSense SDK
installed. Attempting to actually use `RealSenseCamera` without it
installed raises `RealSenseUnavailableError` with an actionable message.

TODO(vision-docking): implement a `RecordedVideoCamera` (or similar) that
    replays a `.bag` capture or a plain video file, for offline testing
    without physical hardware attached.
TODO(vision-docking): decide whether depth frames are exposed through
    this same interface (as a second return value) once range-assisted
    docking refinements are designed -- do not add that field
    speculatively before it has a consumer.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path
from types import TracebackType
from typing import Any, Protocol

import numpy as np

from .models import CameraIntrinsics

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class CameraError(Exception):
    """Base class for every error this module raises."""


class RealSenseUnavailableError(CameraError):
    """Raised when RealSense functionality is used but `pyrealsense2` is not installed."""


class CameraStartError(CameraError):
    """Raised when a `RealSenseCamera` fails to start streaming."""


class DeviceNotFoundError(CameraStartError):
    """Raised when a requested `serial_number` does not match any connected device."""


class CameraNotStartedError(CameraError):
    """Raised when a method that requires an active stream is called before
    `open()` (or after `close()`)."""


class FrameCaptureError(CameraError):
    """Raised when a frame cannot be captured: the wait for it timed out, or
    the frame returned by the SDK was empty/malformed."""


# ---------------------------------------------------------------------------
# Interface
# ---------------------------------------------------------------------------


class CameraSource(Protocol):
    """Interface every camera implementation in this package must satisfy.

    Consumers (`detector.py` and above) depend only on this Protocol,
    never on a concrete camera class -- this is the dependency-inversion
    seam that lets a simulated or recorded camera substitute for real
    hardware in tests.
    """

    def open(self) -> None:
        """Start streaming. Must be safe to call once before the first `read()`."""
        ...

    def close(self) -> None:
        """Stop streaming and release any underlying hardware/file handles."""
        ...

    def read(self) -> tuple[np.ndarray, float]:
        """Return the next (color_frame_bgr, capture_timestamp_s) pair.

        `capture_timestamp_s` is on a monotonic clock, not wall-clock --
        every downstream timestamp in this pipeline shares that
        convention (see `models.py`).
        """
        ...

    def get_intrinsics(self) -> CameraIntrinsics:
        """Return the intrinsics currently in effect for this stream."""
        ...


def _import_pyrealsense2() -> Any:
    """Import `pyrealsense2`, raising an actionable error if it is missing."""
    try:
        import pyrealsense2 as rs
    except ImportError as exc:
        raise RealSenseUnavailableError(
            "pyrealsense2 is required to use RealSenseCamera but is not "
            "installed. Install the optional RealSense extra with: "
            "pip install -e '.[realsense]'"
        ) from exc
    return rs


class RealSenseCamera:
    """`CameraSource` implementation backed by an Intel RealSense D435i/D435iF.

    Starts the color stream only (BGR8, suitable for OpenCV/AprilTag use
    directly); depth is not opened in this milestone (see module TODOs).
    Constructor takes explicit configuration (no hidden global state, no
    reading a config file itself) so callers wire it up via `config.py`'s
    loaded `CameraConfig`, keeping this class trivially testable with
    fakes -- see `tests/test_camera.py`, which substitutes a fake
    `pyrealsense2` module rather than requiring physical hardware.

    Intrinsics reported by `get_intrinsics()` always come from the SDK's
    *active* stream profile after `open()`, never from the requested
    width/height/fps -- the D435i may legitimately start a different
    profile than requested. `intrinsics_file` is accepted (mirroring
    `config/camera.yaml`) for forward-compatibility with
    `calibration.py`'s saved-intrinsics workflow, but is not read in this
    milestone: `calibration.load_intrinsics()` is not implemented yet, and
    live SDK intrinsics are the runtime source of truth regardless.
    Likewise `enable_depth` is accepted but not yet wired to a depth
    stream -- reserved for future range-assisted docking refinements.
    """

    def __init__(
        self,
        *,
        width: int,
        height: int,
        fps: int,
        serial_number: str = "",
        enable_depth: bool = True,
        auto_exposure: bool = True,
        manual_exposure: int | None = None,
        intrinsics_file: Path | None = None,
        frame_timeout_ms: int = 5000,
    ) -> None:
        self._width = width
        self._height = height
        self._fps = fps
        self._serial_number = serial_number
        self._enable_depth = enable_depth
        self._auto_exposure = auto_exposure
        self._manual_exposure = manual_exposure
        self._intrinsics_file = intrinsics_file
        self._frame_timeout_ms = frame_timeout_ms

        self._pipeline: Any = None
        self._is_running = False
        self._intrinsics: CameraIntrinsics | None = None
        self._device_name: str | None = None
        self._device_serial_number: str | None = None
        self._active_width: int | None = None
        self._active_height: int | None = None
        self._active_fps: int | None = None

    # -- lifecycle ----------------------------------------------------

    def open(self) -> None:
        """Start the color stream.

        Raises:
            RealSenseUnavailableError: `pyrealsense2` is not installed.
            DeviceNotFoundError: `serial_number` was set but no connected
                device reports that serial number.
            CameraStartError: already running, or the SDK failed to start
                or configure the pipeline for any other reason.
        """
        if self._is_running:
            raise CameraStartError(
                "RealSenseCamera is already started; call close() before "
                "calling open() again."
            )

        rs = _import_pyrealsense2()

        if self._serial_number:
            self._check_serial_number_connected(rs)

        pipeline = rs.pipeline()
        config = rs.config()
        if self._serial_number:
            config.enable_device(self._serial_number)
        config.enable_stream(
            rs.stream.color, self._width, self._height, rs.format.bgr8, self._fps
        )

        try:
            profile = pipeline.start(config)
        except Exception as exc:
            raise CameraStartError(
                f"Failed to start RealSense pipeline (serial_number="
                f"{self._serial_number!r}, {self._width}x{self._height}@"
                f"{self._fps}fps): {exc}"
            ) from exc

        try:
            self._apply_active_profile(profile, rs)
            self._configure_color_sensor(profile, rs)
        except Exception:
            pipeline.stop()
            raise

        self._pipeline = pipeline
        self._is_running = True
        logger.info(
            "RealSenseCamera started: device=%s serial=%s stream=%sx%s@%sfps",
            self._device_name,
            self._device_serial_number,
            self._active_width,
            self._active_height,
            self._active_fps,
        )

    def close(self) -> None:
        """Stop streaming. Safe to call multiple times, and safe to call
        even if `open()` was never called."""
        if not self._is_running:
            logger.debug("RealSenseCamera.close() called while not running; no-op.")
            return

        try:
            self._pipeline.stop()
        finally:
            self._pipeline = None
            self._is_running = False
            self._intrinsics = None
            self._device_name = None
            self._device_serial_number = None
            self._active_width = None
            self._active_height = None
            self._active_fps = None
        logger.info("RealSenseCamera stopped.")

    def __enter__(self) -> RealSenseCamera:
        self.open()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    # -- streaming ------------------------------------------------------

    def read(self) -> tuple[np.ndarray, float]:
        """Return the next (color_frame_bgr, capture_timestamp_s) pair.

        Raises:
            CameraNotStartedError: `open()` has not been called (or
                `close()` was called since).
            FrameCaptureError: no frame arrived within `frame_timeout_ms`,
                or the SDK returned an empty/malformed frame.
        """
        if not self._is_running:
            raise CameraNotStartedError(
                "RealSenseCamera.read() called before open() (or after close())."
            )

        try:
            frames = self._pipeline.wait_for_frames(self._frame_timeout_ms)
        except Exception as exc:
            raise FrameCaptureError(
                f"Timed out waiting for a frame after {self._frame_timeout_ms} ms: {exc}"
            ) from exc

        color_frame = frames.get_color_frame()
        if not color_frame:
            raise FrameCaptureError("RealSense pipeline returned an empty color frame.")

        image = np.asanyarray(color_frame.get_data())
        expected_shape = (self._active_height, self._active_width, 3)
        if image.shape != expected_shape or image.dtype != np.uint8:
            raise FrameCaptureError(
                f"Color frame had shape={image.shape} dtype={image.dtype}; "
                f"expected shape={expected_shape} dtype=uint8."
            )

        frame_bgr = np.ascontiguousarray(image)
        return frame_bgr, time.monotonic()

    def get_intrinsics(self) -> CameraIntrinsics:
        """Return the active stream's intrinsics.

        Raises:
            CameraNotStartedError: `open()` has not been called (or
                `close()` was called since).
        """
        if not self._is_running or self._intrinsics is None:
            raise CameraNotStartedError(
                "RealSenseCamera.get_intrinsics() called before open() (or after close())."
            )
        return self._intrinsics

    # -- diagnostics ------------------------------------------------------

    @property
    def is_running(self) -> bool:
        return self._is_running

    @property
    def device_name(self) -> str | None:
        """Detected device name, or `None` before `open()`."""
        return self._device_name

    @property
    def active_serial_number(self) -> str | None:
        """Serial number of the connected device, or `None` before `open()`."""
        return self._device_serial_number

    @property
    def active_width(self) -> int | None:
        """Active color stream width in pixels, or `None` before `open()`."""
        return self._active_width

    @property
    def active_height(self) -> int | None:
        """Active color stream height in pixels, or `None` before `open()`."""
        return self._active_height

    @property
    def active_fps(self) -> int | None:
        """Active color stream frame rate, or `None` before `open()`."""
        return self._active_fps

    # -- internals ------------------------------------------------------

    def _check_serial_number_connected(self, rs: Any) -> None:
        devices = rs.context().query_devices()
        available = [
            str(device.get_info(rs.camera_info.serial_number)) for device in devices
        ]
        if self._serial_number not in available:
            raise DeviceNotFoundError(
                f"No connected RealSense device with serial_number="
                f"{self._serial_number!r}. Connected devices: "
                f"{available if available else 'none'}."
            )

    def _apply_active_profile(self, profile: Any, rs: Any) -> None:
        video_profile = profile.get_stream(rs.stream.color).as_video_stream_profile()
        active_width = int(video_profile.width())
        active_height = int(video_profile.height())
        active_fps = int(video_profile.fps())

        raw_intrinsics = video_profile.get_intrinsics()
        intrinsics = CameraIntrinsics(
            fx=float(raw_intrinsics.fx),
            fy=float(raw_intrinsics.fy),
            cx=float(raw_intrinsics.ppx),
            cy=float(raw_intrinsics.ppy),
            width=active_width,
            height=active_height,
            distortion=tuple(float(c) for c in raw_intrinsics.coeffs),
        )

        device = profile.get_device()
        device_name = (
            str(device.get_info(rs.camera_info.name))
            if device.supports(rs.camera_info.name)
            else None
        )
        device_serial_number = (
            str(device.get_info(rs.camera_info.serial_number))
            if device.supports(rs.camera_info.serial_number)
            else None
        )

        self._intrinsics = intrinsics
        self._active_width = active_width
        self._active_height = active_height
        self._active_fps = active_fps
        self._device_name = device_name
        self._device_serial_number = device_serial_number

    def _configure_color_sensor(self, profile: Any, rs: Any) -> None:
        color_sensor = profile.get_device().first_color_sensor()
        color_sensor.set_option(
            rs.option.enable_auto_exposure, 1.0 if self._auto_exposure else 0.0
        )
        if not self._auto_exposure and self._manual_exposure is not None:
            color_sensor.set_option(rs.option.exposure, float(self._manual_exposure))
