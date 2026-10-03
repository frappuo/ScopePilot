const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');

process.env.EXPO_PUBLIC_API_URL = 'http://localhost:8000/';
let nativeUpload;
const nativeFileUris = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'expo-file-system') {
    return {
      File: class {
        constructor(uri) { nativeFileUris.push(uri); }
        upload(endpoint, options) { return nativeUpload(endpoint, options); }
      },
      UploadType: { MULTIPART: 1 },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const compiled = ts.transpileModule(fs.readFileSync('src/services/api.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = new Module('api-test');
loaded._compile(compiled, 'api-test.cjs');
Module._load = originalLoad;
const { analyzeImage, askQuestion, generateQuiz, sanitizeAnswer } = loaded.exports;
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  process.env.EXPO_PUBLIC_API_URL = 'http://localhost:8000/';
  delete process.env.EXPO_PUBLIC_APP_TOKEN;
  nativeUpload = undefined;
  nativeFileUris.length = 0;
});
const image = { uri: 'local', name: 'microscopy.jpg', type: 'image/jpeg', blob: new Blob(['image'], { type: 'image/jpeg' }) };
const result = { probable_specimen: 'Possible plant tissue', visible_structures: [], observations: [], explanation: 'Test explanation', limitations: ['Verify with an instructor.'] };
const quiz = { questions: [
  { question: 'Why?', options: ['A', 'B', 'C', 'D'], correct_answer: 'A', explanation: 'Because.' },
  { question: 'What?', options: ['E', 'F', 'G', 'H'], correct_answer: 'F', explanation: 'For this reason.' },
  { question: 'How?', options: ['I', 'J', 'K', 'L'], correct_answer: 'L', explanation: 'This follows from the observation.' },
] };

test('uploads the image field and returns structured results', async () => {
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://localhost:8000/analyze');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers, undefined);
    assert.equal(options.body.get('image').name, 'microscopy.jpg');
    return Response.json(result);
  };
  assert.deepEqual(await analyzeImage(image), result);
});
test('unreachable backend gives an actionable error', async () => {
  global.fetch = async () => { throw new TypeError('network failure'); };
  await assert.rejects(analyzeImage(image), /before an HTTP response/);
});
test('provider failure gives a retryable message without forwarding the body', async () => {
  global.fetch = async () => new Response('private upstream details', { status: 502 });
  await assert.rejects(analyzeImage(image), /analysis service could not complete/);
});
test('oversized uploads give a specific error', async () => {
  global.fetch = async () => new Response('', { status: 413 });
  await assert.rejects(analyzeImage(image), /too large/);
});
test('validation errors include the backend detail', async () => {
  global.fetch = async () => Response.json({ detail: 'Image content does not match its declared type.' }, { status: 415 });
  await assert.rejects(analyzeImage(image), {
    message: 'This image format is not supported. Please choose another image. Details: Image content does not match its declared type.',
  });
});
test('native upload validation errors include the backend detail', async () => {
  const detail = 'Image resolution exceeds the limit of 20,000,000 pixels. Choose a smaller image or lower the camera resolution.';
  nativeUpload = async () => ({ status: 413, body: JSON.stringify({ detail }), headers: { 'content-type': 'application/json' } });
  await assert.rejects(analyzeImage({ uri: 'file:///image.jpg', name: 'image.jpg', type: 'image/jpeg' }), {
    message: `This image is too large for the backend. Please choose a smaller image. Details: ${detail}`,
  });
});
test('server error details are never shown', async () => {
  global.fetch = async () => Response.json({ detail: 'private provider detail' }, { status: 502 });
  await assert.rejects(analyzeImage(image), error => {
    assert.match(error.message, /analysis service could not complete/);
    assert.equal(error.message.includes('private provider detail'), false);
    return true;
  });
});
test('unusable validation details fall back to the mapped message', async () => {
  const unsupported = 'This image format is not supported. Please choose another image.';
  global.fetch = async () => new Response('not json', { status: 415 });
  await assert.rejects(analyzeImage(image), { message: unsupported });
  global.fetch = async () => Response.json({ detail: 'x'.repeat(201) }, { status: 415 });
  await assert.rejects(analyzeImage(image), { message: unsupported });
  global.fetch = async () => Response.json({ detail: 42 }, { status: 400 });
  await assert.rejects(analyzeImage(image), { message: 'This image could not be read. Please choose another image.' });
});
test('malformed result is rejected before display', async () => {
  global.fetch = async () => Response.json({ ...result, visible_structures: [123] });
  await assert.rejects(analyzeImage(image), /incomplete result/);
});
test('non-JSON success is rejected before display', async () => {
  global.fetch = async () => new Response('not json');
  await assert.rejects(analyzeImage(image), /unreadable result/);
});

test('uses the current LAN URL and appends analyze exactly once', async () => {
  process.env.EXPO_PUBLIC_API_URL = '  http://192.168.137.1:8000///  ';
  global.fetch = async (url) => {
    assert.equal(url, 'http://192.168.137.1:8000/analyze');
    return Response.json(result);
  };
  await analyzeImage(image);
});

for (const address of ['http://', 'http://localhost:8000/health', 'http://localhost:8000/analyze', 'http://localhost:8000?value=test', 'http://user:placeholder@localhost:8000']) {
  test(`rejects invalid base address ${address}`, async () => {
    process.env.EXPO_PUBLIC_API_URL = address;
    global.fetch = async () => { assert.fail('Invalid configuration must not send a request'); };
    await assert.rejects(analyzeImage(image), /Invalid backend address/);
  });
}

test('missing URL does not fall back to localhost', async () => {
  delete process.env.EXPO_PUBLIC_API_URL;
  global.fetch = async () => { assert.fail('Missing configuration must not send a request'); };
  await assert.rejects(analyzeImage(image), /not configured/);
});

test('configuration diagnostics distinguish missing and invalid values without logging them', async (context) => {
  const logs = [];
  const previousDev = global.__DEV__;
  global.__DEV__ = true;
  context.after(() => {
    if (previousDev === undefined) delete global.__DEV__;
    else global.__DEV__ = previousDev;
  });
  context.mock.method(console, 'info', (...args) => logs.push(args));
  global.fetch = async () => { assert.fail('Invalid configuration must not send a request'); };
  delete process.env.EXPO_PUBLIC_API_URL;
  await assert.rejects(analyzeImage(image), /not configured/);
  process.env.EXPO_PUBLIC_API_URL = 'malformed-value';
  await assert.rejects(analyzeImage(image), /Invalid backend address/);
  assert.deepEqual(logs, [
    ['[ScopePilot API]', { category: 'configuration_missing' }],
    ['[ScopePilot API]', { category: 'configuration_invalid' }],
  ]);
});

test('native multipart uses the image field and MIME type and returns structured results', async (context) => {
  const logs = [];
  const oldDev = global.__DEV__;
  global.__DEV__ = true;
  context.mock.method(console, 'info', (...args) => logs.push(args));
  const original = {
    uri: 'file:///private/test/original.png', name: 'sample.png', type: 'image/png',
    fileName: 'sample.png', mimeType: 'image/png', fileSize: 188000,
  };
  try {
    global.fetch = async () => { assert.fail('Native upload must not use fetch FormData'); };
    nativeUpload = async (endpoint, options) => {
      assert.equal(endpoint, 'http://localhost:8000/analyze');
      assert.deepEqual(options, {
        httpMethod: 'POST', uploadType: 1, fieldName: 'image', mimeType: 'image/png',
        sessionType: 'foreground', signal: options.signal,
      });
      assert.equal(options.signal.aborted, false);
      assert.equal(options.headers, undefined);
      return { status: 200, body: JSON.stringify(result), headers: { 'content-type': 'application/json' } };
    };
    assert.deepEqual(await analyzeImage(original), result);
    assert.deepEqual(nativeFileUris, [original.uri]);
    assert.deepEqual(logs[0][1], {
      endpoint: 'http://localhost:8000/analyze', uriScheme: 'file',
      mimeType: 'image/png', hasFileName: true, fileSize: 188000,
    });
    assert.deepEqual(logs[1][1], { status: 200 });
    assert.equal(JSON.stringify(logs).includes(original.uri), false);
    assert.equal(JSON.stringify(logs).includes(original.fileName), false);
  } finally {
    if (oldDev === undefined) delete global.__DEV__;
    else global.__DEV__ = oldDev;
  }
});

test('native upload preserves non-2xx status handling', async () => {
  nativeUpload = async () => ({ status: 502, body: 'private provider details', headers: {} });
  await assert.rejects(analyzeImage({ uri: 'file:///image.jpg', name: 'image.jpg', type: 'image/jpeg' }),
    /analysis service could not complete/);
});

test('native upload rejects malformed JSON with the existing message', async () => {
  nativeUpload = async () => ({ status: 200, body: 'not json', headers: {} });
  await assert.rejects(analyzeImage({ uri: 'file:///image.jpg', name: 'image.jpg', type: 'image/jpeg' }),
    /unreadable result/);
});

test('native upload retains timeout and cancellation behavior', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let uploadSignal;
  nativeUpload = async (_, options) => new Promise((resolve, reject) => {
    uploadSignal = options.signal;
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const pending = analyzeImage({ uri: 'file:///image.jpg', name: 'image.jpg', type: 'image/jpeg' });
  context.mock.timers.tick(90_000);
  await assert.rejects(pending, /Analysis took too long/);
  assert.equal(uploadSignal.aborted, true);
});

test('follow-up request contains only the analysis and trimmed question', async () => {
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://localhost:8000/ask');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), {
      analysis: result,
      question: 'Why are the cells rectangular?',
    });
    return Response.json({ answer: 'Rigid cell walls can influence plant cell shape.' });
  };
  assert.equal(
    await askQuestion(result, '  Why are the cells rectangular?  '),
    'Rigid cell walls can influence plant cell shape.',
  );
});

test('follow-up request preserves safe HTTP and response errors', async () => {
  global.fetch = async () => new Response('private provider detail', { status: 502 });
  await assert.rejects(askQuestion(result, 'Why?'), /could not produce an answer/);
  global.fetch = async () => Response.json({ answer: '   ' });
  await assert.rejects(askQuestion(result, 'Why?'), /empty answer/);
  global.fetch = async () => { throw new Error('private transport detail'); };
  await assert.rejects(askQuestion(result, 'Why?'), /Could not reach the question service/);
});

test('follow-up answers remove obvious Markdown without damaging plain text', async () => {
  const markdown = '# Explanation\n\n**Plant cells** retain Na+/K+ notation.\n\n## Key Point\n- Cell walls support shape.\n- __Adjacent cells__ form regular arrangements.';
  assert.equal(
    sanitizeAnswer(markdown),
    'Explanation\n\nPlant cells retain Na+/K+ notation.\n\nKey Point\n• Cell walls support shape.\n• Adjacent cells form regular arrangements.',
  );
  global.fetch = async () => Response.json({ answer: markdown });
  assert.equal(await askQuestion(result, 'Why?'), sanitizeAnswer(markdown));
});

test('quiz request sends only the current analysis and accepts a valid response', async () => {
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://localhost:8000/quiz');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), { analysis: result });
    return Response.json(quiz);
  };
  assert.deepEqual(await generateQuiz(result), quiz);
});

test('quiz response validation rejects malformed question counts and options', async () => {
  global.fetch = async () => Response.json({ questions: quiz.questions.slice(0, 2) });
  await assert.rejects(generateQuiz(result), /incomplete quiz/);
  global.fetch = async () => Response.json({ questions: quiz.questions.map(question => ({ ...question, options: ['A'] })) });
  await assert.rejects(generateQuiz(result), /incomplete quiz/);
});

test('quiz provider and transport failures preserve safe errors', async () => {
  global.fetch = async () => new Response('private provider detail', { status: 502 });
  await assert.rejects(generateQuiz(result), /could not generate a quiz/);
  global.fetch = async () => { throw new Error('private transport detail'); };
  await assert.rejects(generateQuiz(result), /Could not reach the quiz service/);
});

const TOKEN = 'dummy-app-token-for-tests';
const nativeImage = { uri: 'file:///image.jpg', name: 'image.jpg', type: 'image/jpeg' };
const jsonOk = url => url.endsWith('/analyze') ? Response.json(result)
  : url.endsWith('/ask') ? Response.json({ answer: 'An answer.' }) : Response.json(quiz);

test('app token header is sent on every request when configured', async () => {
  process.env.EXPO_PUBLIC_APP_TOKEN = `  ${TOKEN}  `;
  const seen = [];
  global.fetch = async (url, options) => { seen.push([url, options.headers]); return jsonOk(url); };
  await analyzeImage(image);
  await askQuestion(result, 'Why?');
  await generateQuiz(result);
  assert.deepEqual(seen, [
    ['http://localhost:8000/analyze', { 'X-ScopePilot-Token': TOKEN }],
    ['http://localhost:8000/ask', { 'Content-Type': 'application/json', 'X-ScopePilot-Token': TOKEN }],
    ['http://localhost:8000/quiz', { 'Content-Type': 'application/json', 'X-ScopePilot-Token': TOKEN }],
  ]);
  nativeUpload = async (_, options) => {
    assert.deepEqual(options.headers, { 'X-ScopePilot-Token': TOKEN });
    return { status: 200, body: JSON.stringify(result), headers: {} };
  };
  assert.deepEqual(await analyzeImage(nativeImage), result);
});

for (const value of [undefined, '   ']) {
  test(`no app token header when the variable is ${value === undefined ? 'unset' : 'blank'}`, async () => {
    if (value !== undefined) process.env.EXPO_PUBLIC_APP_TOKEN = value;
    const seen = [];
    global.fetch = async (url, options) => { seen.push(options.headers); return jsonOk(url); };
    await analyzeImage(image);
    await askQuestion(result, 'Why?');
    await generateQuiz(result);
    assert.deepEqual(seen, [undefined, { 'Content-Type': 'application/json' }, { 'Content-Type': 'application/json' }]);
    nativeUpload = async (_, options) => {
      assert.equal('headers' in options, false);
      return { status: 200, body: JSON.stringify(result), headers: {} };
    };
    await analyzeImage(nativeImage);
  });
}

const calls = [
  ['analyze (web)', () => analyzeImage(image)],
  ['analyze (native)', () => analyzeImage(nativeImage)],
  ['ask', () => askQuestion(result, 'Why?')],
  ['quiz', () => generateQuiz(result)],
];
function respondWith(status, body) {
  global.fetch = async () => new Response(body, { status, headers: { 'content-type': 'application/json' } });
  nativeUpload = async () => ({ status, body, headers: { 'content-type': 'application/json' } });
}

for (const [status, message] of [
  [401, "This app version can't reach the service. Please update the app."],
  [429, 'Too many requests right now. Please wait a minute and try again.'],
]) {
  test(`${status} has a fixed message on every call`, async () => {
    for (const [, call] of calls) {
      respondWith(status, JSON.stringify({ detail: 'private backend detail' }));
      await assert.rejects(call(), { message });
    }
  });
}

test('daily-cap 503 shows a fixed app message; other 503 bodies are never shown', async () => {
  const daily = "Today's ScopePilot analysis limit has been reached. Please try again tomorrow (the limit resets at 00:00 UTC).";
  for (const [, call] of calls) {
    respondWith(503, JSON.stringify({ detail: 'Daily Gemini request limit for this server reached. Try again after 00:00 UTC.' }));
    await assert.rejects(call(), { message: daily });
    respondWith(503, JSON.stringify({ detail: 'private provider detail' }));
    await assert.rejects(call(), error => {
      assert.match(error.message, /unavailable\. Please try again later/);
      assert.equal(error.message.includes('private provider detail'), false);
      return true;
    });
  }
});

test('ask and quiz have specific 413 and 422 messages', async () => {
  const detail = 'Request body exceeds the 65,536-byte limit.';
  respondWith(413, JSON.stringify({ detail }));
  await assert.rejects(askQuestion(result, 'Why?'), {
    message: `This question and analysis are too large to send. Please analyze the image again. Details: ${detail}`,
  });
  await assert.rejects(generateQuiz(result), {
    message: `This analysis is too large to create a quiz from. Please analyze the image again. Details: ${detail}`,
  });
  respondWith(422, JSON.stringify({ detail: [{ loc: ['body', 'analysis', 'explanation'], msg: 'private validation text' }] }));
  await assert.rejects(generateQuiz(result), { message: "This analysis can't be used for a quiz. Please analyze the image again." });
});

test('ask 422 separates a too-long question from analysis caps without showing backend text', async () => {
  const neutral = 'This request could not be processed. Please analyze the image again.';
  const error = (...loc) => ({ loc, msg: 'private validation text', type: 'string_too_long' });
  respondWith(422, JSON.stringify({ detail: [error('body', 'question')] }));
  await assert.rejects(askQuestion(result, 'Why?'), { message: 'Please enter a question of up to 500 characters.' });
  for (const body of [
    JSON.stringify({ detail: [error('body', 'analysis', 'explanation')] }),
    JSON.stringify({ detail: [error('body', 'question'), error('body', 'analysis', 'observations', 0)] }),
    JSON.stringify({ detail: [] }),
    'not json',
  ]) {
    respondWith(422, body);
    await assert.rejects(askQuestion(result, 'Why?'), { message: neutral });
  }
});
