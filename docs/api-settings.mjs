import { requestCompletion, requestModels } from './chat.mjs?v=case-generation';
import { defaultApi } from './config/api.mjs';

const storageKey = 'pet-doctor-chat:api-settings';

function readSavedSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if ([saved?.baseUrl, saved?.apiKey, saved?.model].every(value => typeof value === 'string' && value.trim())) {
      const { baseUrl, apiKey, model, mode } = saved;
      return { baseUrl, apiKey, model, mode };
    }
  } catch {
    // The settings form remains available if storage is blocked or the saved value is invalid.
  }
}

export function bindApiSettings(dialog, notice) {
  const form = dialog.querySelector('#api-settings-form');
  const { mode, baseUrl, apiKey, model } = form.elements;
  const defaultInfo = dialog.querySelector('#default-api-info');
  const customFields = dialog.querySelector('#custom-api-fields');
  const fetchButton = dialog.querySelector('#fetch-models');
  const testButton = dialog.querySelector('#test-api-connection');
  const saveButton = dialog.querySelector('#save-api-settings');
  const clearButton = dialog.querySelector('#clear-api-settings');
  const status = dialog.querySelector('#api-settings-feedback');
  let saved = readSavedSettings();
  let activeMode = saved && saved.mode !== 'default' ? 'custom' : 'default';
  let pending;
  dialog.querySelector('#default-api-model').textContent = defaultApi.model;
  notice.hidden = activeMode === 'custom';

  function feedback(message = '', error = false) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle('error', error);
  }

  function connection() {
    return { baseUrl: baseUrl.value.trim(), apiKey: apiKey.value.trim() };
  }

  function updateControls() {
    const custom = mode.value === 'custom';
    defaultInfo.hidden = custom;
    customFields.hidden = customFields.disabled = !custom;
    fetchButton.disabled = Boolean(pending);
    model.disabled = Boolean(pending) || model.options.length === 1;
    testButton.disabled = model.disabled || !model.value;
    saveButton.disabled = custom && testButton.disabled;
    clearButton.hidden = !custom || !saved;
  }

  function showModels(models, selected = '') {
    model.replaceChildren(new Option('请选择模型', ''), ...models.map(id => new Option(id, id)));
    model.value = models.includes(selected) ? selected : '';
    updateControls();
  }

  function cancelRequest() {
    pending?.abort();
    pending = undefined;
  }

  function show() {
    cancelRequest();
    mode.value = activeMode;
    baseUrl.value = saved?.baseUrl ?? '';
    apiKey.value = saved?.apiKey ?? '';
    apiKey.setCustomValidity('');
    showModels(saved ? [saved.model] : [], saved?.model);
    feedback();
    dialog.showModal();
  }

  mode.addEventListener('change', () => {
    cancelRequest();
    updateControls();
    feedback();
  });

  for (const field of [baseUrl, apiKey]) {
    field.addEventListener('input', () => {
      apiKey.setCustomValidity('');
      cancelRequest();
      showModels([]);
      feedback();
    });
  }
  model.addEventListener('change', () => {
    updateControls();
    feedback();
  });

  async function runCheck(loading, request, showResult) {
    const settings = connection();
    apiKey.setCustomValidity(settings.apiKey ? '' : '请输入 Token。');
    if (!baseUrl.reportValidity() || !apiKey.reportValidity()) return;
    const controller = new AbortController();
    pending = controller;
    updateControls();
    feedback(loading);
    try {
      const result = await request(settings, controller.signal);
      if (pending === controller && dialog.open) showResult(result);
    } catch (error) {
      if (pending === controller && dialog.open) feedback(error.message, true);
    } finally {
      if (pending === controller) {
        pending = undefined;
        updateControls();
      }
    }
  }

  fetchButton.addEventListener('click', () => runCheck(
    '正在获取模型列表…',
    (settings, signal) => requestModels(settings, fetch, { signal }),
    models => {
      showModels(models, model.value);
      feedback(`已获取 ${models.length} 个模型。`);
    }
  ));

  testButton.addEventListener('click', () => runCheck(
    '正在测试连接…',
    (settings, signal) => requestCompletion(
      { ...settings, model: model.value, timeoutMs: 30000 },
      [{ role: 'user', content: '你好！请用一句话打个招呼。' }],
      fetch, { signal }
    ),
    reply => feedback(`连接成功。模型回复「${reply.trim()}」`)
  ));

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (saveButton.disabled) return;
    const settings = mode.value === 'custom' ? { ...connection(), model: model.value } : saved;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ ...settings, mode: mode.value }));
    } catch {
      feedback('无法保存 AI 设置，请检查浏览器是否允许此网站保存数据。', true);
      return;
    }
    saved = settings;
    activeMode = mode.value;
    notice.hidden = activeMode === 'custom';
    dialog.close();
  });

  clearButton.addEventListener('click', () => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      feedback('无法清除 AI 设置，请检查浏览器的站点数据设置。', true);
      return;
    }
    saved = undefined;
    activeMode = 'default';
    notice.hidden = false;
    dialog.close();
  });

  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    cancelRequest();
    apiKey.value = '';
  });

  return { show, get current() { return activeMode === 'custom' ? saved : defaultApi; } };
}
