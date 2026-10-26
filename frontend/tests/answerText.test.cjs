// Plain-text answers (src/api/answerText.ts), used by the Ask screen.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/loadTs.cjs');

const { sanitizeAnswer } = loadTs('src/api/answerText.ts');

test('answers lose obvious Markdown without damaging plain text', () => {
  const markdown = '# Explanation\n\n**Plant cells** retain Na+/K+ notation.\n\n## Key Point\n- Cell walls support shape.\n- __Adjacent cells__ form regular arrangements.';
  assert.equal(
    sanitizeAnswer(markdown),
    'Explanation\n\nPlant cells retain Na+/K+ notation.\n\nKey Point\n• Cell walls support shape.\n• Adjacent cells form regular arrangements.',
  );
  assert.equal(sanitizeAnswer('Rigid cell walls can influence plant cell shape.'), 'Rigid cell walls can influence plant cell shape.');
});
