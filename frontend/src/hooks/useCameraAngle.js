import { useEffect, useState } from 'react';
import { captureTrackingFrame } from '../lib/tracking.js';

export function useCameraAngle({ videoRef, state, enabled, cameraKey }) {
  const [status, setStatus] = useState('Camera angle starts when an injection begins.');
  const [attempt, setAttempt] = useState(0);
  const selected = state?.angle_source === 'camera';
  const session = state?.session_id, stage = state?.injection_stage_id;
  useEffect(() => {
    if (!selected || !enabled || !session || !stage) {
      setStatus('Camera angle starts when an injection begins.');
      return;
    }
    let disposed = false, ready = false, busy = false, lastActivity = performance.now();
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/ws/angle`);
    setStatus('Loading syringe-angle camera model…');
    socket.onopen = () => socket.send(JSON.stringify({ session_id: session, injection_stage_id: stage }));
    socket.onmessage = event => {
      if (disposed) return;
      lastActivity = performance.now();
      try {
        const message = JSON.parse(event.data);
        busy = false;
        if (message.type === 'ready') { ready = true; setStatus('Show one syringe and the pad from the training viewpoint.'); }
        if (message.type === 'error') { ready = false; setStatus(message.message); }
        if (message.type === 'angle_result') setStatus(message.angle.error || `${message.angle.label} · ${Math.round(message.angle.confidence * 100)}% confidence · estimate`);
      } catch { ready = false; setStatus('Unreadable camera angle response. Retry camera angle.'); socket.close(); }
    };
    socket.onerror = () => { ready = false; setStatus('Camera angle connection failed. Check the backend and retry.'); };
    socket.onclose = () => { ready = false; if (!disposed) setStatus(current => `${current} Stream closed; retry camera angle.`); };
    const timer = setInterval(async () => {
      if (disposed) return;
      if (performance.now() - lastActivity > (ready ? 5000 : 60000)) { socket.close(); return; }
      if (!ready || busy || document.hidden || socket.readyState !== WebSocket.OPEN) return;
      busy = true;
      try {
        const frame = await captureTrackingFrame(videoRef.current);
        if (disposed || !frame || socket.readyState !== WebSocket.OPEN) { busy = false; return; }
        socket.send(frame.blob);
      } catch { busy = false; setStatus('Cannot capture a camera frame. Retry camera angle.'); socket.close(); }
    }, 200);
    const visibility = () => { if (document.hidden) socket.close(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; clearInterval(timer); socket.close(); document.removeEventListener('visibilitychange', visibility); };
  }, [videoRef, selected, enabled, session, stage, cameraKey, attempt]);
  return { status, retry: () => setAttempt(value => value + 1) };
}
