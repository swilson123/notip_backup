# MobileSAM weights

This directory holds the ONNX weights for the MobileSAM segmenter. Restored
2026-07-07 (it was removed in the 2026-06-01 "bird eye update" commit along with
BEV and the funnel warp). Wired into `_detect_edges_hough` in
`realsense_vision.py`: when loaded, SAM's class-agnostic mask of the seed
point's surface REPLACES `_build_simple_ground_mask`'s HSV mask before Hough
line fitting — unlike fixed HSV ranges, it isn't fooled by mulch that happens
to be bright/desaturated enough to read as "concrete". Self-disables to the
HSV mask on any load/inference failure, so missing weights are safe, just
lower quality. Files are not checked into git because they're large.

Expected files in this directory:

- `mobile_sam_encoder.onnx` (~10 MB)
- `mobile_sam_decoder.onnx` (~6 MB)

Paths are configurable in `setup.json` under `realsense_vision.sam_encoder_path`
and `realsense_vision.sam_decoder_path`.

## How to produce them

Export on a real dev machine (Mac/PC) — confirmed 2026-07-07 there is NO
prebuilt PyTorch wheel for the rover's exact platform (aarch64 + Python 3.13),
so `pip install torch` on the Pi falls back to a from-source build, which
routinely takes hours and often fails outright on Pi-class hardware. Don't
attempt this on the rover.

This repo's own `scripts/export_onnx_model.py` only exports ONE half of the
pair — the prompt-encoder + mask-decoder combo (takes image *embeddings* as
input, matches our "decoder" file). There's no built-in script for the raw
image encoder; use the small custom one below for that half.

```bash
# On a dev machine (Mac/PC), in a venv to avoid PEP 668 "externally-managed-environment"
git clone https://github.com/ChaoningZhang/MobileSAM
cd MobileSAM
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
pip install onnx onnxruntime

# The checkpoint (~40 MB) already ships with the repo at: weights/mobile_sam.pt

# Export the decoder (this repo's own script)
python scripts/export_onnx_model.py \
    --checkpoint weights/mobile_sam.pt \
    --model-type vit_t \
    --output mobile_sam_decoder.onnx \
    --opset 13 \
    --return-single-mask

# Export the encoder (save export_mobile_sam_encoder.py, below, into the repo root first)
python export_mobile_sam_encoder.py \
    --checkpoint weights/mobile_sam.pt \
    --model-type vit_t \
    --output mobile_sam_encoder.onnx \
    --opset 13
```

`export_mobile_sam_encoder.py`:

```python
# Exports the MobileSAM image encoder (ViT-tiny backbone) alone to ONNX.
# export_onnx_model.py in this repo only exports the prompt-encoder + mask-decoder
# combo (takes image embeddings as input) -- this script produces the OTHER half:
# raw 1024x1024 image in, (1,256,64,64) embedding out.
import argparse
import torch
from mobile_sam import sam_model_registry

parser = argparse.ArgumentParser()
parser.add_argument("--checkpoint", type=str, required=True)
parser.add_argument("--model-type", type=str, required=True)
parser.add_argument("--output", type=str, required=True)
parser.add_argument("--opset", type=int, default=13)
args = parser.parse_args()

sam = sam_model_registry[args.model_type](checkpoint=args.checkpoint)
sam.eval()

# image_encoder expects an already-normalized, letterboxed 1024x1024 tensor --
# normalization (pixel_mean/pixel_std) lives in Sam.preprocess(), not in
# image_encoder itself, and mobilesam.py's _preprocess() on the rover already
# does that resize+pad+normalize step before calling this exported model.
dummy_input = torch.randn(1, 3, 1024, 1024, dtype=torch.float32)

torch.onnx.export(
    sam.image_encoder, dummy_input, args.output,
    input_names=["input_image"], output_names=["image_embeddings"],
    opset_version=args.opset, do_constant_folding=True,
)
print("Wrote " + args.output)
```

Then `scp` both `.onnx` files into this directory on the rover.

## Sanity check

After dropping the files in place, restart the rover and look for this status
line in the realsense logs:

```
{"message_type":"status","status":"sam_loaded","encoder":"...","decoder":"..."}
```

If you see `sam_load_failed` instead, the error string will tell you what's
wrong — most commonly a missing `onnxruntime` install, a path mismatch, or
an ONNX opset incompatibility.

## Runtime cost

On a Pi 5 (CPU, 2 threads):

| Stage                                  | Cost per frame |
|----------------------------------------|----------------|
| Encoder (runs when SAM is called)      | ~150–200 ms    |
| Decoder (single point prompt)          | ~30–50 ms      |

Because SAM only runs when the ONNX classifier produces a sparse mask, the
average frame budget is mostly unaffected. The pipeline degrades to ~5 FPS
during sustained off-sidewalk operation (where SAM carries every frame),
which is still well above what the 4 Hz mission tick needs.

## Why MobileSAM and not full SAM

Full SAM uses a ViT-H encoder (~2.5 GB, several seconds per frame on CPU).
MobileSAM swaps in a distilled ViT-Tiny encoder that's >50× smaller and
runs comfortably on a Pi-class CPU, with comparable mask quality on
medium-to-large objects (which is what a sidewalk surface is).
