import { useId } from 'react';

export default function HardwareSourceSelect({ state, onChange, onAngleSourceChange, disabled, disabledReason }) {
  const helpId = useId();
  if (!state) return <p className="notice">Waiting for the backend.</p>;
  const locked = !['mode_selection', 'preparation'].includes(state.phase);
  const message = locked ? 'The input source stays fixed during an exercise. End the assessment to change it for the next one.'
    : disabled ? disabledReason || 'Wait for the current action to finish and check the backend and camera connections.'
      : !state.mode ? 'Choose your input source now, or change it during assessment setup.'
        : 'You can change the input source until Begin Injection or Start Scenario.';
  return <div className="hardware-source-select">
    <label className="field">Hardware input source<select value={state.input_source} disabled={disabled || locked} aria-describedby={helpId} onChange={event => onChange(event.target.value)}><option value="simulation">SIMULATED · no ESP32 required</option><option value="esp32">REAL · ESP32 hardware</option></select></label>
    <p id={helpId} className="notice" role="status">{message}</p>
    {onAngleSourceChange && <label className="field">Syringe angle source<select value={state.angle_source || 'hardware'} disabled={disabled || locked} onChange={event => onAngleSourceChange(event.target.value)}><option value="hardware">{state.input_source === 'esp32' ? 'SENSOR · MPU6050' : 'SIMULATED · test angle'}</option><option value="camera">CAMERA · YOLO angle estimate</option></select></label>}
    {state.angle_source === 'camera' && <p className="notice">No syringe sensor needed. Keep the camera viewpoint consistent with training and show one syringe clearly. Predictions are angle-class estimates, not calibrated 3D measurements. RFID and other inputs still use the hardware source above.</p>}
  </div>;
}
