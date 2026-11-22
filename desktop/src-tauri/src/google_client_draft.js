// Runs only in the authenticated owner's private window, never in the Bot browser.
function provisionGoogleClient({ project, account, redirectUri, attempt, deadline }) {
  const onClientPage = () => window === window.top && location.origin === 'https://console.cloud.google.com' &&
    /^\/auth\/clients(?:\/|$)/.test(location.pathname) && new URLSearchParams(location.search).get('project') === project;
  if (!onClientPage()) return;
  const attemptKey = `pibot-google-client:${attempt}`;

  const applicationType = /^(application type|应用类型|應用程式類型)$/i;
  const webApplication = /^(web application|web\s*应用(?:程序)?|網頁應用程式)$/i;
  const nameLabel = /^(name|名称|名稱)$/i;
  const redirectHeading = /^(authorized redirect uris?|已获授权的重定向\s*uris?|已授权的重定向\s*uris?|已授權的重新導向\s*uris?)$/i;
  const originHeading = /^(authorized javascript origins?|已获授权的 javascript 来源|已授权的 javascript 来源|已授權的 javascript 來源)$/i;
  const addUriLabel = /^(add uri|添加\s*uri|新增\s*uri)$/i;
  const createLabel = /^(create|创建|建立)$/i;
  const createdLabel = /^(oauth client created|已创建\s*oauth\s*客户端|oauth\s*客户端已创建|已建立\s*oauth\s*用戶端)$/i;
  const downloadLabel = /^(download\s+json|下载\s*json|下載\s*json)$/i;
  const accountLabel = /^(?:google\s*(?:account|账号|帐号|帳戶|帳號)|account|帐号|账号|帳戶|帳號)\s*[:：]/i;
  const text = value => String(value ?? '').replace(/\s+/g, ' ').replace(/\s*[*＊]$/, '').trim();
  const visible = (root, selector) => [...root.querySelectorAll(selector)]
    .filter(element => element.getClientRects().length && !element.disabled && element.getAttribute('aria-disabled') !== 'true');
  const elementText = element => text(element.innerText ?? element.textContent);
  const labelled = (element, pattern) => [
    element.getAttribute('aria-label'), element.getAttribute('placeholder'),
    ...[...(element.labels ?? [])].map(elementText),
    ...(element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)).filter(Boolean).map(elementText),
  ].some(label => pattern.test(text(label)));
  const only = elements => elements.length === 1 ? elements[0] : null;
  const draftButton = element => !(element instanceof HTMLButtonElement) || element.type === 'button' || !element.form;
  const byLabel = (root, selector, pattern) => only(visible(root, selector)
    .filter(element => pattern.test(elementText(element)) || labelled(element, pattern)));
  const setValue = (element, value, prototype) => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };

  let openedTypeMenu = false;
  let choseWebType = false;
  let addedUri = false;
  let timer;
  function stopOnUserInput(event) {
    if (event.isTrusted) stop();
  }
  function stop() {
    clearTimeout(timer);
    document.removeEventListener('pointerdown', stopOnUserInput, true);
    document.removeEventListener('keydown', stopOnUserInput, true);
  }

  function chooseWebApplication() {
    if (choseWebType) return true;
    const dropdown = only(visible(document, 'select, [role=combobox], button[aria-haspopup=listbox]')
      .filter(element => labelled(element, applicationType)));
    if (!dropdown) return false;
    if (dropdown instanceof HTMLSelectElement) {
      const option = only([...dropdown.options].filter(item => !item.disabled && webApplication.test(text(item.label))));
      if (!option) return false;
      if (dropdown.value !== option.value) {
        if (dropdown.value && !dropdown.selectedOptions[0]?.disabled && !applicationType.test(text(dropdown.selectedOptions[0]?.label))) return false;
        setValue(dropdown, option.value, HTMLSelectElement.prototype);
      }
      return (choseWebType = true);
    }
    if (webApplication.test(elementText(dropdown))) return (choseWebType = true);
    if (!draftButton(dropdown)) return false;
    if (!openedTypeMenu) {
      dropdown.click();
      openedTypeMenu = true;
    }
    const option = only(visible(document, '[role=listbox] [role=option]').filter(item => webApplication.test(elementText(item))));
    if (!option || !draftButton(option)) return false;
    option.click();
    return (choseWebType = true);
  }

  function setRedirectUri() {
    const headings = visible(document, 'h1, h2, h3, h4, h5, legend, label, [role=heading], div, span');
    const heading = headings.filter(element => redirectHeading.test(elementText(element))).at(-1);
    if (!heading) return false;
    for (let section = heading.parentElement, depth = 0; section && depth < 6; section = section.parentElement, depth++) {
      if (headings.some(element => section.contains(element) && originHeading.test(elementText(element)))) return false;
      const add = byLabel(section, 'button, [role=button]', addUriLabel);
      if (!add || !draftButton(add)) continue;
      const inputs = visible(section, 'input:not([type]), input[type=text], input[type=url]').filter(input => !input.readOnly);
      const filled = inputs.filter(input => input.value.trim());
      if (filled.length !== 0) return filled.length === 1 && filled[0].value === redirectUri;
      if (inputs[0]) {
        setValue(inputs[0], redirectUri, HTMLInputElement.prototype);
        return false;
      }
      if (!addedUri) {
        add.click();
        addedUri = true;
      }
      return false;
    }
    return false;
  }

  function tryProvision() {
    if (!onClientPage() || Date.now() >= deadline) return stop();
    const dialogs = visible(document, 'dialog[open], [role=dialog], [role=alertdialog]');
    const phase = sessionStorage.getItem(attemptKey);
    if (phase === 'download') return stop();
    if (phase === 'created') {
      const dialog = only(dialogs.filter(element => labelled(element, createdLabel) ||
        byLabel(element, 'h1, h2, h3, h4, [role=heading]', createdLabel)));
      const download = dialog && byLabel(dialog, 'button, a, [role=button]', downloadLabel);
      if (download && draftButton(download)) {
        sessionStorage.setItem(attemptKey, 'download');
        stop();
        download.click();
        return;
      }
    } else if (!dialogs.length && location.pathname.replace(/\/$/, '') === '/auth/clients/create') {
      const signedIn = visible(document, '[aria-label], [title]').some(element =>
        [element.getAttribute('aria-label'), element.getAttribute('title')].some(value =>
          value && accountLabel.test(value) && value.toLowerCase().split(/[\s()<>,]+/).includes(account.toLowerCase())));
      if (signedIn && chooseWebApplication()) {
        const name = only(visible(document, 'input:not([type]), input[type=text]')
          .filter(input => !input.readOnly && labelled(input, nameLabel)));
        if (name && (!name.value.trim() || /^web (?:client|客户端)\s*\d+$/i.test(name.value))) {
          setValue(name, 'PiBot Center', HTMLInputElement.prototype);
        }
        if (name?.value === 'PiBot Center' && setRedirectUri()) {
          const create = byLabel(document, 'button, [role=button]', createLabel);
          if (create) {
            sessionStorage.setItem(attemptKey, 'created');
            create.click();
          }
        }
      }
    }
    timer = setTimeout(tryProvision, 200);
  }

  document.addEventListener('pointerdown', stopOnUserInput, true);
  document.addEventListener('keydown', stopOnUserInput, true);
  tryProvision();
}
