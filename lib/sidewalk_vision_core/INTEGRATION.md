# Sidewalk Vision Core — Integration Reference

Three self-contained modules.  No camera driver, no network server, no browser
frontend required.  Drop them into any Python project and call them in sequence.

---

## Dependencies

```
pip install numpy>=1.24 opencv-python>=4.8 onnxruntime>=1.17
```

For GPU inference replace `onnxruntime` with `onnxruntime-gpu`.

---

## Module 1 — FastSCNN segmentation

**File:** `fastscnn_detector.py`  
**Class:** `FastSCNNDetector`

### What it does
Runs a trained FastSCNN ONNX model in a daemon background thread.  Each call
to `segment_concrete()` queues the frame and immediately returns the last
cached segmentation mask, so it never blocks the calling thread.

### Model file required
`models/fastscnn_sidewalk.onnx` must sit alongside `fastscnn_detector.py`.
The path is resolved relative to `__file__` at line 17:
```python
MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "fastscnn_sidewalk.onnx")
```

### Input
```python
color_rgb: np.ndarray  # shape (H, W, 3), dtype uint8, RGB channel order
```

### Output
```python
mask: np.ndarray | None
# shape (H, W), dtype uint8
# 255 = sidewalk pixel, 0 = background
# None until the first inference completes (~50–150 ms after first call)
```

### Initialization
```python
from fastscnn_detector import FastSCNNDetector
det = FastSCNNDetector()                         # starts background thread immediately
det = FastSCNNDetector(model_path="custom.onnx") # optional explicit path
det = FastSCNNDetector(threshold=0.6)            # optional sigmoid threshold (default 0.5)
```

### Shutdown
```python
det.stop()   # signals the background thread to exit
```

---

## Module 2 — Edge detection

**File:** `concrete_edge_detector.py`  
**Class:** `ConcreteEdgeDetector`

### What it does
Selects the sidewalk blob connected to the anchor region (directly ahead of the
rover), then fits RANSAC degree-2 polynomial boundaries to the left and right
edges of that blob.  Includes a 5-frame temporal smoothing deque and a raw-point
fallback when RANSAC fails.

Internally creates a `FastSCNNDetector` instance on construction — both modules
must be in the same directory.

### Input
```python
color_rgb:  np.ndarray          # (H, W, 3) uint8 RGB — same frame fed to FastSCNN
depth_z16:  np.ndarray | None   # (H, W) uint16 mm depth — pass None to skip geometry filter
intrinsics: object | None       # object with .fx .fy .ppx .ppy — pass None to skip geometry filter
pitch_rad:  float               # camera pitch (default 0.0)
roll_rad:   float               # camera roll  (default 0.0)
```

### Output
```python
{
    "state":         "TRACK" | "SEARCH",          # TRACK when a valid edge pair is found
    "left_edge":     [(x, y), ...] | None,        # left boundary polyline, top-to-bottom
    "right_edge":    [(x, y), ...] | None,        # right boundary polyline, top-to-bottom
    "centerline":    None,                        # not computed here; see CarrotVision
    "left_poly":     np.ndarray | None,           # polynomial coefficients (degree 2)
    "right_poly":    np.ndarray | None,
    "confidence":    float,                       # 0.0–1.0
    "left_measured": bool,                        # True when a polynomial was committed
    "right_measured": bool,
    "approach_x":    None,
    "approach_y":    None,
    "debug":         dict,                        # internal debug state; ignore in production
}
```

`left_edge` and `right_edge` are lists of `(int x, int y)` tuples in **image
pixel coordinates**, ordered **top-to-bottom** (smallest y first).

### Initialization
```python
from concrete_edge_detector import ConcreteEdgeDetector
ced = ConcreteEdgeDetector()
# Internally starts a FastSCNNDetector background thread.
# The first call to detect() may return state="SEARCH" while FastSCNN warms up.
```

---

## Module 3 — Carrot generation

**File:** `carrot_vision.py`  
**Class:** `CarrotVision`

### What it does
Takes the edge polylines from `ConcreteEdgeDetector`, builds a pixel-space
centerline, interpolates a steering target ("carrot") at a configurable
lookahead row, applies EMA and per-frame speed limiting for temporal stability,
and outputs a single signed steering angle in degrees.

### Input to `compute()`
```python
left_edge:   list[(x, y)] | None   # directly from concrete_edge_detector result["left_edge"]
right_edge:  list[(x, y)] | None   # directly from concrete_edge_detector result["right_edge"]
frame_shape: tuple                  # (H, W) or (H, W, C) — same frame shape
intrinsics:  object                 # object with .fx (focal length) and .ppx (principal point x)
```

### Output
```python
{
    "path_valid":           bool,
    "carrot_angle_deg":     float | None,   # signed degrees; negative=left, positive=right
    "raw_carrot_angle_deg": float | None,   # before EMA / speed-limit (diagnostic)
    "carrot_point_px":      (int, int) | None,  # (x, y) pixel position of the carrot
    "centerline_px":        [(x, y), ...],      # display centerline polyline
    "path_source":          str,            # "BOTH_EDGES" | "LEFT_EDGE_ONLY" | "RIGHT_EDGE_ONLY"
                                            # | "HELD" | "INVALID"
    "invalid_reason":       str | None,
}
```

### Initialization and configuration
```python
from carrot_vision import CarrotVision, CarrotVisionConfig

# Default config
carrot = CarrotVision()

# Custom config
cfg = CarrotVisionConfig(
    carrot_y_frac       = 0.55,    # image-row fraction for the lookahead target
    max_abs_angle_deg   = 35.0,    # hard clamp on output angle
    carrot_ema_alpha    = 0.30,    # EMA weight (1.0 = no smoothing)
    carrot_max_jump_px  = 50.0,    # max carrot movement per frame
    hold_frames         = 6,       # frames to hold last known angle when edges disappear
    single_edge_history_frames = 10,
)
carrot = CarrotVision(cfg)
```

### Reset
```python
carrot.reset()   # clears EMA state; call when the scene changes abruptly
```

---

## Intrinsics object

`CarrotVision.compute()` requires an object with `.fx` and `.ppx`.  If your
rover has a different camera interface, supply a simple namespace:

```python
import types
intr = types.SimpleNamespace(fx=380.0, ppx=320.0)
```

Replace `380.0` with the camera's horizontal focal length in pixels and `320.0`
with the principal-point x-coordinate (typically ≈ image_width / 2).

---

## Exact imports

```python
from fastscnn_detector     import FastSCNNDetector
from concrete_edge_detector import ConcreteEdgeDetector
from carrot_vision         import CarrotVision, CarrotVisionConfig
```

---

## Full initialization sequence

```python
import time
from fastscnn_detector      import FastSCNNDetector
from concrete_edge_detector import ConcreteEdgeDetector
from carrot_vision          import CarrotVision

det    = FastSCNNDetector()      # background ONNX thread starts immediately
ced    = ConcreteEdgeDetector()  # internally creates its own FastSCNNDetector
carrot = CarrotVision()

# Prime the FastSCNN worker with one frame, then wait for the first result
# det.segment_concrete(first_frame_rgb)
# time.sleep(0.15)
```

---

## Per-frame production call

```python
# color_rgb: H×W×3 uint8 numpy array (RGB order)
edges  = ced.detect(color_rgb)                    # step 1 + 2: segment + detect edges
result = carrot.compute(                           # step 3: centerline + carrot
    left_edge   = edges.get("left_edge"),
    right_edge  = edges.get("right_edge"),
    frame_shape = color_rgb.shape,
    intrinsics  = intr,
)

if result["path_valid"]:
    steering_deg = result["carrot_angle_deg"]      # send to rover motor controller
```

---

## Known limitations

- FastSCNN returns `None` for the first ~100 ms after construction while the
  background thread completes the first inference.  Check for `None` before
  passing the mask to downstream code.
- `ConcreteEdgeDetector` maintains its own internal `FastSCNNDetector` instance.
  Do not share a `FastSCNNDetector` instance between `ConcreteEdgeDetector` and
  calling code — each should use the instance created in the constructor.
- `CarrotVision` uses a fixed image-row lookahead (`carrot_y_frac`).  On steep
  perspective views this samples near the perspective convergence zone; reduce
  `carrot_y_frac` toward `0.7–0.8` to stay further from the vanishing point.
- `cv2` (opencv-python) is an optional dependency for `carrot_vision.py` — the
  `compute()` method works without it.  Only `draw_debug()` requires cv2.
