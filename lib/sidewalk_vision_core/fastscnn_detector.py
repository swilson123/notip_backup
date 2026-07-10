"""
fastscnn_detector.py — Drop-in replacement for ZeroShotDetector using the
trained FastSCNN ONNX model.

Usage (same API as ZeroShotDetector):
    det = FastSCNNDetector()
    mask = det.segment_concrete(color_rgb)   # uint8 (H, W) 255=sidewalk or None
"""

import os
import threading
import time

import cv2
import numpy as np

MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "fastscnn_sidewalk.onnx")

THRESHOLD       = 0.5    # sigmoid threshold — raise to be stricter, lower to catch more
UPDATE_INTERVAL = 0.05   # seconds between inference calls (~20fps cap)


class FastSCNNDetector:
    """
    Runs FastSCNN ONNX in a background thread, same interface as ZeroShotDetector.
    Requires: pip install onnxruntime
    """

    def __init__(self, model_path=None, threshold=THRESHOLD):
        import onnxruntime as ort

        self.backend  = "fastscnn"
        self.threshold = threshold

        path = model_path or MODEL_PATH
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        self._session = ort.InferenceSession(path, providers=providers)
        self._input_name  = self._session.get_inputs()[0].name
        self._output_name = self._session.get_outputs()[0].name

        # Get expected input size from model
        shape = self._session.get_inputs()[0].shape  # [batch, 3, H, W]
        self._model_h = shape[2] if isinstance(shape[2], int) else 480
        self._model_w = shape[3] if isinstance(shape[3], int) else 640

        # Cached result
        self._mask_cache      = None
        self._cache_lock      = threading.Lock()
        self._last_mask_after_cut = None

        # Background thread
        self._thread_frame = None
        self._thread_lock  = threading.Lock()
        self._thread_event = threading.Event()
        self._stop         = False
        self._last_ts      = 0.0

        threading.Thread(target=self._worker, daemon=True).start()

    def segment_concrete(self, color_rgb):
        """Queue frame; return cached mask immediately. Same API as ZeroShotDetector."""
        with self._thread_lock:
            self._thread_frame = color_rgb.copy()
        self._thread_event.set()
        with self._cache_lock:
            return self._mask_cache

    def stop(self):
        self._stop = True
        self._thread_event.set()

    def _worker(self):
        while not self._stop:
            self._thread_event.wait(timeout=1.0)
            self._thread_event.clear()
            if self._stop:
                break

            with self._thread_lock:
                frame = self._thread_frame
            if frame is None:
                continue

            elapsed = time.monotonic() - self._last_ts
            if elapsed < UPDATE_INTERVAL:
                time.sleep(UPDATE_INTERVAL - elapsed)

            try:
                mask = self._infer(frame)
                with self._cache_lock:
                    self._mask_cache          = mask
                    self._last_mask_after_cut = mask
                self._last_ts = time.monotonic()
            except Exception:
                pass

    def _infer(self, color_rgb):
        H, W = color_rgb.shape[:2]

        # Resize to model input size if needed
        if H != self._model_h or W != self._model_w:
            img = cv2.resize(color_rgb, (self._model_w, self._model_h))
        else:
            img = color_rgb

        # Normalise to [0,1] float32, NCHW
        tensor = img.astype(np.float32) / 255.0
        tensor = tensor.transpose(2, 0, 1)[np.newaxis]  # (1, 3, H, W)

        logits = self._session.run([self._output_name], {self._input_name: tensor})[0]
        prob   = 1.0 / (1.0 + np.exp(-logits[0, 0]))   # sigmoid, (H, W)

        mask = (prob > self.threshold).astype(np.uint8) * 255

        # Resize back to original frame size if we resized input
        if mask.shape != (H, W):
            mask = cv2.resize(mask, (W, H), interpolation=cv2.INTER_NEAREST)

        return mask
