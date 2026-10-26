const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/loadTs.cjs');

function loadMenu(os) {
  const calls = { sheets: [], alerts: [] };
  const menu = loadTs('src/components/optionsMenu.ts', {
    'react-native': {
      Platform: { OS: os },
      ActionSheetIOS: { showActionSheetWithOptions: (options, callback) => calls.sheets.push({ options, callback }) },
      Alert: { alert: (...args) => calls.alerts.push(args) },
    },
  });
  return { menu, calls };
}

const pressed = [];
const actions = [
  { label: 'Edit title and notes', onPress: () => pressed.push('edit') },
  { label: 'Delete', onPress: () => pressed.push('delete'), destructive: true },
];

test('iOS uses the native action sheet with Cancel last and the destructive index', () => {
  pressed.length = 0;
  const { menu, calls } = loadMenu('ios');
  menu.showOptionsMenu(actions);
  assert.equal(calls.alerts.length, 0);
  const { options, callback } = calls.sheets[0];
  assert.deepEqual(options, { options: ['Edit title and notes', 'Delete', 'Cancel'], cancelButtonIndex: 2, destructiveButtonIndex: 1 });
  callback(0);
  callback(1);
  callback(2);
  assert.deepEqual(pressed, ['edit', 'delete']);
});

test('iOS omits the destructive index when no action is destructive, and passes a title', () => {
  const { menu, calls } = loadMenu('ios');
  menu.showOptionsMenu([actions[0]], 'Observation');
  assert.deepEqual(calls.sheets[0].options, { options: ['Edit title and notes', 'Cancel'], cancelButtonIndex: 1, title: 'Observation' });
});

test('Android uses an Alert with the actions and Cancel, dismissable', () => {
  pressed.length = 0;
  const { menu, calls } = loadMenu('android');
  menu.showOptionsMenu(actions);
  assert.equal(calls.sheets.length, 0);
  const [title, message, buttons, options] = calls.alerts[0];
  assert.equal(title, 'Options');
  assert.equal(message, undefined);
  assert.deepEqual(buttons.map(({ text, style }) => [text, style]), [
    ['Edit title and notes', 'default'], ['Delete', 'destructive'], ['Cancel', 'cancel'],
  ]);
  assert.deepEqual(options, { cancelable: true });
  buttons[1].onPress();
  assert.deepEqual(pressed, ['delete']);
});

test('no actions shows nothing; more than two is refused', () => {
  const { menu, calls } = loadMenu('android');
  menu.showOptionsMenu([]);
  assert.deepEqual([calls.sheets.length, calls.alerts.length], [0, 0]);
  assert.throws(() => menu.showOptionsMenu([...actions, actions[0]]), /at most 2/);
});
