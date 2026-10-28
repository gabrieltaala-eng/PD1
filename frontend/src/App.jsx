import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Camera, HeartPulse, PawPrint, Settings, ClipboardCheck, X, Maximize, Eye, ArrowUpRight, Radio, Activity } from 'lucide-react';
import { useCamera } from './hooks/useCamera';
import { useAssessment } from './hooks/useAssessment';
import { useMonitorSound } from './hooks/useMonitorSound';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useCameraAngle } from './hooks/useCameraAngle.js';
import { useTracking } from './hooks/useTracking.js';
import { patients } from './data/patients';
import { getVitalsState } from './lib/vitals';
import { phaseNames, scenarioName, formatSeconds } from './lib/assessmentView';
import { getNextStep } from './lib/navigation';
import VitalsControls from './components/VitalsControls';
import CameraSettings from './components/CameraSettings';
import SimulationControls from './components/SimulationControls';
import MonitorPanel from './components/MonitorPanel';
import AssessmentPanel from './components/AssessmentPanel';
import ModeSelection from './components/ModeSelection';
import ScenarioPanel from './components/ScenarioPanel';
import HardwarePanel from './components/HardwarePanel';
import InjectionAngle from './components/InjectionAngle';
import DuringFeedback from './components/DuringFeedback';
import TrackingSettings, { trackingStatusLabels } from './components/TrackingSettings.jsx';
import TrackingRegionSelector from './components/TrackingRegionSelector.jsx';
import TrackedOverlay from './components/TrackedOverlay.jsx';
import { captureTrackingFrame, defaultTrackingAlignment, normalizeTrackingMode, projectTracking, trackingModeKey } from './lib/tracking.js';

import DummyOverlay, { DummyOverlayControls } from './components/DummyOverlay';
import { createBreedPlacements } from './lib/dogPlacement.js';
import { getBreedProfile } from './data/breeds.js';

import { getDummyPose } from './lib/dummyOverlay';
const ModelViewer = lazy(() => import('./components/ModelViewer'));
const tabs = [['patient', PawPrint, 'Patient Info'], ['vitals', HeartPulse, 'Vitals'], ['scenario', Activity, 'Scenario'], ['assessment', ClipboardCheck, 'Assessment'], ['hardware', Radio, 'Hardware'], ['settings', Settings, 'Settings']];

function Toggle({ label, checked, onChange }) {
  return <label className="toggle-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}/><span className="switch" aria-hidden="true"/></label>;
}

export default function App() {
  const video = useRef(null), camera = useCamera(video), assessment = useAssessment();
  const state = assessment.state;
  const dockVitals = useMediaQuery('(min-width: 1180px)');
  const [panel, setPanel] = useState(''), [overlays, setOverlays] = useState(true);
  const [mirrored, setMirrored] = useState(false), [modelVisible, setModelVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [placements, setPlacements] = useState(createBreedPlacements), [previewDummy, setPreviewDummy] = useState(false);
  const [trackingMode, setTrackingMode] = useState(() => {
    try { return normalizeTrackingMode(localStorage.getItem(trackingModeKey)); } catch { return 'normal'; }
  });
  const [trackingAlignments, setTrackingAlignments] = useState({});
  const [regionFrame, setRegionFrame] = useState(null), [capturingRegion, setCapturingRegion] = useState(false);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const trackingContext = useRef(null);
  const dummyPose = getDummyPose(state);
  useEffect(() => { setPreviewDummy(false); }, [state?.session_id, state?.scenario_id]);
  const [triggerEnabled, setTriggerEnabled] = useState(false), [wireSource, setWireSource] = useState('simulation'), [simulatedConnected, setSimulatedConnected] = useState(false);
  const [now, setNow] = useState(Date.now), [dismissedNotice, setDismissedNotice] = useState(null);
  const patient = patients.find(item => item.id === state?.patient_id) || patients[0];
  const breed = getBreedProfile(patient.breedId);
  const placement = placements[breed.id];
  function setPlacement(next) {
    setPlacements(current => ({ ...current, [breed.id]: typeof next === 'function' ? next(current[breed.id]) : next }));
  }
  const menu = !state || state.phase === 'mode_selection';
  const cameraOn = camera.status === 'on';
  const trackingCameraKey = `${camera.activeDeviceId}:${camera.status}`;
  trackingContext.current = { mode: trackingMode, cameraKey: trackingCameraKey };
  const tracking = useTracking({ videoRef: video, mode: trackingMode,
    enabled: cameraOn && overlays && !regionFrame && !capturingRegion, cameraKey: trackingCameraKey });
  const cameraAngle = useCameraAngle({ videoRef: video, state, enabled: cameraOn && assessment.connected, cameraKey: trackingCameraKey });
  const alignmentKey = `${trackingMode}:${breed.id}`;
  const trackingAlignment = trackingAlignments[alignmentKey] || defaultTrackingAlignment(trackingMode);
  const targetProjection = tracking.fresh ? projectTracking(tracking.result, viewport, placement, trackingAlignment) : null;
  function setTrackingAlignment(value) { setTrackingAlignments(current => ({ ...current, [alignmentKey]: value })); }
  async function selectPadRegion() {
    const context = trackingContext.current;
    setCapturingRegion(true); tracking.clearSelection();
    try {
      const frame = await captureTrackingFrame(video.current);
      if (context.mode === trackingContext.current.mode && context.cameraKey === trackingContext.current.cameraKey && frame) setRegionFrame(frame);
    } catch (error) { camera.setError(error.message); }
    finally { setCapturingRegion(false); }
  }
  const disabled = assessment.busy || !assessment.connected || !cameraOn;
  const gate = getVitalsState({ triggerEnabled, source: wireSource, simulatedConnected, wire: state?.wire, now, receivedAt: assessment.receivedAt });
  const wireControls = { enabled: triggerEnabled, setEnabled: setTriggerEnabled, source: wireSource, setSource: setWireSource, connected: simulatedConnected, setConnected: setSimulatedConnected, message: gate.message };
  const monitorActive = Boolean(state?.mode && assessment.connected && cameraOn && gate.active);
  const pauseReason = !assessment.connected ? 'Backend disconnected · reconnect to resume vitals.' : !cameraOn ? 'Camera disconnected · reconnect to resume vitals.' : gate.message;
  const showDock = Boolean(dockVitals && state?.mode);
  const showPanel = Boolean(panel && !(panel === 'vitals' && showDock));
  const values = state?.vitals || { hr: 0, rr: 0, spo2: 0, map: 0, etco2: 0, temp: 0 };
  const sound = useMonitorSound(monitorActive, values.hr);
  const notice = state?.notification && state.notification.id !== dismissedNotice ? state.notification : null;

  useEffect(() => { try { localStorage.setItem(trackingModeKey, trackingMode); } catch {} }, [trackingMode]);
  useEffect(() => { setRegionFrame(null); }, [trackingMode, trackingCameraKey]);
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  async function act(action, fields) {
    if (!cameraOn) return null;
    const result = await assessment.command(action, fields);
    if (!result) return null;
    if (action === 'select_mode') { setPanel('patient'); setOverlays(true); }
    if (action === 'review' && result.phase === 'preparation') { setPanel('scenario'); setOverlays(true); }
    if (action === 'begin_injection') { setPanel('scenario'); setOverlays(true); }
    if (action === 'start_scenario' || action === 'complete_injection' || action === 'complete_non_injectable_intervention') { setPanel(result.phase === 'evaluated' ? 'assessment' : 'vitals'); setOverlays(true); }
    if (action === 'end') { setSimulatedConnected(false); setPanel('assessment'); setOverlays(true); }
    return result;
  }

  useEffect(() => {
    if (['injection', 'intervention_injection'].includes(state?.phase)) { setPanel('scenario'); setOverlays(true); }
  }, [state?.phase, state?.injection_stage_id]);

  useEffect(() => {
    if (state?.session_id) { setPanel(getNextStep(state)?.panel || 'vitals'); setOverlays(true); }
  }, [state?.session_id]);

  useEffect(() => { if (panel !== 'settings') { setPreviewDummy(false); setModelSettingsOpen(false); } }, [panel]);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  async function toggleFullscreen() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { camera.setError('Full-screen mode is unavailable in this browser window.'); }
  }
  function openPanel(id) {
    setOverlays(true);
    setPanel(id);
    requestAnimationFrame(() => document.getElementById(`workspace-heading-${id}`)?.focus({ preventScroll: true }));
  }

  return <main className={`app ${cameraOn ? 'is-live' : ''} ${menu ? 'menu-workspace' : ''}`}>
    <video ref={video} className={`camera-feed ${mirrored ? 'mirrored' : ''}`} playsInline muted autoPlay aria-label="Live real-world camera"/>
    {cameraOn && overlays && modelVisible && trackingMode === 'normal' && (dummyPose || previewDummy) && <Suspense fallback={null}><DummyOverlay key={state?.session_id || 'preview'} breedId={breed.id} placement={placement} pose={dummyPose || 'standing'}/></Suspense>}
    {cameraOn && overlays && trackingMode !== 'normal' && <TrackedOverlay projection={targetProjection} viewport={viewport}
      mode={trackingMode} mirrored={mirrored} modelVisible={modelVisible} breedId={breed.id} pose={dummyPose} sessionId={state?.session_id}/>}
    {regionFrame && <TrackingRegionSelector frame={regionFrame} videoRef={video} mode={trackingMode} mirrored={mirrored}
      onConfirm={frame => { tracking.selectRegion(frame); setRegionFrame(null); requestAnimationFrame(() => document.getElementById('tracking-select-region')?.focus()); }}
      onCancel={() => { setRegionFrame(null); requestAnimationFrame(() => document.getElementById('tracking-select-region')?.focus()); }}/>}
    <div className="workspace-shell" inert={cameraOn && !regionFrame ? undefined : ''}>
    <div className="edge-shade" aria-hidden="true"/>
    <header className="header"><a className="brand" href="#" onClick={e => { e.preventDefault(); openPanel('patient'); }} aria-label="Open patient information"><span className="brand-mark"><PawPrint size={24}/></span><span><strong>Pup<span className="mint-text">Vitals</span></strong><small>ANESTHESIA SIMULATION LAB</small></span></a><div className="session-label"><span className="tiny-label">TWO-MODE ASSESSMENT STATION</span><span>Canine procedure & intervention <ArrowUpRight size={13}/></span></div><div className="header-tools"><button className="icon-button" title="Toggle AR overlays" aria-label="Toggle AR overlays" aria-pressed={overlays} onClick={() => setOverlays(x => !x)}><Eye size={18}/></button><button className="icon-button" title="Toggle full screen" aria-label="Toggle full screen" onClick={toggleFullscreen}><Maximize size={18}/></button><div className={`status-pill ${cameraOn ? 'live' : ''}`} role="status"><span className="dot"/>{cameraOn ? 'LIVE CAMERA' : camera.status === 'starting' ? 'CONNECTING' : 'CAMERA REQUIRED'}</div></div></header>
    <nav className="navigation" aria-label="Workspace panels">{tabs.map(([id,Icon,label]) => <button key={id} className={`nav-item ${panel === id && overlays ? 'nav-active' : ''}`} onClick={() => openPanel(id)} aria-pressed={panel === id && overlays} aria-controls={`workspace-panel-${id}`}><Icon size={17} aria-hidden="true"/><span>{label}</span></button>)}</nav>
    <SimulationControls state={state} patient={patient} busy={assessment.busy} connected={assessment.connected && cameraOn} onAction={act} onNavigate={openPanel}/>
    {state?.scenario_id && <section className="active-scenario-banner" aria-label="Visible complication"><span><b>{scenarioName(state)}</b><small>{phaseNames[state.phase]} · SIMULATED</small></span><span>HR {monitorActive ? values.hr : '—'} · MAP {monitorActive ? values.map : '—'} · RR {monitorActive ? values.rr : '—'} · EtCO₂ {monitorActive ? values.etco2 : '—'}</span><span>{state.first_response_seconds == null ? state.scenario_elapsed == null ? 'Preparing response timer' : `Response timer ${formatSeconds(state.scenario_elapsed)}` : `First response ${formatSeconds(state.first_response_seconds)}`}</span></section>}
    <div className={`workspace-layout ${menu ? 'mode-layout' : ''} ${showPanel && overlays ? 'has-side-panel' : ''}`}>
    {menu && <ModeSelection state={state} connected={assessment.connected} busy={assessment.busy} onSelect={mode => act('select_mode', { mode })} onInputSourceChange={input_source => act('set_input_source', { input_source })} onAngleSourceChange={angle_source => act('set_angle_source', { angle_source })} onRetry={assessment.retryConnection} withPanel={Boolean(showPanel && overlays)}/>}
    {overlays && <>
      {showPanel && <section className="panel" id={`workspace-panel-${panel}`} aria-labelledby={`workspace-heading-${panel}`}><div className="panel-header"><h2 id={`workspace-heading-${panel}`} tabIndex={-1}>{tabs.find(t => t[0] === panel)?.[2]}</h2><button className="icon-button" aria-label="Collapse panel" onClick={() => setPanel('')}><X size={18}/></button></div>
        {menu && <button className="secondary mode-return" onClick={() => setPanel('')}>Choose mode</button>}
        {panel === 'patient' && (menu ? <p className="notice">Choose a mode to view the patient.</p> : <><div className="patient-heading"><span className="patient-avatar large"><PawPrint size={30}/></span><div><h3>Meet {patient.Name}</h3><p>Your fictional training patient</p></div></div><dl className="detail-list">{Object.entries(patient).filter(([key]) => !['id', 'breedId', 'Condition'].includes(key)).map(([name,value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl><button className="secondary full-width" disabled={disabled || state.checklist.patient || state.phase === 'evaluated'} onClick={() => act('review')}>{state.checklist.patient ? 'Patient review recorded' : 'Confirm patient reviewed'}</button></>)}
        {panel === 'vitals' && <MonitorPanel state={state} values={values} active={monitorActive} sound={sound} pauseReason={pauseReason} onControls={() => openPanel('hardware')}/>}
        {panel === 'scenario' && <>{state?.angle_source === 'camera' && <div className="notice" role="status">{cameraAngle.status}<button className="secondary" onClick={cameraAngle.retry}>Retry camera angle</button></div>}<InjectionAngle state={state}/><ScenarioPanel state={state} command={act} disabled={disabled}/></>}
        {panel === 'assessment' && <AssessmentPanel key={state?.session_id || `menu-${state?.student}`} state={state} command={act} disabled={disabled}/>}
        {panel === 'hardware' && <><HardwarePanel cameraAngle={cameraAngle} state={state} command={act} disabled={disabled} disabledReason={assessment.busy ? 'Wait for the current action to finish.' : pauseReason}/><h3 className="settings-subtitle">Monitor activation</h3><VitalsControls {...wireControls}/></>}
        {panel === 'settings' && <>
          <TrackingSettings mode={trackingMode} onModeChange={value => { tracking.clearSelection(); setTrackingMode(normalizeTrackingMode(value)); }} tracking={tracking}
            alignment={trackingAlignment} setAlignment={setTrackingAlignment} onSelectRegion={selectPadRegion} selecting={capturingRegion}/>
          <h3 className="settings-subtitle">Monitor sound</h3><button className="secondary full-width" aria-pressed={sound.enabled} onClick={sound.toggle}>{sound.enabled ? 'Mute heartbeat beep' : 'Enable heartbeat beep'}</button>
          {sound.error && <p className="notice" role="status">{sound.error}</p>}<CameraSettings camera={camera}/>
          <h3 className="settings-subtitle">Overlay controls</h3><Toggle label="Mirror camera" checked={mirrored} onChange={setMirrored}/><Toggle label="AR overlays" checked={overlays} onChange={setOverlays}/>
          <button className="secondary full-width" onClick={toggleFullscreen}><Maximize size={16}/>{fullscreen ? 'Exit full screen' : 'Enter full screen'}</button>
          <div className="connection-card"><Radio size={20}/><div><strong>{assessment.connected ? 'Backend online' : 'Backend offline'}</strong><small>Assessment and sensor connection</small></div></div>
          <details className="settings-section" onToggle={e => { setModelSettingsOpen(e.currentTarget.open); if (!e.currentTarget.open) setPreviewDummy(false); }}><summary>3D Patient</summary>{modelSettingsOpen && <>
            <DummyOverlayControls breedId={breed.id} placement={placement} setPlacement={setPlacement} preview={previewDummy} setPreview={setPreviewDummy} pose={dummyPose} tracked={trackingMode !== 'normal'}/>
            <Toggle label="3D model visibility" checked={modelVisible} onChange={setModelVisible}/>
            {modelVisible && <Suspense fallback={<p className="notice">Loading 3D viewer…</p>}><ModelViewer breedId={breed.id}/></Suspense>}
            <p className="notice">{trackingMode === 'normal' ? 'Built-in breed models use manual camera alignment.' : 'The camera dog follows the selected target while tracking is valid.'}</p>
          </>}</details>
        </>}
      </section>}
      {showDock && <aside className={`monitor-dock ${panel === 'vitals' ? 'monitor-focused' : ''}`} id="workspace-panel-vitals" aria-labelledby="workspace-heading-vitals"><div className="panel-header"><h2 id="workspace-heading-vitals" tabIndex={-1}>Vitals</h2><HeartPulse size={20} aria-hidden="true"/></div><MonitorPanel state={state} values={values} active={monitorActive} sound={sound} pauseReason={pauseReason} onControls={() => openPanel('hardware')}/></aside>}
    </>}
    </div>
    <DuringFeedback key={state?.session_id || 'menu'} state={state} notice={notice} enabled={cameraOn} onDismissNotice={() => setDismissedNotice(notice.id)} onContinueNotice={() => { setDismissedNotice(notice.id); setPanel(state.phase === 'intervention_injection' ? 'scenario' : state.phase === 'intervention_review' || state.phase === 'intervention_non_injectable' ? 'scenario' : 'assessment'); setOverlays(true); }}/>
    {(camera.error || assessment.error) && <div className="error" role="alert"><span>{[camera.error, assessment.error].filter(Boolean).join(' ')}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => { camera.setError(''); assessment.setError(''); }}><X size={18}/></button></div>}
    <footer><span><span className={`dot ${cameraOn ? 'live-dot' : ''}`}/>{cameraOn ? 'Camera connected' : 'Camera required'}</span><span className="tracking-footer" role="status">{trackingMode === 'normal' ? 'Normal · manual placement' : `${trackingMode === 'aruco' ? 'Design 1' : trackingMode === 'orb' ? 'Design 2' : 'Design 3'} · ${trackingStatusLabels[tracking.status] || 'Searching'}`}</span></footer>
    </div>
    {!cameraOn && <section className="camera-required-screen" role="dialog" aria-modal="true" aria-labelledby="camera-required-title"><div className="camera-required-card"><Camera size={32}/><h1 id="camera-required-title">{camera.status === 'starting' ? 'Connecting to your camera' : 'Camera required'}</h1><p>Allow camera access to continue.</p>{camera.error && <p className="notice" role="alert">{camera.error}</p>}<CameraSettings camera={camera}/>{state?.mode && <p className="notice">Reconnect to continue. Assessment timers are still running.</p>}</div></section>}
  </main>;
}
