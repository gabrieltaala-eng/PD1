import { useEffect, useState } from 'react';
import { getPatientById } from '../data/patients';
import { assessmentChecklist, modeNames, scenarioName, formatSeconds } from '../lib/assessmentView';
import { formatDuration } from './SimulationControls';

function angleSummary(sample) {
  if (sample?.method === 'yolo_angle_class_estimate') return `${sample.label} · camera estimate · ${sample.within_target ? 'target met' : 'outside target'}`;
  return sample ? `${Number(sample.angle_deg).toFixed(1)}° smoothed / ${Number(sample.raw_angle_deg ?? sample.angle_deg).toFixed(1)}° raw · ${sample.within_target ? 'target met' : 'outside target'}` : 'Not recorded';
}

function Report({ state, title }) {
  const tasks = assessmentChecklist(state);
  const policy = state.intervention_policy;
  const interventionLabel = !policy ? 'Legacy assessment · not collected' : policy.requires_expert_review ? 'Blocked pending injectable-route approval' : !policy.requires_injection ? 'Not required · non-injectable route' : angleSummary(state.intervention_angle);
  return <div className="assessment-feedback"><h3>{title}</h3><span className="badge">{modeNames[state.mode]}</span><dl className="detail-list">
    <div><dt>Complication</dt><dd>{scenarioName(state)}</dd></div>
    <div><dt>Drug selection</dt><dd>{state.checklist.drug ? 'Verified against placeholder mapping' : 'Not verified'}</dd></div>
    <div><dt>First RFID response</dt><dd>{formatSeconds(state.first_response_seconds)}</dd></div>
    <div><dt>Intervention completed after scenario onset</dt><dd>{formatSeconds(state.intervention_completion_seconds)}</dd></div>
    <div><dt>Intervention stage duration</dt><dd>{formatSeconds(state.intervention_duration_seconds)}</dd></div>
    <div><dt>Initial anesthesia angle</dt><dd>{state.mode === 'full' ? angleSummary(state.initial_angle || state.injection_angle) : 'Skipped · Option 2'}</dd></div>
    <div><dt>Initial injection confirmed</dt><dd>{state.mode === 'full' ? state.checklist.initial_injection || state.checklist.injection ? 'Yes' : 'No' : 'Not required'}</dd></div>
    <div><dt>Intervention angle</dt><dd>{interventionLabel}</dd></div>
    <div><dt>Intervention completion confirmed</dt><dd>{state.checklist.intervention_completion ? 'Yes' : 'No'}</dd></div>
    {state.angle_records && <div><dt>Angle samples · initial / intervention</dt><dd>{state.angle_records.initial.total_samples} / {state.angle_records.intervention.total_samples}</dd></div>}
    <div><dt>Placeholder score</dt><dd>{state.score.value} / 100 {state.score.final ? '(final)' : '(provisional)'}</dd></div>
    <div><dt>Incorrect / unknown attempts</dt><dd>{state.score.incorrect_attempts}</dd></div>
    <div><dt>Input source</dt><dd>{state.input_source}</dd></div>
  </dl>
    <h4>RFID intervention attempts</h4>{state.attempts.length ? <ol className="attempt-list">{state.attempts.map(attempt => <li key={attempt.event_id}><strong>#{attempt.number} · {attempt.drug?.name || 'Unregistered tag'} · {attempt.result}</strong><span>{attempt.uid} · {formatSeconds(attempt.response_seconds)} · {attempt.source}</span></li>)}</ol> : <p className="notice">No intervention attempts recorded.</p>}
    <h4>Action feedback</h4><ol className="event-list">{state.events.map((event,index) => <li key={index}><time>{formatDuration(event.elapsed)}</time><span>{event.text}</span></li>)}</ol>
    <h4>Remaining / unmet criteria</h4><ul className="pending-list">{tasks.filter(task => !task.done).map(task => <li key={task.id}>{task.label}</li>)}</ul>{tasks.every(task => task.done) && <p className="notice">All listed workflow criteria were recorded.</p>}
    {state.note && <p className="notice">Recorded intervention note: {state.note}</p>}
    <p className="notice">Prototype scoring. RFID verifies the drug; confirm intervention completion separately.</p>
  </div>;
}

export default function AssessmentPanel({ state, command, disabled }) {
  const completed = ['evaluated', 'ended', 'interrupted'].includes(state?.phase);
  const [tab, setTab] = useState(completed || (state?.last_report && !state.mode) ? 'feedback' : 'checklist');
  const [recognition, setRecognition] = useState('');
  const [note, setNote] = useState(state?.note || '');
  useEffect(() => { if (completed) setTab('feedback'); }, [completed]);
  if (!state) return <p className="notice">Waiting for the backend.</p>;
  const tasks = assessmentChecklist(state);
  const previous = state.last_report;
  const postAvailable = completed || Boolean(previous);
  return <><div className="assessment-tabs" role="group" aria-label="Assessment view"><button className={tab === 'checklist' ? 'selected' : ''} aria-pressed={tab === 'checklist'} onClick={() => setTab('checklist')}>Checklist</button><button className={tab === 'feedback' ? 'selected' : ''} aria-pressed={tab === 'feedback'} disabled={!postAvailable} onClick={() => setTab('feedback')}>Post Feedback</button></div>
    {!postAvailable && <p className="notice">Post feedback is available after completing or ending the assessment.</p>}
    {tab === 'checklist' ? <>
      {!state.mode ? <p className="notice">Choose a mode to start the checklist.</p> : <>
        {state.phase === 'scenario_active' && !state.checklist.recognition && <section className="recognition-step" aria-labelledby="recognition-heading"><h3 id="recognition-heading">Identify the complication</h3><p className="notice">Review the heart rate, respiratory rate, blood pressure, and EtCO₂ in Vitals. Choose the complication that matches the readings.</p><label className="field">Observed complication<select value={recognition} disabled={disabled} onChange={e => setRecognition(e.target.value)}><option value="">Select the complication</option>{Object.entries(state.catalog.scenarios).map(([id,scenario]) => <option key={id} value={id}>{scenario.name}</option>)}</select></label><button className="primary" disabled={disabled || !recognition} onClick={() => command('recognize', { scenario_id: recognition })}>Submit answer</button></section>}
        <h3 className="assessment-title">Student {state.student} · remaining tasks</h3><ul className="task-list">{tasks.map(task => <li className={task.done ? 'done' : ''} key={task.id}><span className="task-symbol" aria-hidden="true">{task.done ? '✓' : '○'}</span><span>{task.label}<small>{task.done ? 'Recorded' : 'To do / unmet'}</small></span></li>)}</ul><p className="notice">{state.mode === 'direct' ? 'Initial injection skipped. Intervention assessment required.' : 'Initial and intervention angles are recorded separately.'}</p>
        <div className="connection-card"><div><strong>Intervention is selected by RFID</strong><small>Scan the drug tag, check the intervention angle, then confirm completion.</small></div></div>
        <label className="field intervention-field">Intervention note<textarea rows="3" maxLength={2000} value={note} onChange={e => setNote(e.target.value)} disabled={disabled} placeholder="Describe what you did and why…"/></label><button className="secondary" disabled={disabled || !note.trim()} onClick={() => command('note', { text: note })}>Record note</button>
      </>}
    </> : <>
      {state.mode && completed && <Report state={state} title={`Student ${state.student} · ${getPatientById(state.patient_id)?.Name || 'Assigned patient'}`}/>}
      {previous && <details className="completed-report" open={!state.mode}><summary>Previous student · saved result</summary><Report state={previous} title={`Student ${previous.student} · ${getPatientById(previous.patient_id)?.Name || previous.patient_id}`}/></details>}
      {!state.mode && !previous && <p className="notice">No saved assessment yet. Choose an option to begin.</p>}
      <a className="text-button" href="/api/assessment/results" target="_blank" rel="noreferrer">Open saved assessment records (JSON)</a>
    </>}
  </>;
}
