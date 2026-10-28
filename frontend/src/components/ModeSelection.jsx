import { ClipboardCheck, Syringe, ArrowUpRight } from 'lucide-react';
import HardwareSourceSelect from './HardwareSourceSelect';

export default function ModeSelection({ state, connected, busy, onSelect, onInputSourceChange, onAngleSourceChange, onRetry, withPanel }) {
  return <section className={`mode-selection ${withPanel ? 'with-panel' : ''}`} aria-label="Choose assessment mode">
    <span className="eyebrow">VETERINARY ANESTHESIA · TRAINING STATION</span><h1>Choose your assessment.</h1><p>One patient. One complication. A recorded student response.</p>
    {state && <div className="mode-input-source"><HardwareSourceSelect state={state} disabled={!connected || busy} disabledReason={busy ? 'Wait for the current action to finish.' : 'Connect the backend to choose a hardware input source.'} onChange={onInputSourceChange} onAngleSourceChange={onAngleSourceChange}/></div>}
    <div className="mode-cards">
      <button disabled={!connected || busy} onClick={() => onSelect('full')}><span className="mode-icon"><Syringe size={26}/></span><small>OPTION 1</small><h2>Full procedure<br/>+ scenario</h2><p>Initial injection, then complication and intervention.</p><span className="mode-action">Begin full assessment <ArrowUpRight size={17}/></span></button>
      <button disabled={!connected || busy} onClick={() => onSelect('direct')}><span className="mode-icon"><ClipboardCheck size={26}/></span><small>OPTION 2</small><h2>Direct scenario<br/>assessment</h2><p>Start with a complication, then complete the intervention.</p><span className="mode-action">Begin scenario assessment <ArrowUpRight size={17}/></span></button>
    </div>
    {!connected && <div className="backend-required" role="status"><strong>Backend offline</strong><p>Start the backend to continue.</p><details><summary>Connection help</summary><p>Run this command from the backend folder:</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}> .\.venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000</pre></details><button className="secondary" onClick={onRetry}>Retry connection</button></div>}
  </section>;
}
