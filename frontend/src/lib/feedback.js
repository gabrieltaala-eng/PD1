import { cameraAngleFeedback } from './cameraAngleFeedback.js';
const injectionPhases = new Set(['injection', 'intervention_injection']);
const activePhases = new Set([
  'preparation', 'injection', 'scenario_pending', 'scenario_active',
  'intervention_injection', 'intervention_non_injectable', 'intervention_review',
]);
const scoredResults = new Set(['incorrect', 'unregistered', 'correct']);
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value);
const nonemptyString = value => typeof value === 'string' && value.trim().length > 0;
const validAngle = value => finiteNumber(value) && value >= 0 && value <= 90;

export function getAngleFeedback(state) {
  if (!injectionPhases.has(state?.phase)) return null;
  const angle = state.angle;

  const waiting = (message, title = 'Waiting for calibrated reading') => ({ status: 'waiting', title, message, value: null });
  const minimum = state.catalog?.angle_min_deg;
  const maximum = state.catalog?.angle_max_deg;
  if (!validAngle(minimum) || !validAngle(maximum) || minimum > maximum) {
    return waiting('Waiting for a valid configured angle target.');
  }

  if (!angle) {
    return waiting('No angle received for this injection. Submit an angle reading to check the range.', 'Waiting for angle input');
  }
  if (!nonemptyString(state.injection_stage_id) || angle.injection_stage_id !== state.injection_stage_id) {
    return waiting('This reading belongs to another injection. Submit a new reading for the current injection.', 'Waiting for current injection reading');
  }
  if (angle.fresh !== true) {
    return waiting('The angle reading has expired or the sensor is disconnected. Reconnect and submit a fresh reading.', 'Angle reading unavailable');
  }
  if (state.angle_source === 'camera' && angle.source === 'camera' && angle.method === 'yolo_angle_class_estimate') {
    return cameraAngleFeedback(angle, minimum, maximum);
  }
  if (angle.calibrated !== true || !nonemptyString(angle.calibration_id)) {
    return waiting('Calibrate the syringe angle against the dummy surface and submit a new reading.', 'Angle calibration required');
  }
  if (!validAngle(angle.angle_deg) || !validAngle(angle.raw_angle_deg)) {
    return waiting('A valid angle reading from 0° to 90° is required before checking the range.', 'Invalid angle reading');
  }

  return classifyAngle(angle, minimum, maximum);
}

export function getAngleFeedbackPopup(state) {
  if (!state?.mode || !state.angle || !nonemptyString(state.session_id) || !nonemptyString(state.injection_stage_id)) return null;
  const feedback = getAngleFeedback(state);
  if (!feedback) return null;
  // Reading values change continuously. Only a change in result or injection
  // stage should open another popup after the student dismisses one.
  const key = JSON.stringify([state.session_id, state.injection_stage_id, feedback.status, feedback.title]);
  return { ...feedback, key };
}

function classifyAngle(angle, minimum, maximum) {
  const raw = angle.raw_angle_deg;
  const smoothed = angle.angle_deg;
  const target = `Target ${minimum}°–${maximum}°.`;
  const classify = value => value < minimum ? 'low' : value > maximum ? 'high' : 'valid';
  const rawStatus = classify(raw);
  // The backend requires both readings to pass. Prioritize a new excursion even
  // while smoothing still shows an earlier, acceptable reading.
  const status = rawStatus === 'valid' ? classify(smoothed) : rawStatus;
  const value = rawStatus === 'valid' ? smoothed : raw;
  if (status !== 'valid') {
    const title = `Angle too ${status}`;
    const reading = raw === smoothed ? `${value.toFixed(1)}°`
      : rawStatus !== 'valid' ? `${raw.toFixed(1)}° latest reading (smoothed ${smoothed.toFixed(1)}°)`
        : `${smoothed.toFixed(1)}° smoothed reading (latest reading ${raw.toFixed(1)}°)`;
    return { status, title, message: `${title}: ${reading}. ${target}`, value };
  }
  if (angle.within_target !== true) {
    return {
      status: 'outside', title: 'Outside prototype target',
      message: `Angle has not passed the prototype target check. ${target}`, value,
    };
  }
  return {
    status: 'valid', title: 'Angle within accepted range',
    message: `Angle within accepted range: ${smoothed.toFixed(1)}°. ${target}`, value,
  };
}

export function getDrugFeedback(state) {
  if (!['full', 'direct'].includes(state?.mode) || !activePhases.has(state?.phase)
    || !nonemptyString(state?.scenario_id) || state.checklist?.drug === true) return null;

  const attempts = Array.isArray(state.attempts) ? state.attempts : [];
  const attempt = attempts.findLast(item => item?.scenario_id === state.scenario_id && scoredResults.has(item.result));
  if (!attempt || attempt.result === 'correct') return null;

  const scenario = state.catalog?.scenarios?.[state.scenario_id]?.name || state.scenario_id;
  if (attempt.result === 'unregistered') {
    return {
      status: 'unknown', title: 'Unregistered RFID tag',
      message: `Unregistered RFID tag for ${scenario}. Scan a registered drug tag.`,
    };
  }
  if (!nonemptyString(attempt.drug?.name)) {
    return {
      status: 'unknown', title: 'Drug not identified',
      message: `Drug not identified for ${scenario}. Scan a registered drug tag.`,
    };
  }
  return {
    status: 'wrong', title: 'Wrong drug',
    message: `Wrong drug: ${attempt.drug.name.trim()} for ${scenario}.`,
  };
}
