# Exports the MobileSAM image encoder (ViT-tiny backbone) alone to ONNX.
# export_onnx_model.py in the MobileSAM repo only exports the prompt-encoder +
# mask-decoder combo (takes image embeddings as input) -- this script produces
# the OTHER half: raw 1024x1024 image in, (1,256,64,64) embedding out. Together
# they match mobilesam.py's encoder/decoder pair.
#
# Run from the MobileSAM repo root (see run_on_mac.txt for the full sequence):
#   python export_mobile_sam_encoder.py --checkpoint weights/mobile_sam.pt \
#       --model-type vit_t --output mobile_sam_encoder.onnx --opset 13

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
    sam.image_encoder,
    dummy_input,
    args.output,
    input_names=["input_image"],
    output_names=["image_embeddings"],
    opset_version=args.opset,
    do_constant_folding=True,
)
print("Wrote " + args.output)
