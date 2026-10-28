import test from 'node:test';
import assert from 'node:assert/strict';
import { getAngleFeedback } from '../src/lib/feedback.js';

function state(label, lower, upper, value, within) {
  return { phase: 'injection', angle_source: 'camera', injection_stage_id: 'stage',
    catalog: { angle_min_deg: 15, angle_max_deg: 30 },
    angle: { source: 'camera', method: 'yolo_angle_class_estimate', injection_stage_id: 'stage',
      fresh: true, detected: true, calibrated: false, confidence: .9, label,
      lower_deg: lower, upper_deg: upper, angle_deg: value, within_target: within } };
}

test('camera feedback handles numerical and open-ended angle classes without inventing degrees', () => {
  assert.equal(getAngleFeedback(state('22 degrees', 22, 22, 22, true)).status, 'valid');
  for (const [label, lower, upper, status] of [['Below 15 degrees', 0, 15, 'low'], ['Above 30 degrees', 30, 90, 'high']]) {
    const feedback = getAngleFeedback(state(label, lower, upper, null, false));
    assert.equal(feedback.status, status);
    assert.equal(feedback.value, null);
    assert.match(feedback.message, /estimate/);
  }
});

test('camera estimates remain unavailable after loss, expiry or stage change', () => {
  for (const fields of [{ fresh: false }, { detected: false }, { confidence: .2 }, { injection_stage_id: 'old' }]) {
    const sample = state('22 degrees', 22, 22, 22, true);
    Object.assign(sample.angle, fields);
    assert.equal(getAngleFeedback(sample).status, 'waiting');
  }
});
