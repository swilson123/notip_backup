#!/usr/bin/env python3
# Run this once on any machine (laptop or Pi) that has torch + transformers.
#
#   pip install torch transformers
#   python lib/realsense/prepare_sidewalk_model.py
#
# Exports nvidia/segformer-b0-finetuned-cityscapes-512-1024 to ONNX.
# Copy the resulting sidewalk_model.onnx to the rover's lib/realsense/ directory.
# On the rover: pip install onnxruntime
# In setup.json realsense_vision, set:
#   "segmentation_model_path": "./lib/realsense/sidewalk_model.onnx"

import os
import sys

try:
    import torch
    from transformers import SegformerForSemanticSegmentation
except ImportError:
    print("Missing dependencies. Run: pip install torch transformers")
    sys.exit(1)

MODEL_NAME = "nvidia/segformer-b0-finetuned-cityscapes-512-1024"
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sidewalk_model.onnx")
INPUT_H = 256
INPUT_W = 512


class _Wrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, x):
        return self.model(pixel_values=x).logits


print(f"Downloading {MODEL_NAME} ...")
base_model = SegformerForSemanticSegmentation.from_pretrained(MODEL_NAME)
base_model.eval()
model = _Wrapper(base_model)

dummy = torch.zeros(1, 3, INPUT_H, INPUT_W)

print(f"Exporting to {OUTPUT_PATH} ...")
with torch.no_grad():
    torch.onnx.export(
        model,
        dummy,
        OUTPUT_PATH,
        opset_version=14,
        input_names=["pixel_values"],
        output_names=["logits"],
        dynamic_axes={
            "pixel_values": {2: "h", 3: "w"},
            "logits": {2: "oh", 3: "ow"},
        },
    )

size_mb = os.path.getsize(OUTPUT_PATH) / (1024 * 1024)
print(f"Saved: {OUTPUT_PATH} ({size_mb:.1f} MB)")
print()
print("Next steps on the rover:")
print("  pip install onnxruntime")
print('  In setup.json realsense_vision, set "segmentation_model_path": "./lib/realsense/sidewalk_model.onnx"')
