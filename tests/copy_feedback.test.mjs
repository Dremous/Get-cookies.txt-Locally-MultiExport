import assert from 'node:assert/strict';
import test from 'node:test';
import { createCopyFeedback } from '../src/modules/copy_feedback.mjs';

const makeButton = () => {
  const classes = new Set();
  return {
    classes,
    classList: {
      add: (className) => classes.add(className),
      remove: (className) => classes.delete(className),
    },
  };
};

const makeTimers = () => {
  let nextId = 0;
  const timers = new Map();
  return {
    timers,
    setTimer: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, {
        callback: () => {
          timers.delete(id);
          callback();
        },
        delay,
      });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  };
};

test('copy feedback replaces the previous timer instead of stacking', () => {
  const timers = makeTimers();
  const feedback = createCopyFeedback({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const button = makeButton();

  feedback.show(button);
  const firstTimer = [...timers.timers.values()][0];
  assert.ok(button.classes.has('copied'));
  assert.equal(firstTimer.delay, 2000);

  feedback.show(button);
  assert.equal(timers.timers.size, 1);
  assert.ok(button.classes.has('copied'));

  const [secondTimer] = [...timers.timers.values()];
  secondTimer.callback();
  assert.equal(timers.timers.size, 0);
  assert.equal(button.classes.has('copied'), false);
});

test('copy feedback moves the transient state between buttons', () => {
  const timers = makeTimers();
  const feedback = createCopyFeedback({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const first = makeButton();
  const second = makeButton();

  feedback.show(first);
  feedback.show(second);

  assert.equal(first.classes.has('copied'), false);
  assert.equal(second.classes.has('copied'), true);
  assert.equal(timers.timers.size, 1);

  const [timer] = [...timers.timers.values()];
  timer.callback();
  assert.equal(second.classes.has('copied'), false);
});

test('copy feedback ignores a missing button', () => {
  const timers = makeTimers();
  const feedback = createCopyFeedback({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  feedback.show(null);
  assert.equal(timers.timers.size, 0);
});
