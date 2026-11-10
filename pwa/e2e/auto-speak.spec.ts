import { expect, test } from '@playwright/test';
import { shouldAutoSpeak } from '../lib/auto-speak';

test('plain replies auto-speak', () => {
  expect(shouldAutoSpeak({ text: 'done' })).toBe(true);
  expect(shouldAutoSpeak({ text: 'done', autoReply: false })).toBe(true);
});

test('auto-verdict replies stay quiet', () => {
  expect(shouldAutoSpeak({ text: 'verdict: green', autoReply: true })).toBe(false);
});

test('OWNER-ACTION escalations keep their voice', () => {
  expect(shouldAutoSpeak({ text: 'OWNER-ACTION: approve merge', autoReply: true })).toBe(true);
});
