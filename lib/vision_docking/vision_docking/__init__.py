"""vision-docking: precision visual docking using AprilTags and an Intel RealSense D435i.

This package deliberately does not re-export its submodules here. Each
layer of the pipeline (camera, detector, pose, tag_fusion,
docking_controller, state_machine) is imported explicitly by its
consumers -- keeping this file free of submodule imports avoids
import-order surprises and circular imports as the package grows.
"""
from __future__ import annotations

__version__ = "0.1.0"
