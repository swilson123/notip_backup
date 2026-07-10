"""
integration_example.py

Demonstrates the full sidewalk-vision pipeline on a single synthetic frame.
No camera, no network, no GUI window required.

Run from this directory:
    python integration_example.py

Supply your own frame by replacing `frame_rgb` with a real H×W×3 uint8
numpy array in RGB channel order.
"""

import time
import types

import numpy as np

from fastscnn_detector      import FastSCNNDetector
from concrete_edge_detector import ConcreteEdgeDetector
from carrot_vision          import CarrotVision

# ── Camera intrinsics — replace with real values from your camera ──────────
# RealSense D435i at 640×480 defaults: fx ≈ 380, ppx ≈ 320
intrinsics = types.SimpleNamespace(fx=380.0, ppx=320.0)

# ── Synthetic test frame (480 × 640, RGB) ─────────────────────────────────
# A plain gray frame produces state=SEARCH (no sidewalk found), which is
# correct and exercises the full call chain without errors.
# Replace with: frame_rgb = cv2.cvtColor(cv2.imread("your_frame.jpg"), cv2.COLOR_BGR2RGB)
H, W = 480, 640
frame_rgb = np.full((H, W, 3), 128, dtype=np.uint8)

# ── Initialise ─────────────────────────────────────────────────────────────
print("Loading FastSCNNDetector …")
det    = FastSCNNDetector()    # starts background ONNX inference thread

print("Loading ConcreteEdgeDetector …")
ced    = ConcreteEdgeDetector()  # internally creates its own FastSCNNDetector

print("Loading CarrotVision …")
carrot = CarrotVision()

# ── Prime the background thread and wait for the first mask ───────────────
print("Priming FastSCNN (waiting up to 2 s for first inference) …")
det.segment_concrete(frame_rgb)
deadline = time.monotonic() + 2.0
mask = None
while mask is None and time.monotonic() < deadline:
    time.sleep(0.05)
    mask = det.segment_concrete(frame_rgb)

if mask is not None:
    print(f"  mask ready — {int(np.sum(mask > 0))} sidewalk pixels detected")
else:
    print("  mask not ready within 2 s (continuing — detect() handles None masks)")

# ── Step 1 + 2: segment + detect edges ────────────────────────────────────
print("\n[1+2] ConcreteEdgeDetector.detect() …")
# First call primes ced's own internal FastSCNN worker
_ = ced.detect(frame_rgb)
time.sleep(0.15)
# Second call uses the cached mask
edges = ced.detect(frame_rgb)

print(f"  state      : {edges['state']}")
print(f"  confidence : {edges['confidence']:.3f}")
print(f"  left_edge  : {'present (%d pts)' % len(edges['left_edge']) if edges['left_edge'] else None}")
print(f"  right_edge : {'present (%d pts)' % len(edges['right_edge']) if edges['right_edge'] else None}")

# ── Step 3: carrot generation ──────────────────────────────────────────────
print("\n[3] CarrotVision.compute() …")
result = carrot.compute(
    left_edge   = edges.get("left_edge"),
    right_edge  = edges.get("right_edge"),
    frame_shape = frame_rgb.shape,
    intrinsics  = intrinsics,
)

print(f"  path_valid     : {result['path_valid']}")
print(f"  carrot_angle   : {result['carrot_angle_deg']}")
print(f"  path_source    : {result['path_source']}")
print(f"  invalid_reason : {result['invalid_reason']}")

# ── Result ─────────────────────────────────────────────────────────────────
print()
if result["path_valid"]:
    print(f"OK — steering angle: {result['carrot_angle_deg']:+.2f} deg  "
          f"source: {result['path_source']}")
else:
    print(f"OK — no path on this frame ({result['invalid_reason']}); "
          f"pipeline ran without errors")

# ── Shutdown ───────────────────────────────────────────────────────────────
det.stop()
print("Done.")
