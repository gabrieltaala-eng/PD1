# Camera-based syringe angle

The app offers **Syringe angle source** in assessment setup and the Hardware panel.
Choose **CAMERA · YOLO angle estimate**, then begin an injection. The browser reuses
its current camera; no second webcam connection is opened. This works in Normal mode
and independently of all three AR tracking designs. RFID and other inputs still use
the separately selected hardware source (simulation or ESP32).

Install the optional dependencies from the repository root:

```powershell
.\backend\.venv\Scripts\python.exe -m pip install -r backend/requirements-camera.txt
```

Restart the backend after installation. The local trained checkpoint has been copied
from `pd_Train/runs/syringe_angle_full/weights/best.pt` to
`backend/models/syringe-angle.pt`. Checkpoints are excluded from Git; another computer
must copy this trained file too, or set `PUPVITALS_ANGLE_MODEL` before starting the backend.
The original `pd_Train/yolo26n.pt` is the pretrained starting checkpoint and does not
contain the syringe-angle classes.

The detector accepts exactly one detection at confidence ≥0.65. It uses the model's
18 class labels: 15–30 degrees, Below 15 degrees, Above 30 degrees. Open-ended classes
display their labels without inventing exact values. Missing, ambiguous, disconnected,
or expired results cannot confirm injection completion. Estimates expire after 1.5s;
inference taking over 1.5s is discarded. Change sources before starting the exercise.

Camera results can complete a prototype exercise and are recorded explicitly as
`yolo_angle_class_estimate`, `estimated: true`, `calibrated: false`, with model SHA-256,
confidence and class bounds. They never masquerade as MPU6050 measurements. A class
passes the prototype target only if its entire interval fits the configured target.

This is learned angle classification, not a geometric 3D syringe-to-pad measurement.
Use a fixed side view matching the training data, show one syringe and the pad clearly,
and validate predictions against known physical angles before using them for assessment.
The supplied training run used one epoch; its saved validation metrics alone do not
establish accuracy on the real dummy, new lighting, or a different camera viewpoint.
Frames are processed locally in memory and are not saved by this integration.

Ultralytics licensing applies to the optional dependency and model; see
https://www.ultralytics.com/license and https://docs.ultralytics.com/modes/predict/.
