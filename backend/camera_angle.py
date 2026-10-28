"""Local, optional YOLO angle-class inference. No webcam or frame storage."""
import hashlib
import math
import os
import re
from pathlib import Path
from threading import Lock


def angle_class(label):
    """Class bounds, never a fabricated number for an open-ended class."""
    label = label.strip().lower()
    match = re.fullmatch(r"(1[5-9]|2[0-9]|30) degrees", label)
    if match:
        value = float(match[1])
        return {"angle_deg": value, "lower_deg": value, "upper_deg": value}
    if label == "below 15 degrees":
        return {"angle_deg": None, "lower_deg": 0., "upper_deg": 15.}
    if label == "above 30 degrees":
        return {"angle_deg": None, "lower_deg": 30., "upper_deg": 90.}
    raise ValueError("Model must contain syringe angle classes, not general object classes.")


class CameraAngleDetector:
    def __init__(self, model_path=None):
        self.path = Path(model_path or os.environ.get("PUPVITALS_ANGLE_MODEL", "") or
                         Path(__file__).parent / "models/syringe-angle.pt")
        self.model = None
        self.lock = Lock()

    def load(self):
        with self.lock:
            if self.model is not None:
                return
            if not self.path.is_file():
                raise ValueError("Syringe model missing. Put trained best.pt at backend/models/syringe-angle.pt or set PUPVITALS_ANGLE_MODEL.")
            try:
                from ultralytics import YOLO
            except ImportError as error:
                raise ValueError("Install camera-angle dependencies: python -m pip install -r backend/requirements-camera.txt") from error
            model = YOLO(str(self.path), task="detect")
            labels = list(model.names.values())
            if model.task != "detect" or len(labels) != 18:
                raise ValueError("Use trained syringe-angle best.pt, not the pretrained yolo26n.pt.")
            for label in labels:
                angle_class(label)
            if len(set(labels)) != 18:
                raise ValueError("Syringe angle classes must be unique.")
            # Torch's first inference can take seconds. Warm up before accepting
            # a live frame so startup work never looks like a fresh measurement.
            import numpy as np
            model.predict(np.zeros((416, 416, 3), dtype=np.uint8), imgsz=416,
                          conf=.65, device="cpu", verbose=False, save=False, max_det=10)
            self.model_id = hashlib.sha256(self.path.read_bytes()).hexdigest()
            self.model = model

    def process(self, jpeg):
        import cv2
        import numpy as np
        if not jpeg or len(jpeg) > 1_000_000 or not jpeg.startswith(b"\xff\xd8"):
            raise ValueError("Send one JPEG smaller than 1 MB.")
        frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if frame is None or min(frame.shape[:2]) < 32 or max(frame.shape[:2]) > 960:
            raise ValueError("Camera frames must have sides between 32 and 960 pixels.")
        self.load()
        with self.lock:
            result = self.model.predict(frame, imgsz=416, conf=.65, device="cpu", verbose=False, save=False, max_det=10)[0]
            boxes = result.boxes
            if boxes is None or len(boxes) != 1:
                return {"detected": False, "detail": "Show exactly one syringe clearly, from the training camera viewpoint."}
            confidence = float(boxes.conf[0])
            if not math.isfinite(confidence) or confidence < .65:
                return {"detected": False, "detail": "Prediction confidence is too low."}
            label = result.names[int(boxes.cls[0])]
            return {"detected": True, "label": label, "confidence": round(confidence, 4),
                    "model_id": self.model_id, **angle_class(label)}
