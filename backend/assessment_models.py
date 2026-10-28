from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictBool


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class AssessmentCommand(StrictModel):
    action: Literal["select_mode", "set_input_source", "set_angle_source", "configure", "begin_injection", "complete_injection", "complete_non_injectable_intervention", "start_scenario", "scenario_visible", "review", "recognize", "note", "end", "simulate_angle", "simulate_rfid", "simulate_disconnect", "simulate_reconnect"]
    session_id: str | None = Field(default=None, max_length=64)
    injection_stage_id: str | None = Field(default=None, max_length=64)
    mode: Literal["full", "direct"] | None = None
    scenario_id: Literal["hypotension", "hypoventilation", "bradycardia"] | None = None
    input_source: Literal["simulation", "esp32"] | None = None
    angle_source: Literal["hardware", "camera"] | None = None
    angle_deg: float | None = Field(default=None, ge=0, le=90, strict=True)
    uid: str | None = Field(default=None, min_length=1, max_length=128)
    scan_kind: Literal["correct", "incorrect", "unregistered", "duplicate"] | None = None
    text: str | None = Field(default=None, max_length=2000)


class HardwareEvent(StrictModel):
    type: Literal["status", "angle", "rfid", "error"]
    event_id: str = Field(min_length=1, max_length=100)
    device_id: str = Field(min_length=1, max_length=100)
    session_id: str | None = Field(default=None, max_length=64)
    injection_stage_id: str | None = Field(default=None, max_length=64)
    # Real hardware must identify itself explicitly. UI simulation uses a separate route.
    source: Literal["esp32"] = "esp32"
    esp32_connected: StrictBool | None = None
    mpu_connected: StrictBool | None = None
    rfid_connected: StrictBool | None = None
    angle_deg: float | None = Field(default=None, ge=0, le=90, strict=True)
    calibrated: StrictBool = False
    calibration_id: str | None = Field(default=None, min_length=1, max_length=100)
    syringe_quaternion: tuple[float, float, float, float] | None = None
    dummy_quaternion: tuple[float, float, float, float] | None = None
    uid: str | None = Field(default=None, min_length=1, max_length=128)
    message: str | None = Field(default=None, max_length=500)
    component: Literal["esp32", "mpu", "rfid"] | None = None


class WireSignal(StrictModel):
    connected: StrictBool
