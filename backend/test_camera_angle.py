import unittest
from unittest.mock import Mock
from types import SimpleNamespace
import cv2
import numpy as np
from assessment import AssessmentService, AssessmentError
from camera_angle import CameraAngleDetector, angle_class


class CameraAngleTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.
        self.service = AssessmentService(clock=lambda: self.now)

    def command(self, action, **fields):
        state = self.service.snapshot()
        return self.service.command({"action": action, "session_id": state["session_id"],
                                        "injection_stage_id": state["injection_stage_id"], **fields})

    def begin(self, source="simulation"):
        self.command("set_input_source", input_source=source)
        self.command("set_angle_source", angle_source="camera")
        self.command("select_mode", mode="full")
        return self.command("begin_injection")

    def predict(self, label="22 degrees", **overrides):
        state = self.service.snapshot()
        prediction = {"detected": True, "label": label, "confidence": .9, "model_id": "test-model", **angle_class(label), **overrides}
        return self.service.camera_angle(prediction, state["session_id"], state["injection_stage_id"])

    def test_camera_is_independent_of_hardware_and_not_claimed_calibrated(self):
        state = self.begin("esp32")
        self.assertFalse(state["hardware"]["mpu_connected"])
        sample = self.predict()
        self.assertTrue(sample["fresh"])
        self.assertFalse(sample["calibrated"])
        self.assertTrue(sample["within_target"])
        result = self.command("complete_injection")
        self.assertTrue(result["checklist"]["initial_angle"])
        self.assertEqual(result["initial_angle"]["model_id"], "test-model")
        self.assertEqual(result["input_source"], "esp32")

    def test_direct_mode_uses_camera_for_intervention_and_keeps_rfid_flow(self):
        self.command("set_angle_source", angle_source="camera")
        self.command("select_mode", mode="direct")
        self.command("start_scenario")
        self.command("scenario_visible", scenario_id="hypotension")
        state = self.command("simulate_rfid", scan_kind="correct")
        self.assertEqual(state["phase"], "intervention_injection")
        self.predict()
        result = self.command("complete_injection")
        self.assertEqual(result["phase"], "evaluated")
        self.assertTrue(result["checklist"]["intervention_angle"])
        self.assertEqual(result["intervention_angle"]["source"], "camera")

    def test_open_ended_classes_are_not_fabricated_degree_values(self):
        for label in ("Below 15 degrees", "Above 30 degrees"):
            self.setUp()
            self.begin()
            sample = self.predict(label)
            self.assertIsNone(sample["angle_deg"])
            self.assertFalse(sample["within_target"])
            result = self.command("complete_injection")
            self.assertFalse(result["checklist"]["initial_angle"])
            self.assertTrue(result["checklist"]["initial_injection"])

    def test_no_detection_and_stale_reading_cannot_complete(self):
        self.begin()
        self.predict()
        self.now += 1.6
        with self.assertRaises(AssessmentError):
            self.command("complete_injection")
        self.predict(detected=False, detail="No syringe.")
        with self.assertRaises(AssessmentError):
            self.command("complete_injection")

    def test_wrong_stage_and_sensor_simulation_cannot_replace_camera(self):
        self.begin()
        with self.assertRaises(AssessmentError):
            self.command("simulate_angle", angle_deg=22)
        state = self.service.snapshot()
        with self.assertRaises(AssessmentError):
            self.service.camera_angle({"detected": False}, state["session_id"], "old-stage")
        with self.assertRaises(AssessmentError):
            self.command("set_angle_source", angle_source="hardware")
        self.predict()
        self.service._record_angle({"angle_deg": 80, "calibrated": True, "calibration_id": "SENSOR"}, "esp32")
        self.assertEqual(self.service.snapshot()["angle"]["angle_deg"], 22)
        state = self.command("end")
        self.assertEqual(state["angle_source"], "camera")
        self.assertIsNone(state["angle"])

    def test_unknown_model_classes_and_missing_models_fail_clearly(self):
        for label in ("person", "syringe", "90 degrees"):
            with self.assertRaises(ValueError):
                angle_class(label)
        with self.assertRaisesRegex(ValueError, "missing"):
            CameraAngleDetector("missing-test-model.pt").load()

    def test_inference_rejects_ambiguity_and_low_confidence(self):
        detector = CameraAngleDetector()
        detector.model = Mock()
        detector.model_id = "test-model"
        jpeg = cv2.imencode('.jpg', np.zeros((100, 100, 3), np.uint8))[1].tobytes()
        for count, confidence, detected in ((0, .9, False), (2, .9, False), (1, .2, False), (1, .9, True)):
            result = Mock()
            boxes_type = type('Boxes', (SimpleNamespace,), {'__len__': lambda obj: count})
            result.boxes = boxes_type(conf=[confidence], cls=[7])
            result.names = {7: "22 degrees"}
            detector.model.predict.return_value = [result]
            self.assertEqual(detector.process(jpeg)["detected"], detected)


if __name__ == "__main__":
    unittest.main()
