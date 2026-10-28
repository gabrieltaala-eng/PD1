"""Single training-station state machine. All drug mappings and scores are placeholders."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import random
from threading import RLock
from time import monotonic
from uuid import uuid4
from angles import AnglePipeline


class AssessmentError(Exception):
    pass


def utc_now():
    return datetime.now(timezone.utc).isoformat()


class AssessmentService:
    def __init__(self, store=None, config=None, clock=monotonic):
        self.config = deepcopy(config) if config else json.loads((Path(__file__).parent / "config/assessment.json").read_text())
        self._validate_config()
        self.store, self.clock, self.lock = store, clock, RLock()
        self.instance_id = str(uuid4())
        self.revision = 0
        self._seen = {}
        self._last_reads = {}
        self._angles = AnglePipeline(self.config, self.clock)
        self._seen_angles = {}
        self._hardware = {source: {"esp32_connected": source == "simulation", "mpu_connected": source == "simulation", "rfid_connected": source == "simulation", "last_seen": None, "error": None} for source in ("simulation", "esp32")}
        if store:
            store.interrupt_active()
        reports = store.results() if store else []
        self.last_report = reports[0] if reports else None
        student = max((report["student"] for report in reports), default=0) + 1
        self.state = self._new_state(student, self.last_report.get("patient_id") if self.last_report else None)
        self._started = self._injection_started = self._scenario_started = self._intervention_started = None

    def _validate_config(self):
        c = self.config
        if not 0 <= c["angle_min_deg"] <= c["angle_max_deg"] <= 90 or c["hardware_timeout_seconds"] <= 0 or c["rfid_debounce_seconds"] < 0:
            raise ValueError("Invalid angle, freshness, or debounce configuration")
        if set(c["scenarios"]) != {"hypotension", "hypoventilation", "bradycardia"} or len(set(c["patient_ids"])) < 2:
            raise ValueError("Exactly three scenarios and at least two patients are required")
        if c["incorrect_attempt_penalty"] < 0:
            raise ValueError("Attempt penalty cannot be negative")
        if not 0 < c["angle_smoothing_alpha"] <= 1:
            raise ValueError("Angle smoothing alpha must be greater than 0 and at most 1")
        ranges = c.get("baseline_vital_ranges", {})
        if not isinstance(ranges, dict) or set(ranges) != {"hr", "rr", "temp", "etco2"}:
            raise ValueError("Configure resting baseline ranges for HR, RR, temperature, and EtCO2")
        for key, limits in ranges.items():
            precision = 1 if key == "temp" else 0
            if not isinstance(limits, dict) or set(limits) != {"min", "max"}:
                raise ValueError(f"Invalid baseline range for {key}")
            bounds = (limits["min"], limits["max"])
            if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or round(value, precision) != value for value in bounds) or not 0 < bounds[0] <= bounds[1]:
                raise ValueError(f"Baseline range for {key} must be finite, positive, ordered, and match monitor precision")
        for scenario in c["scenarios"].values():
            if scenario["intervention_route"] not in ("injection", "non_injectable") or not isinstance(scenario["injectable_expert_approved"], bool):
                raise ValueError("Configure the intervention route and explicit injectable approval")
        shared = {"recognition", "drug", "intervention_angle", "intervention_completion"}
        for mode, keys in (("full", shared | {"initial_angle", "initial_injection"}), ("direct", shared)):
            weights = c["weights"][mode]
            if set(weights) != keys or any(v < 0 for v in weights.values()) or sum(weights.values()) <= 0:
                raise ValueError("Invalid mode scoring weights")
        ids = {drug["id"] for drug in c["rfid_registry"].values()}
        if any(s["expected_drug"] not in ids for s in c["scenarios"].values()):
            raise ValueError("Every expected drug must have an explicitly registered UID")

    def _new_state(self, student, exclude=None, input_source="simulation"):
        return {"session_id": None, "student": student, "patient_id": random.choice([p for p in self.config["patient_ids"] if p != exclude]), "mode": None, "phase": "mode_selection", "planned_scenario": "hypotension", "scenario_id": None, "scenario_started_at": None, "input_source": input_source, "checklist": {key: False for key in ("patient", "angle", "injection", "initial_angle", "initial_injection", "recognition", "drug", "intervention_angle", "intervention_completion")}, "injection_stage_id": None, "initial_angle": None, "injection_angle": None, "intervention_angle": None, "intervention_injection_completed": False, "intervention_completed_at": None, "intervention_completion_seconds": None, "intervention_duration_seconds": None, "angle_records": {"initial": {"samples": [], "total_samples": 0, "within_target_samples": 0}, "intervention": {"samples": [], "total_samples": 0, "within_target_samples": 0}}, "attempts": [], "rfid_events": [], "events": [], "first_response_seconds": None, "last_tag": None, "notification": None, "updated_at": utc_now(), "ended_at": None, "note": ""}

    def _set_input_source(self, source):
        if source not in ("simulation", "esp32"):
            raise AssessmentError("Choose simulation or esp32 as the hardware input source.")
        self.state["input_source"] = source
        self._angles.reset()
        self._log(f"Selected hardware input source: {source}.")

    def _log(self, text):
        self.state["events"].append({"at": utc_now(), "elapsed": round(self.clock() - self._started, 3) if self._started is not None else 0, "text": text})

    def _notice(self, kind, message, drug=None):
        self.state["notification"] = {"id": str(uuid4()), "kind": kind, "message": message, "drug": drug, "scenario_id": self.state["scenario_id"]}

    def _save(self):
        self.revision += 1
        self.state["updated_at"] = utc_now()
        if self.store:
            self.store.save(self._snapshot(False))

    def _hardware_state(self, source):
        hw = deepcopy(self._hardware[source])
        age = None if hw["last_seen"] is None else max(0, self.clock() - hw["last_seen"])
        fresh = source == "simulation" or (age is not None and age < self.config["hardware_timeout_seconds"])
        hw.pop("last_seen")
        for name in ("esp32_connected", "mpu_connected", "rfid_connected"):
            hw[name] = bool(hw[name] and fresh and (name == "esp32_connected" or hw["esp32_connected"]))
        hw.update({"source": source, "fresh": fresh, "age_seconds": age})
        return hw

    def _angle_state(self):
        source = self._angle_source()
        connected = True if source == "camera" else self._hardware_state(source)["mpu_connected"]
        return self._angles.snapshot(source, self.state["injection_stage_id"], connected)

    def _angle_source(self):
        return "camera" if self.state.get("angle_source") == "camera" else self.state["input_source"]

    def camera_angle(self, prediction, session_id, stage_id):
        """Only called with server-produced predictions; never client angle values."""
        with self.lock:
            if self._angle_source() != "camera" or not session_id or session_id != self.state["session_id"] or not stage_id or stage_id != self.state["injection_stage_id"]:
                raise AssessmentError("Camera frame belongs to an inactive angle source or injection stage.")
            self._angles.ingest_camera(prediction, stage_id)
            self._record_current_angle("camera")
            self._save()
            return self._angle_state()

    def _intervention_policy(self):
        scenario = self.config["scenarios"][self.state["scenario_id"] or self.state["planned_scenario"]]
        injectable = scenario["intervention_route"] == "injection"
        simulated = self.state["input_source"] == "simulation"
        approved = scenario["injectable_expert_approved"]
        return {"route": scenario["intervention_route"], "requires_injection": injectable and (simulated or approved), "requires_expert_review": injectable and not simulated and not approved, "demo_only": injectable and simulated and not approved, "injectable_expert_approved": approved}

    def _start_injection_stage(self, stage):
        self.state["phase"] = "injection" if stage == "initial" else "intervention_injection"
        self.state["injection_stage_id"] = str(uuid4())
        self._injection_started = self.clock()
        self._angles.reset()
        if stage == "intervention":
            self._intervention_started = self.clock()
        self._log(f"Began {stage} injection angle recording; a new stage-specific sample is required.")

    def _confirm_injection(self, data):
        stage = "initial" if self.state["phase"] == "injection" and self.state["mode"] == "full" else "intervention" if self.state["phase"] == "intervention_injection" and self.state["checklist"]["drug"] else None
        if not stage or data.get("injection_stage_id") != self.state["injection_stage_id"]:
            raise AssessmentError("Complete Injection must target the currently unlocked injection stage.")
        angle = self._angle_state()
        camera_estimate = bool(angle and angle["source"] == "camera" and angle.get("detected") and angle.get("method") == "yolo_angle_class_estimate")
        if not angle or not angle["fresh"] or (not camera_estimate and (not angle["calibrated"] or not angle["calibration_id"] or angle["angle_deg"] is None)):
            raise AssessmentError("Record a fresh calibrated angle during this injection before confirming completion.")
        self.state[f"{stage}_angle"] = deepcopy(angle)
        self.state["checklist"][f"{stage}_angle"] = angle["within_target"]
        self._log(f"Confirmed {stage} injection: {angle.get('label') if camera_estimate else str(angle['angle_deg']) + ' degrees'}; target {'met' if angle['within_target'] else 'not met'} (prototype rule; {'camera class estimate' if camera_estimate else 'sensor reading'}).")
        self.state["injection_stage_id"] = None
        if stage == "initial":
            self.state["injection_angle"] = deepcopy(angle)
            self.state["checklist"].update({"angle": angle["within_target"], "injection": True, "initial_injection": True})
            self._queue_scenario()
        else:
            self.state["intervention_injection_completed"] = True
            self._complete_intervention()

    def _complete_intervention(self):
        self.state.update({"phase": "evaluated", "intervention_completed_at": utc_now(), "intervention_completion_seconds": round(self.clock()-self._scenario_started, 3), "intervention_duration_seconds": round(self.clock()-self._intervention_started, 3)})
        self.state["checklist"]["intervention_completion"] = True
        self._log("Intervention completion explicitly confirmed; final assessment is now available.")
        drug = next((attempt["drug"] for attempt in reversed(self.state["attempts"]) if attempt["result"] == "correct"), None)
        self._notice("completed", "Intervention completion recorded. Review both angle results, RFID attempts and timing.", deepcopy(drug))

    def _score(self):
        weights = deepcopy(self.config["weights"].get(self.state["mode"], {}))
        policy = self._intervention_policy()
        if not policy["requires_injection"]:
            weights.pop("intervention_angle", None)
        possible = sum(weights.values())
        earned = sum(weight for key, weight in weights.items() if self.state["checklist"][key])
        incorrect = sum(a["result"] in ("incorrect", "unregistered") for a in self.state["attempts"])
        value = max(0, min(100, 100 * earned / possible - incorrect * self.config["incorrect_attempt_penalty"])) if possible else 0
        return {"value": round(value, 1), "out_of": 100, "incorrect_attempts": incorrect, "weights": weights, "placeholder": True, "final": self.state["phase"] in ("evaluated", "ended")}

    def _vitals(self):
        index = self.config["patient_ids"].index(self.state["patient_id"])
        values = {"hr": 86 + index*2, "rr": 18 + index % 5, "spo2": 98, "map": 88 + index, "etco2": 37 + index % 3, "temp": 38.3 + (index % 3)*.1}
        targets = self.config["scenarios"][self.state["scenario_id"]]["target"] if self.state["scenario_id"] else {}
        values.update(targets)
        seconds = 0 if self._started is None else self.clock() - self._started
        if self.state["phase"] == "mode_selection":
            seconds = 0
        readings = {key: round(value + math.sin(seconds*.6+index) * (.06 if key == "temp" else .4), 1 if key == "temp" else 0) for key, value in values.items()}
        # Apply resting limits after rounding; scripted complications keep their targets.
        for key, limits in self.config["baseline_vital_ranges"].items():
            if key not in targets:
                readings[key] = max(limits["min"], min(limits["max"], readings[key]))
        return readings

    def _snapshot(self, include_report=True):
        result = deepcopy(self.state)
        result["angle_source"] = self.state.get("angle_source", "hardware")
        result.update({"intervention_policy": self._intervention_policy(), "injection_stage": "initial" if self.state["phase"] == "injection" else "intervention" if self.state["phase"] == "intervention_injection" else None, "instance_id": self.instance_id, "revision": self.revision, "elapsed": round(max(0, self.clock()-self._started), 3) if self._started is not None else 0, "scenario_elapsed": round(max(0, self.clock()-self._scenario_started), 3) if self._scenario_started is not None else None, "vitals": self._vitals(), "hardware": self._hardware_state(self.state["input_source"]), "angle": self._angle_state(), "score": self._score(), "catalog": {"scenarios": self.config["scenarios"], "drugs": [{"uid": uid, **drug} for uid, drug in self.config["rfid_registry"].items()], "angle_min_deg": self.config["angle_min_deg"], "angle_max_deg": self.config["angle_max_deg"]}})
        result["catalog"]["baseline_vital_ranges"] = deepcopy(self.config["baseline_vital_ranges"])
        if include_report:
            result["last_report"] = deepcopy(self.last_report)
        return result

    def snapshot(self):
        with self.lock:
            return self._snapshot()

    def command(self, data):
        with self.lock:
            action = data["action"]
            if action == "set_angle_source":
                if self.state["phase"] not in ("mode_selection", "preparation"):
                    raise AssessmentError("Change the angle source before starting the exercise.")
                if data.get("session_id") != self.state["session_id"]:
                    raise AssessmentError("This command belongs to an expired or missing assessment session.")
                if data.get("angle_source") not in ("hardware", "camera"):
                    raise AssessmentError("Choose hardware or camera for the angle input.")
                self.state["angle_source"] = data["angle_source"]
                self._angles.reset()
                self._log(f"Selected angle source: {data['angle_source']}.")
            elif action == "set_input_source":
                if self.state["phase"] not in ("mode_selection", "preparation"):
                    raise AssessmentError("Change the hardware input source before starting the exercise.")
                if data.get("session_id") != self.state["session_id"]:
                    raise AssessmentError("This command belongs to an expired or missing assessment session.")
                self._set_input_source(data.get("input_source"))
            elif action == "select_mode":
                if self.state["phase"] != "mode_selection" or data.get("mode") not in ("full", "direct"):
                    raise AssessmentError("End the current assessment before selecting another mode.")
                self.state.update({"mode": data["mode"], "session_id": str(uuid4()), "phase": "preparation"})
                self._started = self.clock()
                self._angles.reset()
                self._log(f"Selected assessment mode: {data['mode']}.")
            else:
                if not self.state["session_id"] or data.get("session_id") != self.state["session_id"]:
                    raise AssessmentError("This command belongs to an expired or missing assessment session.")
                if action == "configure":
                    if self.state["phase"] != "preparation":
                        raise AssessmentError("Select the scenario and hardware source before starting.")
                    if data.get("scenario_id"):
                        self.state["planned_scenario"] = data["scenario_id"]
                    if data.get("input_source"):
                        self._set_input_source(data["input_source"])
                elif action == "begin_injection":
                    self._require("full", "preparation")
                    self._start_injection_stage("initial")
                elif action == "complete_injection":
                    self._confirm_injection(data)
                elif action == "complete_non_injectable_intervention":
                    if self.state["phase"] != "intervention_non_injectable" or not self.state["checklist"]["drug"]:
                        raise AssessmentError("A non-injectable intervention must be verified before its completion.")
                    self._complete_intervention()
                elif action == "start_scenario":
                    self._require("direct", "preparation")
                    self._queue_scenario()
                elif action == "scenario_visible":
                    if self.state["phase"] != "scenario_pending":
                        return self._snapshot()
                    if data.get("scenario_id") != self.state["scenario_id"]:
                        raise AssessmentError("The displayed scenario does not match the pending scenario.")
                    self.state.update({"phase": "scenario_active", "scenario_started_at": utc_now()})
                    self._scenario_started = self.clock()
                    self._log("Browser acknowledged visible scenario; response timer started.")
                elif action == "review":
                    if self.state["phase"] == "evaluated":
                        raise AssessmentError("The response has already been evaluated.")
                    self.state["checklist"]["patient"] = True
                    self._log("Student confirmed reviewing the assigned patient.")
                elif action == "recognize":
                    if self.state["phase"] != "scenario_active":
                        raise AssessmentError("Recognition can be submitted only during the active scenario.")
                    correct = data.get("scenario_id") == self.state["scenario_id"]
                    self.state["checklist"]["recognition"] |= correct
                    self._log(f"Recognition attempt: {data.get('scenario_id')}; {'matched' if correct else 'did not match'} the scripted complication.")
                    self._notice("recognition", "Recognition matches the simulated scenario." if correct else "Recognition does not match the active simulated scenario.")
                elif action == "note":
                    if not (data.get("text") or "").strip():
                        raise AssessmentError("Enter an intervention note first.")
                    self.state["note"] = data["text"].strip()
                    self._log("Recorded intervention note: " + self.state["note"])
                elif action == "end":
                    self.state.update({"phase": "ended", "ended_at": utc_now()})
                    self._log("Assessment ended; prepared a different patient for the next student.")
                    self._save()
                    self.last_report = self._snapshot(False)
                    angle_source = self.state.get("angle_source", "hardware")
                    self.state = self._new_state(self.state["student"]+1, self.state["patient_id"], self.state["input_source"])
                    self.state["angle_source"] = angle_source
                    self._started = self._injection_started = self._scenario_started = self._intervention_started = None
                    self._last_reads = {}
                    self._hardware["simulation"].update({"esp32_connected": True, "mpu_connected": True, "rfid_connected": True, "error": None})
                    self._angles.reset()
                elif action.startswith("simulate_"):
                    if self.state["input_source"] != "simulation":
                        raise AssessmentError("Simulation buttons are disabled while ESP32 hardware is selected.")
                    self._simulate(data)
                else:
                    raise AssessmentError("Unsupported command.")
            self._save()
            return self._snapshot()

    def _require(self, mode, phase):
        if self.state["mode"] != mode or self.state["phase"] != phase:
            raise AssessmentError("That action is not part of the current assessment step.")

    def _queue_scenario(self):
        self.state["scenario_id"] = self.state["planned_scenario"]
        self.state["phase"] = "scenario_pending"
        self._log("Complication queued; waiting for the browser to display it.")

    def _simulate(self, data):
        action = data["action"]
        if action in ("simulate_disconnect", "simulate_reconnect"):
            connected = action == "simulate_reconnect"
            self._hardware["simulation"].update({"esp32_connected": connected, "mpu_connected": connected, "rfid_connected": connected})
            if not connected:
                self._angles.reset()
            self._log("Simulated sensors " + ("reconnected." if connected else "disconnected."))
        elif action == "simulate_angle":
            if self._angle_source() == "camera":
                raise AssessmentError("Simulation angle buttons are disabled while camera angle is selected.")
            if data.get("angle_deg") is None:
                raise AssessmentError("A simulated angle is required.")
            for _ in range(5):
                self._record_angle({"angle_deg": data["angle_deg"], "calibrated": True, "calibration_id": "SIMULATED_CALIBRATION"}, "simulation")
            self._log(f"Simulated angle input: five synthetic samples at {data['angle_deg']} degrees.")
        elif action == "simulate_rfid":
            uid = (data.get("uid") or "").strip().upper()
            kind = data.get("scan_kind")
            expected = self.config["scenarios"][self.state["scenario_id"] or self.state["planned_scenario"]]["expected_drug"]
            if kind in ("correct", "incorrect"):
                uid = next(uid for uid, drug in self.config["rfid_registry"].items() if (drug["id"] == expected) == (kind == "correct"))
            elif kind == "unregistered":
                uid = "UNREGISTERED_TAG"
            elif kind == "duplicate":
                if not self.state["rfid_events"]:
                    raise AssessmentError("Scan a tag before testing a duplicate event.")
                event = self.state["rfid_events"][-1]
                self._scan(event["uid"], "simulation", event["event_id"])
                return
            if not uid:
                raise AssessmentError("Enter an RFID UID.")
            self._scan(uid, "simulation", str(uuid4()))

    def _record_angle(self, data, source):
        self._angles.ingest(data, source, self.state["injection_stage_id"])
        self._record_current_angle(source)

    def _record_current_angle(self, source):
        sample = self._angle_state() if source == self._angle_source() else None
        stage = "initial" if self.state["phase"] == "injection" else "intervention" if self.state["phase"] == "intervention_injection" else None
        if sample and stage:
            record = self.state["angle_records"][stage]
            record["total_samples"] += 1
            record["within_target_samples"] += int(bool(sample["fresh"] and sample["within_target"]))
            record["samples"] = (record["samples"] + [{**deepcopy(sample), "recorded_at": utc_now()}])[-200:]

    def _scan(self, uid, source, event_id):
        uid = uid.strip().upper()
        key = (source, event_id)
        if key in self._seen:
            return {"duplicate": True}
        self._seen[key] = True
        if len(self._seen) > 2048:
            del self._seen[next(iter(self._seen))]
        last = self._last_reads.get((source, uid))
        if last is not None and self.clock()-last < self.config["rfid_debounce_seconds"]:
            return {"duplicate": True}
        self._last_reads[(source, uid)] = self.clock()
        self.state["last_tag"] = {"uid": uid, "source": source, "at": utc_now()}
        event = {"event_id": event_id, "uid": uid, "source": source, "at": utc_now()}
        hw = self._hardware_state(source)
        reason = "Different input source selected" if source != self.state["input_source"] else "RFID reader disconnected or heartbeat expired" if not hw["rfid_connected"] else "No active scenario" if self.state["phase"] != "scenario_active" else None
        if reason:
            self.state["rfid_events"].append({**event, "result": "ignored", "reason": reason})
            self._notice("ignored", reason + "; scan recorded without scoring.")
            self._log("RFID scan ignored: " + reason + ".")
            return {"ignored": True}
        drug = self.config["rfid_registry"].get(uid)
        correct = bool(drug and drug["id"] == self.config["scenarios"][self.state["scenario_id"]]["expected_drug"])
        result = "correct" if correct else "incorrect" if drug else "unregistered"
        response = round(max(0, self.clock()-self._scenario_started), 3)
        if self.state["first_response_seconds"] is None:
            self.state["first_response_seconds"] = response
        attempt = {**event, "number": len(self.state["attempts"])+1, "result": result, "drug": deepcopy(drug), "response_seconds": response, "scenario_id": self.state["scenario_id"]}
        self.state["attempts"].append(attempt)
        self.state["rfid_events"].append(attempt)
        self._log(f"RFID attempt {attempt['number']}: {drug['name'] if drug else uid}; {result}, {response} seconds.")
        if correct:
            self.state["checklist"]["drug"] = True
            self.state["drug_verified_at"] = utc_now()
            self._intervention_started = self.clock()
            policy = self._intervention_policy()
            if policy["requires_injection"]:
                self._start_injection_stage("intervention")
                message = "Drug verified. Record a new intervention angle and explicitly confirm injection completion."
            elif policy["requires_expert_review"]:
                self.state["phase"] = "intervention_review"
                message = "Drug verified for this placeholder exercise. Real intervention injection is disabled until an injectable route is approved by a veterinary expert."
            else:
                self.state["phase"] = "intervention_non_injectable"
                message = "Drug/intervention verified. This route does not require an injection or syringe angle. Confirm the non-injectable intervention separately."
            self._notice("drug_verified", message, deepcopy(drug))
        else:
            self._notice(result, "Incorrect placeholder drug. The active scenario and vital signs are unchanged." if drug else "Unregistered RFID UID. No drug was inferred; register this UID before hardware use.", deepcopy(drug))
        return {"result": result}

    def hardware_event(self, data):
        with self.lock:
            source = "esp32"
            kind = data["type"]
            hw = self._hardware[source]
            if kind == "status":
                if any(data.get(key) is None for key in ("esp32_connected", "mpu_connected", "rfid_connected")):
                    raise AssessmentError("A status heartbeat must include all three connection flags.")
                hw.update({key: data[key] for key in ("esp32_connected", "mpu_connected", "rfid_connected")})
                hw.update({"last_seen": self.clock(), "error": None})
            elif kind == "error":
                hw["error"] = data.get("message") or "Hardware sensor error"
                component = data.get("component")
                if component:
                    hw[{"esp32": "esp32_connected", "mpu": "mpu_connected", "rfid": "rfid_connected"}[component]] = False
                self._log("ESP32 hardware error: " + hw["error"])
                if self.state["input_source"] == "esp32":
                    self._notice("sensor_error", hw["error"])
            elif kind in ("angle", "rfid"):
                if data.get("session_id") != self.state["session_id"] or (kind == "angle" and not self.state["session_id"]):
                    raise AssessmentError("Hardware sample must target the current session_id.")
                if kind == "angle":
                    if data.get("injection_stage_id") != self.state["injection_stage_id"]:
                        raise AssessmentError("Angle sample belongs to a different injection stage; refresh injection_stage_id.")
                    key = (data["device_id"], data["event_id"])
                    if key in self._seen_angles:
                        return self._snapshot()
                    self._seen_angles[key] = True
                    if len(self._seen_angles) > 2048:
                        del self._seen_angles[next(iter(self._seen_angles))]
                    self._record_angle(data, source)
                else:
                    if not (data.get("uid") or "").strip():
                        raise AssessmentError("RFID events require a non-empty registered UID.")
                    self._scan(data["uid"], source, data["device_id"] + ":" + data["event_id"])
            self._save()
            return self._snapshot()
