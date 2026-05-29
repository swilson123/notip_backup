# MobileSAM weights

This directory holds the ONNX weights for the MobileSAM segmenter used by
`realsense_vision.py` as the primary fallback when the Cityscapes ONNX
classifier (`sidewalk_model.onnx`) gives up. Files are not checked into git
because they're large.

Expected files in this directory:

- `mobile_sam_encoder.onnx` (~10 MB)
- `mobile_sam_decoder.onnx` (~6 MB)

Paths are configurable in `setup.json` under `realsense_vision.sam_encoder_path`
and `realsense_vision.sam_decoder_path`.

## How to produce them

The simplest path is to export from the official MobileSAM PyTorch checkpoint
on a development machine, then copy the resulting `.onnx` files onto the rover.

```bash
# On a dev machine (NOT the Pi — torch is too heavy to install on the rover)
git clone https://github.com/ChaoningZhang/MobileSAM
cd MobileSAM
pip install -e .

# Download the checkpoint (4 MB)
# It already ships with the repo at: weights/mobile_sam.pt

# Export encoder
python scripts/export_onnx_model.py \
    --checkpoint weights/mobile_sam.pt \
    --model-type vit_t \
    --output mobile_sam_encoder.onnx \
    --opset 13

# Export decoder (separate script in the repo)
python scripts/export_onnx_decoder_model.py \
    --checkpoint weights/mobile_sam.pt \
    --model-type vit_t \
    --output mobile_sam_decoder.onnx \
    --opset 13 \
    --return-single-mask
```

Then `scp` both files into this directory on the rover.

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
