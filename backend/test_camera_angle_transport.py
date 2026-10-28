"""Exercise browser JPEG -> local inference -> current assessment without a webcam."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


class CameraTransportTests(unittest.TestCase):
    def test_socket_prediction_disconnect_and_invalid_stage(self):
        # Run in a private process and temporary database; importing main must
        # never interrupt or overwrite the operator's assessment database.
        code = r'''
import os, tempfile, json
from pathlib import Path
from fastapi.testclient import TestClient
from unittest.mock import Mock
with tempfile.TemporaryDirectory() as directory:
    os.environ['ASSESSMENT_DB_PATH'] = str(Path(directory) / 'camera.sqlite3')
    import main
    from camera_angle import angle_class
    detector = Mock()
    detector.process.return_value = {'detected': True, 'label': '22 degrees', 'confidence': .9, 'model_id': 'fixture', **angle_class('22 degrees')}
    main.camera_detector = detector
    with TestClient(main.app) as client:
        def command(action, **fields):
            state = client.get('/api/assessment/state').json()
            response = client.post('/api/assessment/command', json={'action': action, 'session_id': state['session_id'], **fields})
            assert response.status_code == 200, response.text
            return response.json()
        command('set_angle_source', angle_source='camera')
        command('select_mode', mode='full')
        state = command('begin_injection')
        config = {'session_id': state['session_id'], 'injection_stage_id': state['injection_stage_id']}
        with client.websocket_connect('/api/ws/angle') as ws:
            ws.send_json(config)
            assert ws.receive_json()['type'] == 'ready'
            ws.send_bytes(b'fixture-jpeg')
            result = ws.receive_json()
            assert result['type'] == 'angle_result' and result['angle']['within_target']
            assert result['angle']['calibrated'] is False
            assert client.get('/api/assessment/state').json()['angle']['fresh']
        assert not client.get('/api/assessment/state').json()['angle']['fresh']
        with client.websocket_connect('/api/ws/angle') as ws:
            ws.send_json({**config, 'injection_stage_id': 'expired'})
            assert ws.receive_json()['type'] == 'error'
        assert detector.process.call_count == 1
'''
        result = subprocess.run([sys.executable, '-c', code], cwd=Path(__file__).parent,
                                capture_output=True, text=True, timeout=30,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
