// Answers are asked for as plain text (ASK_PROMPT in backend/app/services/gemini.py), but the model
// can still return Markdown. This strips headings, bold markers and list dashes so the answer
// reads as plain text, without a Markdown renderer.
export function sanitizeAnswer(answer: string): string {
  return answer
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '')
    .replace(/[ \t]+#+[ \t]*$/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
