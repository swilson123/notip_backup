# MobileSAM ONNX inference wrapper.
#
# MobileSAM = Meta's Segment Anything model, distilled to a small ViT-tiny
# image encoder. Drop-in replacement for SAM with ~10x lower inference cost.
# Class-agnostic: give it an image and a point, it returns the segmentation
# mask of whatever object/surface contains that point. Designed for exactly
# the "click here, get the sidewalk" use case.
#
# ONNX layout (matches the export from the official MobileSAM repo):
#   encoder:  input  "input_image"          (1, 3, 1024, 1024) float32, RGB, SAM-normalised
#             output (1, 256, 64, 64) image embedding
#   decoder:  inputs
#               "image_embeddings"   (1, 256, 64, 64)
#               "point_coords"       (1, N, 2)   XY in 1024×1024 space
#               "point_labels"       (1, N)      1=foreground, 0=background, -1=padding
#               "mask_input"         (1, 1, 256, 256)  usually zeros
#               "has_mask_input"     (1,)        usually [0]
#               "orig_im_size"       (2,)        [H, W] of original image
#             outputs
#               "masks"              (1, K, H, W) logits
#               "iou_predictions"    (1, K)      per-mask predicted IoU; pick argmax
#               "low_res_masks"      (1, K, 256, 256)
#
# See ./README.md for how to obtain the two ONNX files.

import os
import time

import cv2
import numpy as np

try:
    import onnxruntime as ort
except ImportError:
    ort = None


# SAM uses ImageNet-style normalisation on raw 0–255 RGB values
_SAM_PIXEL_MEAN = np.array([123.675, 116.28,  103.53],  dtype=np.float32)
_SAM_PIXEL_STD  = np.array([ 58.395,  57.12,   57.375], dtype=np.float32)
_SAM_LONG_SIDE  = 1024


class MobileSAMSegmenter:
    def __init__(self, encoder_path, decoder_path, num_threads=2):
        if ort is None:
            raise RuntimeError("onnxruntime not installed — pip install onnxruntime")
        if not os.path.isfile(encoder_path):
            raise RuntimeError("encoder ONNX not found: " + encoder_path)
        if not os.path.isfile(decoder_path):
            raise RuntimeError("decoder ONNX not found: " + decoder_path)

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = num_threads
        opts.intra_op_num_threads = num_threads
        self.encoder = ort.InferenceSession(encoder_path, sess_options=opts,
                                            providers=["CPUExecutionProvider"])
        self.decoder = ort.InferenceSession(decoder_path, sess_options=opts,
                                            providers=["CPUExecutionProvider"])
        self.enc_input_name = self.encoder.get_inputs()[0].name
        # Cache decoder input names so we don't pay the lookup per call
        self.dec_input_names = [i.name for i in self.decoder.get_inputs()]

        # Last image embedding cache — if the same image bytes come through
        # twice (rare but possible during frame retries), reuse the embedding.
        self._last_image_id = None
        self._last_embedding = None

    @staticmethod
    def _preprocess(image_bgr):
        h, w = image_bgr.shape[:2]
        scale = _SAM_LONG_SIDE / float(max(h, w))
        new_h = int(round(h * scale))
        new_w = int(round(w * scale))
        resized = cv2.resize(image_bgr, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32)
        rgb = (rgb - _SAM_PIXEL_MEAN) / _SAM_PIXEL_STD
        padded = np.zeros((_SAM_LONG_SIDE, _SAM_LONG_SIDE, 3), dtype=np.float32)
        padded[:new_h, :new_w] = rgb
        # NHWC → NCHW, add batch dim
        tensor = np.transpose(padded, (2, 0, 1))[np.newaxis]
        return tensor, scale, (h, w)

    def infer(self, image_bgr, point_xy):
        """Return a binary mask (uint8 0/255) same size as image_bgr.

        point_xy: (x, y) in the original image coordinates of a foreground
        prompt — typically the bottom-center of the frame (the surface the
        rover is currently standing on)."""

        tensor, scale, (orig_h, orig_w) = self._preprocess(image_bgr)
        image_id = id(image_bgr)
        if image_id == self._last_image_id and self._last_embedding is not None:
            image_embeddings = self._last_embedding
        else:
            image_embeddings = self.encoder.run(None, {self.enc_input_name: tensor})[0]
            self._last_image_id = image_id
            self._last_embedding = image_embeddings

        # Map the prompt point into 1024-space
        px = float(point_xy[0]) * scale
        py = float(point_xy[1]) * scale
        point_coords = np.array([[[px, py]]], dtype=np.float32)
        point_labels = np.array([[1.0]], dtype=np.float32)

        decoder_inputs = {
            "image_embeddings": image_embeddings,
            "point_coords":     point_coords,
            "point_labels":     point_labels,
            "mask_input":       np.zeros((1, 1, 256, 256), dtype=np.float32),
            "has_mask_input":   np.zeros((1,), dtype=np.float32),
            "orig_im_size":     np.array([orig_h, orig_w], dtype=np.float32),
        }
        # Some ONNX exports use different input names; tolerate missing ones
        decoder_inputs = {k: v for k, v in decoder_inputs.items() if k in self.dec_input_names}

        outputs = self.decoder.run(None, decoder_inputs)
        masks = outputs[0]              # (1, K, H, W) logits
        iou   = outputs[1] if len(outputs) > 1 else None

        if iou is not None:
            best_idx = int(np.argmax(iou[0]))
        else:
            best_idx = 0

        mask_logits = masks[0, best_idx]
        if mask_logits.shape != (orig_h, orig_w):
            mask_logits = cv2.resize(mask_logits, (orig_w, orig_h), interpolation=cv2.INTER_LINEAR)
        return (mask_logits > 0).astype(np.uint8) * 255
