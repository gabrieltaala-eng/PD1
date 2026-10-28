"""Shared calibrated surface-angle calculation and stage-scoped smoothing.

Quaternions are active sensor-to-reference rotations in scalar-last [x,y,z,w]
order. Both reference frames must be aligned by the supplied calibration.
"""
import math
from copy import deepcopy


def unit(values, length):
    if len(values) != length or not all(math.isfinite(value) for value in values):
        raise ValueError("Invalid calibration vector or quaternion")
    norm = math.sqrt(sum(value*value for value in values))
    if norm < 1e-9:
        raise ValueError("Zero calibration vector or quaternion")
    return [value/norm for value in values]


def rotate(quaternion, vector):
    x, y, z, w = unit(quaternion, 4)
    vx, vy, vz = vector
    tx, ty, tz = 2*(y*vz-z*vy), 2*(z*vx-x*vz), 2*(x*vy-y*vx)
    return [vx+w*tx+y*tz-z*ty, vy+w*ty+z*tx-x*tz, vz+w*tz+x*ty-y*tx]


def surface_angle(syringe, dummy, calibration):
    axis = rotate(calibration["syringe_reference_rotation_xyzw"], rotate(syringe, unit(calibration["syringe_axis_sensor"], 3)))
    normal = rotate(calibration["dummy_reference_rotation_xyzw"], rotate(dummy, unit(calibration["surface_normal_sensor"], 3)))
    # Angle to the plane, not to its normal. The acute result is 0..90 degrees.
    dot = sum(a*b for a,b in zip(unit(axis, 3), unit(normal, 3)))
    return math.degrees(math.asin(min(1, max(0, abs(dot)))))


class AnglePipeline:
    def __init__(self, config, clock):
        self.config, self.clock = config, clock
        self.reset()

    def reset(self):
        self.latest = {}
        self.filters = {}

    def ingest_camera(self, prediction, stage_id):
        self.latest["camera"] = {
            "source": "camera", "injection_stage_id": stage_id,
            "method": "yolo_angle_class_estimate", "estimated": True,
            "calibrated": False, "calibration_id": None,
            "angle_deg": prediction.get("angle_deg"), "raw_angle_deg": prediction.get("angle_deg"),
            "label": prediction.get("label"), "confidence": prediction.get("confidence"),
            "model_id": prediction.get("model_id"), "lower_deg": prediction.get("lower_deg"),
            "upper_deg": prediction.get("upper_deg"), "detected": prediction.get("detected", False),
            "error": None if prediction.get("detected") else prediction.get("detail", "Syringe not detected."),
            "monotonic": self.clock(),
        }

    def ingest(self, data, source, stage_id):
        raw = data.get("angle_deg")
        calibrated = bool(data.get("calibrated") and (data.get("calibration_id") or "").strip())
        method = "firmware_calibrated_surface_angle"
        error = None
        syringe, dummy = data.get("syringe_quaternion"), data.get("dummy_quaternion")
        if syringe is not None or dummy is not None:
            calibration = self.config["angle_calibrations"].get(data.get("calibration_id"))
            method = "paired_quaternion_surface_angle"
            if not calibrated or syringe is None or dummy is None or not calibration:
                raw, calibrated = None, False
                error = "Paired orientations require a registered calibration and both sensor quaternions."
            else:
                try:
                    raw = surface_angle(syringe, dummy, calibration)
                except (ValueError, KeyError, TypeError) as cause:
                    raw, calibrated, error = None, False, str(cause)
        if raw is not None and (isinstance(raw, bool) or not math.isfinite(raw) or not 0 <= raw <= 90):
            raw, calibrated, error = None, False, "Angle must be a finite surface angle from 0 to 90 degrees."
        now = self.clock()
        key = (source, stage_id, data.get("calibration_id"), method)
        previous = self.filters.get(source)
        if calibrated and raw is not None:
            compatible = previous and previous["key"] == key and now-previous["time"] < self.config["hardware_timeout_seconds"]
            alpha = self.config["angle_smoothing_alpha"]
            filtered = previous["value"]+alpha*(raw-previous["value"]) if compatible else raw
            self.filters[source] = {"key": key, "value": filtered, "time": now}
        else:
            filtered = None
            self.filters.pop(source, None)
        sample = {"source": source, "injection_stage_id": stage_id, "angle_deg": None if filtered is None else round(filtered, 4), "raw_angle_deg": None if raw is None else round(raw, 4), "calibrated": calibrated, "calibration_id": data.get("calibration_id"), "method": method, "syringe_quaternion": data.get("syringe_quaternion"), "dummy_quaternion": data.get("dummy_quaternion"), "applied_calibration": deepcopy(self.config["angle_calibrations"].get(data.get("calibration_id"))) if method == "paired_quaternion_surface_angle" else None, "smoothing_alpha": self.config["angle_smoothing_alpha"], "error": error, "monotonic": now}
        self.latest[source] = sample
        return sample

    def snapshot(self, source, stage_id, connected):
        sample = self.latest.get(source)
        if not sample or sample["injection_stage_id"] != stage_id:
            return None
        result = {key: value for key, value in sample.items() if key != "monotonic"}
        age = max(0, self.clock()-sample["monotonic"])
        result.update({"age_seconds": round(age, 3), "fresh": connected and age < self.config["hardware_timeout_seconds"]})
        if source == "camera":
            result["fresh"] = result["fresh"] and sample["detected"] and age < 1.5
            result["within_target"] = bool(sample["detected"] and
                self.config["angle_min_deg"] <= sample["lower_deg"] <= sample["upper_deg"] <= self.config["angle_max_deg"])
            return result
        result["within_target"] = bool(sample["calibrated"] and sample["angle_deg"] is not None and all(self.config["angle_min_deg"] <= sample[key] <= self.config["angle_max_deg"] for key in ("angle_deg", "raw_angle_deg")))
        return result
