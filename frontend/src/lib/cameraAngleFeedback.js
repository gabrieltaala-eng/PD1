export function cameraAngleFeedback(angle, minimum, maximum) {
  if (!angle.detected || typeof angle.confidence !== 'number' || angle.confidence < .65 ||
      !Number.isFinite(angle.lower_deg) || !Number.isFinite(angle.upper_deg)) {
    return { status: 'waiting', title: 'Waiting for syringe detection', message: angle.error || 'Show exactly one syringe clearly.', value: null };
  }
  const status = angle.upper_deg <= minimum && angle.lower_deg < minimum ? 'low'
    : angle.lower_deg >= maximum && angle.upper_deg > maximum ? 'high'
      : angle.within_target === true ? 'valid' : 'outside';
  const title = status === 'valid' ? 'Estimated angle within accepted range'
    : status === 'low' || status === 'high' ? `Estimated angle too ${status}` : 'Estimated angle outside target';
  return { status, title, value: angle.angle_deg,
    message: `${angle.label} (${Math.round(angle.confidence * 100)}% confidence). Target ${minimum}°–${maximum}°. Camera class estimate; not a calibrated 3D angle.` };
}
