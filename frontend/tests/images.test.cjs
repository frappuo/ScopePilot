const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');

const compiled = ts.transpileModule(fs.readFileSync('src/services/images.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function pickerResult(result) {
  const loaded = new Module('images-test');
  loaded.require = name => {
    assert.equal(name, 'expo-image-picker', 'Selection must not import a manipulator or filesystem');
    return { launchImageLibraryAsync: async options => {
      assert.equal(options.allowsEditing, false);
      assert.equal(options.allowsMultipleSelection, false);
      return result;
    } };
  };
  loaded._compile(compiled, 'images-test.cjs');
  return loaded.exports.selectImage();
}

test('preserves original picker URI and metadata without manipulation', async () => {
  const asset = { uri: 'file:///test/original.png', fileName: 'sample.png', mimeType: 'image/png', fileSize: 188000 };
  const selected = await pickerResult({ canceled: false, assets: [asset] });
  for (const field of ['uri', 'fileName', 'mimeType', 'fileSize']) assert.equal(selected[field], asset[field]);
  assert.equal(selected.name, asset.fileName);
  assert.equal(selected.type, 'image/png');
});
test('infers supported type and fallback name without changing URI', async () => {
  const uri = 'file:///test/original.WEBP';
  const selected = await pickerResult({ canceled: false, assets: [{ uri }] });
  assert.equal(selected.uri, uri);
  assert.equal(selected.type, 'image/webp');
  assert.equal(selected.name, 'microscopy.webp');
});
test('MIME metadata wins over filename extension', async () => {
  await assert.rejects(pickerResult({ canceled: false, assets: [{ uri: 'file:///test/photo.jpg', mimeType: 'image/heic' }] }), /HEIC conversion is disabled/);
});
test('rejects unknown and HEIC assets instead of labeling them JPEG', async () => {
  for (const uri of ['ph://opaque-id', 'file:///test/photo.heic']) {
    await assert.rejects(pickerResult({ canceled: false, assets: [{ uri }] }), /JPEG, PNG, or WebP/);
  }
});
test('cancelling selection leaves the previous image alone', async () => {
  assert.equal(await pickerResult({ canceled: true, assets: null }), null);
});
