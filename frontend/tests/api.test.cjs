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
const { analyzeImage, askQuestion, generateQuiz, checkBackendHealth, checkBackendPost, sanitizeAnswer } = loaded.exports;
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  process.env.EXPO_PUBLIC_API_URL = 'http://localhost:8000/';
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
  assert.match(await checkBackendHealth(), /not configured/);
  process.env.EXPO_PUBLIC_API_URL = 'malformed-value';
  assert.match(await checkBackendHealth(), /Invalid backend address/);
  assert.deepEqual(logs, [
    ['[ScopePilot API]', { category: 'configuration_missing' }],
    ['[ScopePilot API]', { category: 'configuration_invalid' }],
  ]);
});

test('health diagnostic uses GET with no body or headers', async () => {
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://localhost:8000/health');
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(options.headers, undefined);
    return new Response('', { status: 200 });
  };
  assert.match(await checkBackendHealth(), /HTTP 200/);
});
test('health diagnostic preserves non-200 HTTP status', async () => {
  global.fetch = async () => new Response('', { status: 503 });
  assert.match(await checkBackendHealth(), /HTTP 503/);
});
test('health diagnostic sanitizes transport errors', async () => {
  global.fetch = async () => { throw new Error('private details'); };
  assert.match(await checkBackendHealth(), /No HTTP response \(transport\)/);
});
test('health diagnostic times out after five seconds', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  global.fetch = async (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const pending = checkBackendHealth();
  context.mock.timers.tick(5000);
  assert.match(await pending, /No HTTP response \(timeout\)/);
});

test('POST diagnostic sends no body or headers and recognizes expected 422', async () => {
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://localhost:8000/analyze');
    assert.equal(options.method, 'POST');
    assert.equal(options.body, undefined);
    assert.equal(options.headers, undefined);
    return new Response('', { status: 422 });
  };
  assert.match(await checkBackendPost(), /HTTP 422 — POST reaches FastAPI/);
});
test('POST diagnostic distinguishes transport rejection from HTTP response', async () => {
  global.fetch = async () => { throw new Error('private details'); };
  assert.match(await checkBackendPost(), /No HTTP response \(transport\) for POST/);
  global.fetch = async () => new Response('', { status: 503 });
  assert.match(await checkBackendPost(), /HTTP 503/);
});
test('POST diagnostic has a five-second timeout', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  global.fetch = async (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const pending = checkBackendPost();
  context.mock.timers.tick(5000);
  assert.match(await pending, /No HTTP response \(timeout\) for POST/);
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
