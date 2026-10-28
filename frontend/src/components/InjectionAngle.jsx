import { CircleAlert } from 'lucide-react';
import { getAngleFeedback } from '../lib/feedback';

export default function InjectionAngle({ state, floating = false }) {
  const feedback = getAngleFeedback(state);
  if (!feedback) return null;
  const angle = state.angle;
  const assessable = feedback.status !== 'waiting';
  const warning = ['low', 'high', 'outside'].includes(feedback.status);
  return <aside className={`injection-angle ${floating ? 'floating-angle' : ''} ${feedback.status === 'valid' ? 'angle-valid' : warning ? 'angle-warning' : ''}`} aria-label="Live syringe angle">
    <span className="eyebrow">{state.phase === 'injection' ? 'INITIAL ANESTHESIA INJECTION' : 'INTERVENTION INJECTION'}</span>
    <div className="angle-number">{assessable && feedback.value != null ? feedback.value.toFixed(1) : '—'}<small>°</small></div>
    <strong className="angle-feedback-title" role="status">{warning && <CircleAlert size={18} aria-hidden="true"/>}{feedback.title}</strong>
    <p className={warning ? 'angle-feedback-detail' : undefined}>{feedback.message}</p>
    <p>Target {state.catalog.angle_min_deg}°–{state.catalog.angle_max_deg}° · {state.angle_source === 'camera' ? 'CAMERA ESTIMATE' : state.input_source === 'simulation' ? 'SIMULATED' : 'ESP32'}</p>
    {state.angle_source === 'camera' ? <p>{angle?.label || 'Show one syringe'} · {angle?.confidence == null ? 'Waiting for prediction' : `${Math.round(angle.confidence * 100)}% confidence`}</p> : <p>Latest raw: {angle?.raw_angle_deg == null ? '—' : `${Number(angle.raw_angle_deg).toFixed(1)}°`} · Smoothed: {angle?.angle_deg == null ? '—' : `${Number(angle.angle_deg).toFixed(1)}°`}</p>}
    {angle?.error && <p role="status">{angle.error}</p>}
    {state.intervention_policy?.demo_only && state.phase === 'intervention_injection' && <span className="badge">SIMULATION EXERCISE · ROUTE NOT CLINICALLY APPROVED</span>}
    <p className="notice">Confirm completion after performing the injection.</p>
  </aside>;
}
