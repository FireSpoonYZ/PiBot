import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../desktop/src-tauri/src/google_client_draft.js', import.meta.url), 'utf8');
const project = 'test-project';
const account = 'owner@example.test';
const redirectUri = 'https://center.example.test/api/oauth/google/callback';

function draftFixture({ locale = 'en', dialog = false, search = '?project=test-project', custom = false,
  signedIn = account, redirect = '', disabled = false } = {}) {
  class Element {
    constructor(label = '') { this.innerText = label; }
    getClientRects() { return [{}]; }
    getAttribute(name) { return name === 'aria-label' ? this.label : null; }
    dispatchEvent() {}
  }
  class Input extends Element {
    #value = '';
    get value() { return this.#value; }
    set value(value) { this.#value = value; }
  }
  class Button extends Element {
    constructor(label, type, action) {
      super(label);
      this.type = type;
      this.click = action;
    }
  }
  class Select extends Input {
    options = [];
    get value() { return super.value; }
    set value(value) { super.value = value; }
    get selectedOptions() { return this.options.filter(option => option.value === this.value); }
  }

  const labels = locale === 'zh'
    ? ['应用类型', 'Web 应用', '名称', '已获授权的重定向 URI', '添加 URI', '已获授权的 JavaScript 来源',
      '创建', 'OAuth 客户端已创建', '下载 JSON', 'Google 帐号']
    : ['Application type', 'Web application', 'Name', 'Authorized redirect URIs', 'Add URI', 'Authorized JavaScript origins',
      'Create', 'OAuth client created', 'Download JSON', 'Google Account'];
  const [typeLabel, webLabel, nameLabel, redirectLabel, addLabel, originLabel, createLabel, createdLabel, downloadLabel, accountLabel] = labels;
  const application = custom ? new Element() : new Select();
  application.label = typeLabel;
  let options = [];
  const webOption = new Element(webLabel);
  webOption.click = () => { application.innerText = webLabel; options = []; };
  if (custom) application.click = () => { options = [webOption]; };
  else application.options = [{ label: typeLabel, value: '', disabled: true }, { label: webLabel, value: 'web' }];

  const name = new Input();
  name.label = nameLabel;
  const accountButton = new Element();
  accountButton.label = `${accountLabel}: Test User (${signedIn})`;
  const uri = new Input();
  uri.value = redirect;
  const origin = new Input();
  const redirectHeading = new Element(redirectLabel);
  const originHeading = new Element(originLabel);
  let uriAdded = Boolean(redirect);
  let submissions = 0;
  let downloads = 0;
  const create = new Button(createLabel, 'submit', () => { submissions += 1; dialog = true; });
  create.disabled = disabled;
  const download = new Button(downloadLabel, 'button', () => { downloads += 1; });
  const add = new Button(addLabel, 'button', () => { uriAdded = true; });
  redirectHeading.parentElement = {
    contains: element => element === redirectHeading,
    querySelectorAll: selector => selector.startsWith('button') ? [add] : uriAdded ? [uri] : [],
  };
  const created = new Element();
  created.querySelectorAll = selector => selector.startsWith('h1') ? [new Element(createdLabel)] : [download];

  const callbacks = new Map();
  const timers = new Map();
  const storage = new Map();
  let timerId = 0;
  const document = {
    addEventListener: (event, callback) => callbacks.set(event, callback),
    removeEventListener: event => callbacks.delete(event),
    querySelectorAll(selector) {
      if (selector.startsWith('dialog')) return dialog ? [created] : [];
      if (selector.startsWith('[aria-label]')) return [accountButton];
      if (selector.startsWith('select')) return [application];
      if (selector.startsWith('[role=listbox]')) return options;
      if (selector.startsWith('input')) return [name];
      if (selector.startsWith('button')) return [create];
      return [originHeading, redirectHeading];
    },
  };
  const window = {};
  window.top = window;
  const prepare = runInNewContext(`(${source})`, {
    window, document, location: new URL('https://console.cloud.google.com/auth/clients/create' + search),
    URLSearchParams, HTMLInputElement: Input, HTMLSelectElement: Select, HTMLButtonElement: Button, Event,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setTimeout: callback => (timers.set(++timerId, callback), timerId),
    clearTimeout: id => timers.delete(id),
  });
  const flush = () => {
    for (let frame = 0; frame < 5; frame++) {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    }
  };
  return {
    start: () => prepare({ project, account, redirectUri, attempt: 'first-run', deadline: Date.now() + 30_000 }),
    application, name, uri, origin, flush, callbacks,
    get submissions() { return submissions; },
    get downloads() { return downloads; },
  };
}

test('the private desktop window creates and downloads the exact Web client once without a second confirmation', () => {
  for (const options of [{}, { locale: 'zh', custom: true }]) {
    const form = draftFixture(options);
    form.start();
    form.flush();
    assert.equal(options.custom ? form.application.innerText : form.application.value, options.custom ? 'Web 应用' : 'web');
    assert.equal(form.name.value, 'PiBot Center');
    assert.equal(form.uri.value, redirectUri);
    assert.equal(form.origin.value, '');
    assert.equal(form.submissions, 1);
    assert.equal(form.downloads, 1);
    form.start();
    form.flush();
    assert.equal(form.submissions, 1);
    assert.equal(form.downloads, 1);
  }
});

test('automatic creation stops for another project or account, unknown credentials, validation, or manual input', () => {
  for (const state of [
    { search: '?project=wrong-project' },
    { signedIn: 'another@example.test' },
    { dialog: true },
    { redirect: 'https://wrong.example.test/api/oauth/google/callback' },
    { disabled: true },
  ]) {
    const form = draftFixture(state);
    form.start();
    form.flush();
    assert.equal(form.submissions, 0);
    assert.equal(form.downloads, 0);
  }

  const form = draftFixture();
  form.start();
  form.callbacks.get('pointerdown')({ isTrusted: true });
  form.flush();
  assert.equal(form.submissions, 0);
  assert.equal(form.downloads, 0);
});
