import {
  allowsCaseSpecies, bracketCommand, buildMessages, parseCase, parseCommandStage, parseReview, parseTurn, publicPreview, requestCompletion
} from './chat.mjs';
import {
  caseDifficulties, caseMessages, caseReview, clinicalHistory, createCase, helperContext, nextTurnNumber,
  recordReview, recordTurn, reviewNotes, rewindCase
} from './cases.mjs';
import { openCaseStore } from './case-store.mjs';
import { bindApiSettings } from './api-settings.mjs';

const get = id => document.getElementById(id);
const form = get('settings');
const draft = get('draft');
const noteDraft = get('note-draft');
const surgeryDraft = get('surgery-draft');
const surgeryNoteDraft = get('surgery-note-draft');
const clinicalDrafts = [draft, noteDraft, surgeryDraft, surgeryNoteDraft];
const assistantDraft = get('assistant-draft');
const assistantDialog = get('assistant-dialog');
const systemHelpDialog = get('system-help-dialog');
const apiSettingsDialog = get('api-settings-dialog');
const apiSettings = bindApiSettings(apiSettingsDialog, get('api-setup-notice'));
const messageEditor = get('message-editor');
const messageEditorDraft = get('message-editor-draft');
const tabs = [...document.querySelectorAll('[data-tab]')];
const reviewButtons = [...document.querySelectorAll('[data-review]')];
const phaseLabels = { consultation: '接诊中', judgment: '诊断判断', review: '已复盘' };
const clinicalLoading = { consultation: '等待家长回复…', surgery: '正在模拟手术…', review: '正在整理复盘报告…' };
const resultTypes = { physical: '体格检查', test: '辅助检查' };
const reportFlags = { normal: '正常', high: '↑ 偏高', low: '↓ 偏低', abnormal: '异常' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' });
const systemTopics = [
  ['怎么设置 AI 模型？', '在「病例管理」点「AI 设置」，填入 API 地址和 Token，点「获取模型列表」，选中模型后点「保存设置」。鉴权默认使用 Bearer Token，服务要求 mj-api-secret 时可切换。设置保存在当前浏览器，可在同一处清除。'],
  ['如何开始接诊？', '先在「病例管理」点「新建病例」。如果还没想好练什么，病例范围可以留空，两个难度也都能选「随机」。点「生成病例」，看过宠物和家长的档案，再点「开始接诊」。你来当兽医，AI 扮演宠物家长。'],
  ['如何重试同一个病例？', '想把同一个病例再练一遍，可以打开「档案」，点「删除病例」下方的「重试」。你会用同一份病例资料，从家长的第一句话重新开始。之前那一轮还可以在病例列表里找到。'],
  ['检查和复盘在哪看？', '做完检查后，点同一个病例里的「检查」就能看报告。练完后点「结束接诊并复盘」，再去「复盘」看反馈。你每轮写下的备注也会在那里得到评价。'],
  ['病例保存在哪里？', '病例和练习记录都存在你现在用的浏览器里。想接着练，回到「病例管理」，点开原来的病例就行。清除这个网站的浏览器数据也会清掉本机病例。']
];
const apiSetupHint = '请返回「病例管理」，在「AI 设置」中连接模型。';
let store;
let config;
let configError;
let current;
let activeRequest;
let selectedTab = 'transcript';
let systemHistory = [];
let editingMessage;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function feedback(surface, text = '', error = false) {
  const node = get(surface + 'feedback');
  node.textContent = text;
  node.hidden = !text;
  node.classList.toggle('error', error);
  renderControls();
}

function showScreen(id, focus = true) {
  for (const screen of ['library', 'create', 'clinic']) get(screen).hidden = screen !== id;
  if (focus) {
    const title = get(id).querySelector('h1');
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
  }
  renderControls();
}

function caseTitle(record) {
  return record.profile.pet.name || record.profile.pet.species || '未命名宠物';
}

function petLine(record) {
  const { species, breed, age } = record.profile.pet;
  return [species, breed, age].filter(Boolean).join(' · ');
}

function libraryError(message = '') {
  get('library-error').textContent = message;
  get('library-error').hidden = !message;
}

async function loadLibrary() {
  try {
    const cases = await store.list();
    const list = get('case-list');
    list.replaceChildren(...cases.map(record => {
      const item = element('li');
      const button = element('button', 'case-card');
      button.type = 'button';
      const icon = element('span', 'case-icon', record.profile.pet.species === '猫' ? '猫' :
        record.profile.pet.species === '犬' ? '犬' : '宠');
      icon.setAttribute('aria-hidden', 'true');
      const details = element('span', 'case-details');
      details.append(element('strong', '', caseTitle(record)), element('small', '', petLine(record)),
        element('small', 'case-date', `更新于 ${dateFormat.format(new Date(record.updatedAt))}`));
      button.append(icon, details, element('span', `status-chip ${record.phase}`, phaseLabels[record.phase]));
      button.addEventListener('click', () => openCase(record.id));
      item.append(button);
      return item;
    }));
    get('library-empty').hidden = Boolean(cases.length);
    get('library-empty-title').textContent = '还没有病例';
    get('library-empty-detail').textContent = '新建一个病例，开始第一次模拟接诊。';
  } catch {
    get('library-empty').hidden = true;
    libraryError('无法读取本机病例，请刷新页面重试。');
  }
}

async function showLibrary() {
  current = undefined;
  for (const field of clinicalDrafts) field.value = '';
  assistantDraft.value = '';
  showScreen('library');
  libraryError();
  if (store) await loadLibrary();
}

async function openCase(id) {
  if (activeRequest) return;
  try {
    const record = await store.get(id);
    if (get('library').hidden || activeRequest || assistantDialog.open || systemHelpDialog.open || apiSettingsDialog.open) return;
    if (!record) {
      await loadLibrary();
      libraryError('这份病例已删除。');
      return;
    }
    enterCase(record);
  } catch {
    libraryError('无法打开病例，请重试。');
  }
}

function enterCase(record, initialTab = 'transcript') {
  current = record;
  for (const field of clinicalDrafts) field.value = '';
  assistantDraft.value = '';
  feedback('', configError, Boolean(configError));
  selectTab(initialTab);
  renderCase();
  showScreen('clinic');
  if (initialTab === 'transcript') scrollMessages('');
  else get(initialTab).scrollTop = 0;
}

function selectTab(id) {
  selectedTab = id;
  for (const button of tabs) {
    const selected = button.dataset.tab === id;
    button.setAttribute('aria-pressed', String(selected));
    get(button.dataset.tab).hidden = !selected;
  }
  renderControls();
  if (id === 'surgery-panel') scrollMessages('surgery-');
}

function renderCase() {
  get('clinic-title').textContent = caseTitle(current);
  const difficulty = current.settings.caseDifficulty;
  get('session-summary').textContent = [petLine(current), difficulty && `病例 ${difficulty}`, phaseLabels[current.phase]]
    .filter(Boolean).join(' · ');
  get('messages').replaceChildren();
  get('surgery-messages').replaceChildren();
  const messages = caseMessages(current);
  const editable = current.phase !== 'review';
  for (const message of messages) {
    const surface = message.stage === 'surgery' ? 'surgery-' : '';
    const row = appendMessage(surface, message.role, message.content, message.type, message.note).row;
    const findings = !message.type && message.role === 'assistant' && message.turn
      ? current.results.filter(result => result.turn === message.turn) : [];
    if (findings.length) {
      const button = element('button', 'text-button result-link', `查看本轮 ${findings.length} 项检查 ›`);
      button.type = 'button';
      button.addEventListener('click', () => {
        selectTab('results-panel');
        const report = get(`exam-result-${current.results.indexOf(findings[0])}`);
        report.scrollIntoView({ block: 'start' });
        report.focus({ preventScroll: true });
      });
      row.append(button);
    }
    if (editable) addMessageActions(row, surface, message, message.role === 'user');
  }
  renderResults();
  renderProfile();
  renderReview();
  renderControls();
  if (selectedTab === 'transcript') scrollMessages('');
  if (selectedTab === 'surgery-panel') scrollMessages('surgery-');
}

function renderReview() {
  const report = caseReview(current);
  const content = get('review-content');
  get('review-empty').hidden = Boolean(report);
  content.hidden = !report;
  content.replaceChildren();
  if (!report) return;

  const overview = element('header', 'review-overview');
  const heading = element('div', 'review-heading');
  const title = element('h2', '', '接诊复盘报告');
  title.id = 'review-title';
  title.tabIndex = -1;
  heading.append(title);
  if (report.score !== undefined) {
    const score = element('div', 'review-score');
    score.append(element('strong', '', String(report.score)), element('span', '', '/ 100 分'));
    heading.append(score);
  }
  overview.append(heading);
  if (report.summary) overview.append(element('p', 'review-summary', report.summary));
  const stats = element('dl', 'review-stats');
  const counts = [['接诊轮次', current.turns], ['检查项目', current.results.length], ['助手提示', current.hints]];
  if (current.surgeryTurns) counts.splice(1, 0, ['手术轮次', current.surgeryTurns]);
  for (const [label, value] of counts) {
    const stat = element('div');
    stat.append(element('dt', '', label), element('dd', '', String(value)));
    stats.append(stat);
  }
  overview.append(stats);
  content.append(overview);

  const diagnosis = element('section', 'review-card diagnosis');
  diagnosis.append(element('h3', '', '病例公布'), element('p', '', current.dossier.diagnosis));
  content.append(diagnosis);
  if (report.legacyText) {
    const legacy = element('section', 'review-card');
    appendFormatted(legacy, report.legacyText);
    content.append(legacy);
    return;
  }
  for (const { title, body } of report.sections) {
    const section = element('section', 'review-card');
    section.append(element('h3', '', title));
    appendFormatted(section, body);
    content.append(section);
  }
  if (report.noteFeedback.length) {
    const feedback = element('section', 'review-card');
    feedback.append(element('h3', '', '想法与备注评价'));
    const notes = new Map(reviewNotes(current).map(item => [item.turn, item]));
    for (const { turn, feedback: assessment } of report.noteFeedback) {
      const evaluation = element('section', 'review-note');
      const note = notes.get(turn);
      evaluation.append(element('h4', '', `${note?.stage === 'surgery' ? '手术 · ' : ''}第 ${turn} 轮`),
        element('blockquote', '', note?.note));
      appendFormatted(evaluation, assessment);
      feedback.append(evaluation);
    }
    content.append(feedback);
  }
}

function renderProfile() {
  const { pet, owners } = current.profile;
  const card = (title, pairs) => {
    const section = element('section', 'profile-card');
    const fields = element('dl', 'profile-fields');
    for (const [key, value] of pairs) {
      const field = element('div');
      field.append(element('dt', '', key), element('dd', '', value || '未记录'));
      fields.append(field);
    }
    section.append(element('h2', '', title), fields);
    return section;
  };
  const petCard = card('宠物资料', [
    ['名字', pet.name], ['物种', pet.species], ['品种', pet.breed], ['年龄', pet.age],
    ['性别', pet.sex], ['绝育情况', pet.neutered], ['体重', pet.weight]
  ]);
  const ownerCards = owners.length ? owners.map((owner, index) => card(
    index === 0 ? '主人资料 · 主要联系人' : `家庭成员 ${index + 1}`,
    [['称呼', owner.name], ['关系', owner.relationship], ['性别', owner.gender], ['年龄', owner.age], ['性格', owner.personality]]
  )) : [card('主人资料', [['联系人', '']])];
  get('profile-content').replaceChildren(petCard, ...ownerCards);
}

function renderResults() {
  const results = current.results;
  get('result-count').textContent = results.length;
  get('result-count').hidden = !results.length;
  get('results-empty').hidden = Boolean(results.length);
  get('result-list').replaceChildren(...results.map((result, index) => {
    const card = element('article', 'result-card');
    card.id = `exam-result-${index}`;
    card.tabIndex = -1;
    const heading = element('div', 'result-heading');
    heading.append(element('span', 'result-kind', resultTypes[result.type]),
      element('span', 'result-round', `第 ${result.turn} 轮`));
    card.append(heading, element('h2', '', result.name));
    if (result.rows) card.append(reportTable(result));
    for (const section of result.sections ?? []) {
      const block = element('section', 'report-section');
      block.append(element('h3', '', section.title));
      appendFormatted(block, section.text);
      card.append(block);
    }
    if (result.content) appendFormatted(card, result.content);
    return card;
  }));
}

function reportTable(report) {
  const wrapper = element('div', 'report-table-wrap');
  const table = element('table', 'report-table');
  table.setAttribute('aria-label', report.name);
  const header = table.createTHead().insertRow();
  for (const title of ['项目', '结果', '参考区间', '标记']) {
    const cell = element('th', '', title);
    cell.scope = 'col';
    header.append(cell);
  }
  const body = table.createTBody();
  for (const item of report.rows) {
    const row = body.insertRow();
    const label = element('th', '', item.label);
    label.scope = 'row';
    row.append(label, element('td', '', [item.value, item.unit].filter(Boolean).join(' ')),
      element('td', '', item.reference || '—'),
      element('td', item.flag ? `report-flag ${item.flag}` : '', reportFlags[item.flag] ?? '—'));
  }
  wrapper.append(table);
  return wrapper;
}

function appendFormatted(body, content) {
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const heading = line.match(/^#{1,6}\s+(.+)/);
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    const row = element(heading ? 'h3' : 'p', bullet ? 'review-bullet' : '');
    const parts = ((heading ?? bullet)?.[1] ?? line).split(/\*\*([^*]+)\*\*/);
    for (const [index, part] of parts.entries()) {
      row.append(index % 2 ? element('strong', '', part) : document.createTextNode(part));
    }
    body.append(row);
  }
}

function appendMessage(surface, role, text, type = '', note = '') {
  const outgoing = role === 'user';
  const assistant = surface === 'assistant-';
  const label = outgoing ? (assistant ? '你' : '你 · 兽医') :
    assistant ? (current ? '病例助手' : '助手') :
      surface === 'surgery-' ? '手术模拟' :
      type === 'debug' ? '系统调试' : '宠物家长';
  const row = element('article', `message ${outgoing ? 'doctor' : 'owner'} ${type}`);
  const identity = element('div', 'message-identity', label);
  const body = element('div', 'bubble');
  if (!outgoing && (surface || type)) appendFormatted(body, text);
  else body.textContent = text;
  row.append(identity);
  if (note) {
    const annotation = element('aside', 'message-note');
    annotation.append(element('strong', '', '想法 / 备注'), element('p', '', note));
    row.append(annotation);
  }
  row.append(body);
  get(surface + 'messages').append(row);
  return { row, body };
}

function addMessageActions(row, surface, message, canRetry) {
  const actions = element('div', 'message-actions');
  const edit = element('button', 'text-button', '修改');
  const remove = element('button', 'text-button', '删除');
  edit.type = remove.type = 'button';
  edit.addEventListener('click', () => {
    if (activeRequest || messageEditor.open) return;
    editingMessage = { surface, message };
    if (message.role === 'user') messageEditorDraft.maxLength = 3000;
    else messageEditorDraft.removeAttribute('maxlength');
    messageEditorDraft.value = message.content;
    messageEditor.showModal();
  });
  remove.addEventListener('click', () => {
    if (!activeRequest && window.confirm('删除这条消息？')) changeMessage(surface, message);
  });
  actions.append(edit, remove);
  if (canRetry) {
    const retry = element('button', 'text-button', '重试');
    retry.type = 'button';
    retry.dataset.retryMessage = '';
    retry.addEventListener('click', () => retryMessage(surface, message));
    actions.append(retry);
  }
  row.append(actions);
}

function changeMessage(surface, message, content) {
  const assistant = surface === 'assistant-';
  const record = current;
  if (!assistant && (!record || record.phase === 'review')) return;
  const history = assistant ? record?.assistantHistory ?? systemHistory : record.history;
  const index = history.indexOf(message);
  if (activeRequest || index < 0 || content === message.content) return;
  const updated = [...history];
  if (content === undefined) updated.splice(index, 1);
  else updated[index] = { ...message, content };
  const panel = messagePanel(surface);
  const scrollTop = panel.scrollTop;
  if (!record) {
    systemHistory = updated;
    renderAssistant();
    panel.scrollTop = scrollTop;
    return;
  }
  runRequest(assistant ? 'assistant-' : '', '正在保存…', async signal => {
    beginSave(signal);
    current = await store.save(assistant
      ? { ...record, assistantHistory: updated }
      : { ...record, history: updated, opening: record.opening ?? history[0]?.content ?? '' });
    if (assistant) renderAssistant();
    else renderCase();
    panel.scrollTop = scrollTop;
  });
}

function retryMessage(surface, message) {
  if (!config || activeRequest || message.role !== 'user') return;
  if (surface === 'assistant-') {
    const history = current?.assistantHistory ?? systemHistory;
    const index = history.indexOf(message);
    if (index < 0) return;
    if (index < history.length - 1 && !window.confirm('重试成功后，这条消息之后的对话将被删除。继续重试？')) return;
    askAssistant(message.content, undefined, index);
    return;
  }
  if (!current || current.phase === 'review' || !current.history.includes(message)) return;
  const command = bracketCommand(message.content);
  const retry = !command && message.type !== 'debug';
  const record = rewindCase(current, message, { includeMessage: retry });
  const hasLater = caseMessages(current).at(-1) !== message || record.results.length < current.results.length;
  if (hasLater && !window.confirm('重试成功后，这条消息之后的接诊和手术对话及相关检查将被删除。继续重试？')) return;
  const sourceStage = message.stage ?? 'consultation';
  runRequest('', command ? '正在理解命令…' : '正在重试…', signal =>
    runClinicalInput(message.content, message.note ?? '', signal, { sourceStage, command, record, retry }));
}

function scrollMessages(surface) {
  const panel = messagePanel(surface);
  panel.scrollTop = panel.scrollHeight;
}

function messagePanel(surface) {
  return get(surface === 'assistant-' ? 'assistant-scroll' : surface === 'surgery-' ? 'surgery-panel' : 'transcript');
}

function refreshPersona() {
  form.elements.persona.hidden = form.elements.difficulty.value !== '难缠家长';
}

function readSettings() {
  const data = new FormData(form);
  const selectedDifficulty = data.get('difficulty');
  let difficulty = selectedDifficulty;
  if (selectedDifficulty === '随机') {
    const levels = Array.from(form.elements.difficulty.options, option => option.value)
      .filter(level => level !== '随机');
    difficulty = levels[Math.floor(Math.random() * levels.length)];
  }
  return {
    scopeDetail: data.get('scopeDetail').trim(),
    caseDifficulty: data.get('caseDifficulty'),
    difficulty,
    persona: selectedDifficulty === '难缠家长' ? data.get('persona') : '',
    emergency: data.has('emergency'),
    treatment: data.has('treatment'),
    comorbidity: data.has('comorbidity')
  };
}

function renderControls() {
  const busy = Boolean(activeRequest);
  const canRequest = Boolean(config && store) && !busy;
  const reviewed = current?.phase === 'review';
  const inSurgery = selectedTab === 'surgery-panel';
  const limited = current?.settings.turnLimit && current.turns >= current.settings.turnLimit;
  const showStart = selectedTab === 'profile-panel' && current?.phase === 'consultation' && current.turns === 0;
  get('new-case').disabled = !store || busy;
  get('settings-fields').disabled = busy;
  get('start').disabled = !canRequest;
  get('start-consultation').hidden = !showStart;
  get('start-consultation').disabled = busy;
  get('send').disabled = !canRequest || !current || !draft.value.trim() || reviewed;
  get('surgery-send').disabled = !canRequest || !current || !surgeryDraft.value.trim() || reviewed;
  for (const button of reviewButtons) {
    button.hidden = reviewed;
    button.disabled = !canRequest;
  }
  get('reviewed').hidden = !reviewed;
  get('chat-form').hidden = reviewed;
  get('surgery-form').hidden = reviewed;
  get('surgery-empty').hidden = get('surgery-messages').childElementCount > 0;
  get('surgery-empty-hint').hidden = reviewed;
  draft.placeholder = limited ? '已达到轮次上限，可以结束接诊并复盘' : '问病史、安排检查或给出诊断判断…';
  get('assistant-send').disabled = !config || busy || !assistantDraft.value.trim();
  get('delete-case').disabled = busy;
  get('retry-case').disabled = !store || !current || busy;
  for (const button of document.querySelectorAll('[data-library], [data-assistant], #assistant-suggestions button')) {
    button.disabled = busy;
  }
  for (const button of document.querySelectorAll('.message-actions button')) {
    button.disabled = busy || (button.hasAttribute('data-retry-message') && !config);
  }
  for (const button of document.querySelectorAll('[data-stop]')) button.hidden = Boolean(activeRequest?.committing);
  get('chat-controls').hidden = selectedTab !== 'transcript';
  get('surgery-controls').hidden = !inSurgery || reviewed;
  get('composer').hidden = selectedTab !== 'transcript' && (!inSurgery || reviewed) && !showStart &&
    activeRequest?.surface !== '' && get('feedback').hidden;
}

function complete(stage, history, options = {}) {
  const api = apiSettings.current;
  if (!api) throw new Error(apiSetupHint);
  const { preset, worldbook } = config;
  const isolated = ['helper', 'help', 'command'].includes(stage);
  const request = activeRequest;
  const messages = buildMessages({
    preset: isolated ? { ...preset, messages: preset.messages.filter(item => item.stages?.includes(stage)) } : preset,
    worldbook: isolated ? {} : worldbook, stage, history, ...options
  });
  return requestCompletion(api, messages, fetch, {
    signal: request.controller.signal,
    onText: stage === 'command' ? undefined : text => showPartial(request, stage, text)
  });
}

function showPartial(request, stage, text) {
  if (stage === 'review' || request.controller.signal.aborted) return;
  const visible = publicPreview(text, stage === 'case' ? 'opening' : 'reply').text;
  if (!visible.trim() || visible === request.visible) return;
  request.visible = visible;
  if (stage === 'case') {
    get('create-preview').textContent = visible;
    get('create-preview').hidden = false;
    return;
  }
  const surface = stage === 'surgery' ? 'surgery-' : request.surface;
  const panel = messagePanel(surface);
  const follow = !request.preview || panel.scrollHeight - panel.scrollTop - panel.clientHeight < 64;
  if (!request.preview) {
    request.preview = appendMessage(surface, 'assistant', '', stage === 'consultation' ? '' : stage);
    request.preview.row.setAttribute('aria-hidden', 'true');
  }
  request.preview.body.textContent = visible;
  if (follow) scrollMessages(surface);
}

async function runRequest(surface, loading, task) {
  if (activeRequest) return;
  const request = { surface, controller: new AbortController() };
  activeRequest = request;
  const status = get(surface + 'request-status');
  status.hidden = false;
  get(surface + 'request-label').textContent = loading;
  feedback(surface);
  try {
    await task(request.controller.signal);
  } catch (error) {
    feedback(surface, request.controller.signal.aborted ? '已停止。' : error.message, !request.controller.signal.aborted);
  } finally {
    request.userRow?.remove();
    request.preview?.row.remove();
    get('create-preview').hidden = true;
    activeRequest = undefined;
    status.hidden = true;
    renderControls();
  }
}

function beginSave(signal, label = '正在保存到本机…') {
  if (signal.aborted) throw signal.reason;
  activeRequest.committing = true;
  get(activeRequest.surface + 'request-label').textContent = label;
  renderControls();
}

async function startCase(settings, signal) {
  const random = settings.caseDifficulty === '随机';
  const preferredCaseDifficulty = random
    ? caseDifficulties[Math.floor(Math.random() * caseDifficulties.length)] : settings.caseDifficulty;
  const scenario = JSON.stringify(settings);
  const history = [{ role: 'user', content: `请生成一个病例并开始接诊。病例设定：${scenario}` }];
  const response = parseCase(await complete('case', history, {
    scenario, session: { defaultSpecies: Math.random() < 0.5 ? '犬' : '猫', preferredCaseDifficulty }
  }));
  if (response.clarification) throw new Error(response.clarification);
  if (!allowsCaseSpecies(settings, response.dossier.pet?.species, response.speciesOverride)) {
    throw new Error('模型未返回符合设定的物种。请重试。');
  }
  const caseDifficulty = random && settings.scopeDetail && caseDifficulties.includes(response.caseDifficulty)
    ? response.caseDifficulty : preferredCaseDifficulty;
  const record = createCase({ ...settings, caseDifficulty }, response.dossier, response.opening);
  beginSave(signal);
  enterCase(await store.add(record), 'profile-panel');
}

async function nextTurn(input, note, signal, stage, record, retry) {
  const surgery = stage === 'surgery';
  const surface = surgery ? 'surgery-' : '';
  const turn = retry ? record.history.at(-1).turn : nextTurnNumber(record);
  const context = retry ? { ...record, history: record.history.slice(0, -1) } : record;
  const history = [...clinicalHistory(context, stage), { role: 'user', content: input }];
  if (!retry) activeRequest.userRow = appendMessage(surface, 'user', input, '', note).row;
  if (surgery) renderControls();
  scrollMessages(surface);
  const state = {
    phase: record.phase,
    settings: { ...record.settings, persona: record.dossier.persona },
    turn,
    hints: record.hints,
    metaAttempts: record.metaAttempts
  };
  const result = parseTurn(await complete(stage, history, {
    scenario: JSON.stringify(record.settings), dossier: record.dossier, session: state
  }));
  beginSave(signal);
  current = await store.save(recordTurn(record, input, result, note, stage, retry));
  renderCase();
}

async function runClinicalInput(input, note, signal, { sourceStage, command, record = current, retry = false }) {
  let stage = sourceStage;
  if (command) {
    const history = [...clinicalHistory(record).slice(-6), { role: 'user', content: command }];
    stage = parseCommandStage(await complete('command', history, { session: { sourceStage } }));
    if (signal.aborted) throw signal.reason;
    get('request-label').textContent = clinicalLoading[stage];
  }
  if (stage === 'review') {
    if (!window.confirm('结束本病例接诊并生成复盘？')) return false;
    selectTab('review-panel');
    await finishReview(signal, record, input);
    return true;
  }
  if (!retry && stage === 'consultation' && record.settings.turnLimit && record.turns >= record.settings.turnLimit) {
    feedback('', '已达到轮次上限。可以结束接诊并复盘。');
    return false;
  }
  if (stage === 'surgery' || stage !== sourceStage) selectTab(stage === 'surgery' ? 'surgery-panel' : 'transcript');
  await nextTurn(input, note, signal, stage, record, retry);
  return true;
}

function submitClinicalTurn(field, noteField, sourceStage) {
  if (!config || !current || current.phase === 'review' || activeRequest) return;
  const input = field.value.trim();
  if (!input) return;
  const command = bracketCommand(input);
  const note = noteField.value.trim();
  runRequest('', command ? '正在理解命令…' : clinicalLoading[sourceStage], async signal => {
    if (!await runClinicalInput(input, note, signal, { sourceStage, command })) return;
    if (field.value.trim() === input) field.value = '';
    if (noteField.value.trim() === note) noteField.value = '';
  });
}

async function finishReview(signal, record = current, input = '请生成本病例的复盘报告。') {
  const notes = reviewNotes(record);
  const history = [...clinicalHistory(record), { role: 'user', content: input }];
  const report = parseReview(await complete('review', history, {
    scenario: JSON.stringify(record.settings), dossier: record.dossier,
    session: {
      caseDifficulty: record.settings.caseDifficulty,
      turn: record.turns, surgeryTurns: record.surgeryTurns ?? 0,
      hints: record.hints, metaAttempts: record.metaAttempts, notes
    }
  }), notes);
  beginSave(signal);
  current = await store.save(recordReview(record, report));
  for (const field of clinicalDrafts) field.value = '';
  renderCase();
  if (selectedTab === 'review-panel') {
    get('review-panel').scrollTop = 0;
    get('review-title').focus({ preventScroll: true });
  }
}

function renderAssistant() {
  get('assistant-messages').replaceChildren();
  const history = current?.assistantHistory ?? systemHistory;
  for (const message of history) {
    const { row } = appendMessage('assistant-', message.role, message.content);
    addMessageActions(row, 'assistant-', message, message.role === 'user');
  }
  scrollMessages('assistant-');
  renderControls();
}

function showAssistant() {
  const active = Boolean(current);
  get('assistant-title').textContent = active ? '病例助手' : '助手';
  get('assistant-intro').textContent = active
    ? `如果接诊「${caseTitle(current)}」时卡住了，可以和我一起看看下一步怎么问。`
    : '第一次来，或者找不到某个入口？告诉我你想做什么，我陪你一步步找。';
  assistantDraft.placeholder = active ? '问当前病例的接诊思路…' : '输入平台使用问题…';
  const topics = active ? [['下一步怎么问？'], ['这份病例还漏了哪些信息？']] : systemTopics;
  get('assistant-suggestions').replaceChildren(...topics.map(([question, answer]) => {
    const button = element('button', 'soft', question);
    button.type = 'button';
    button.addEventListener('click', () => askAssistant(question, answer));
    return button;
  }));
  feedback('assistant-', configError, Boolean(configError));
  assistantDialog.showModal();
  renderAssistant();
}

function askAssistant(text, answer, retryIndex = -1) {
  if (!text || activeRequest) return;
  const retry = retryIndex >= 0;
  const question = { role: 'user', content: text };
  if (!current && answer) {
    systemHistory.push(question, { role: 'assistant', content: answer });
    renderAssistant();
    return;
  }
  if (!config) {
    feedback('assistant-', configError || '正在加载助手配置，请稍后重试。', Boolean(configError));
    return;
  }
  runRequest('assistant-', '正在回复…', async signal => {
    const record = current;
    const previous = record?.assistantHistory ?? systemHistory;
    const history = retry ? previous.slice(0, retryIndex + 1) : [...previous, question];
    if (!retry) activeRequest.userRow = appendMessage('assistant-', 'user', text).row;
    scrollMessages('assistant-');
    const stage = record ? 'helper' : 'help';
    const messages = history.map(({ role, content }) => ({ role, content }));
    const result = parseTurn(await complete(stage, messages, { session: helperContext(record) }));
    if (signal.aborted) throw signal.reason;
    const hintGiven = Boolean(record && record.phase !== 'review' && result.hintGiven === true);
    const removedHints = retry ? previous.slice(retryIndex + 1).filter(message => message.hintGiven).length : 0;
    const updatedHistory = [...history, { role: 'assistant', content: result.reply, ...(hintGiven && { hintGiven }) }];
    if (record) {
      beginSave(signal);
      current = await store.save({
        ...record, assistantHistory: updatedHistory,
        hints: Math.max(0, record.hints - removedHints) + Number(hintGiven)
      });
    } else {
      systemHistory = updatedHistory;
    }
    if (!retry && assistantDraft.value.trim() === text) assistantDraft.value = '';
    renderAssistant();
  });
}

get('new-case').addEventListener('click', () => {
  if (!apiSettings.current) {
    apiSettings.show();
    return;
  }
  form.reset();
  form.querySelector('details').open = false;
  refreshPersona();
  showScreen('create');
  feedback('create-', configError || (config ? '' : '正在加载配置…'), Boolean(configError));
});
for (const button of document.querySelectorAll('[data-library]')) button.addEventListener('click', showLibrary);
get('open-api-settings').addEventListener('click', apiSettings.show);
get('open-system-help').addEventListener('click', () => {
  systemHelpDialog.showModal();
  get('system-guide').scrollTop = 0;
});
for (const button of document.querySelectorAll('[data-assistant]')) button.addEventListener('click', showAssistant);
for (const button of document.querySelectorAll('[data-stop]')) {
  button.addEventListener('click', () => activeRequest?.controller.abort());
}
for (const button of tabs) button.addEventListener('click', () => selectTab(button.dataset.tab));
get('start-consultation').addEventListener('click', () => {
  selectTab('transcript');
  get('transcript').focus({ preventScroll: true });
});
form.elements.difficulty.addEventListener('change', refreshPersona);
form.addEventListener('submit', event => {
  event.preventDefault();
  if (!config || !store || activeRequest) return;
  const settings = readSettings();
  runRequest('create-', '正在生成病例…', signal => startCase(settings, signal));
});
get('chat-form').addEventListener('submit', event => {
  event.preventDefault();
  submitClinicalTurn(draft, noteDraft, 'consultation');
});
get('surgery-form').addEventListener('submit', event => {
  event.preventDefault();
  submitClinicalTurn(surgeryDraft, surgeryNoteDraft, 'surgery');
});
function startReview() {
  if (!config || !current || current.phase === 'review' || activeRequest) return;
  if (!apiSettings.current) {
    feedback('', apiSetupHint, true);
    return;
  }
  const unfinished = clinicalDrafts.some(field => field.value.trim());
  if (!window.confirm(unfinished ? '还有未发送的消息或备注。确定结束接诊并生成复盘？' : '结束本病例接诊并生成复盘？')) return;
  selectTab('review-panel');
  runRequest('', '正在整理复盘报告…', finishReview);
}
for (const button of reviewButtons) button.addEventListener('click', startReview);
get('reviewed').addEventListener('click', () => {
  selectTab('review-panel');
  get('review-title')?.focus({ preventScroll: true });
});
get('assistant-form').addEventListener('submit', event => {
  event.preventDefault();
  askAssistant(assistantDraft.value.trim());
});
get('message-editor-form').addEventListener('submit', event => {
  event.preventDefault();
  const content = messageEditorDraft.value.trim();
  messageEditorDraft.setCustomValidity(content ? '' : '请输入消息内容。');
  if (!messageEditorDraft.reportValidity() || !editingMessage) return;
  const { surface, message } = editingMessage;
  messageEditor.close();
  changeMessage(surface, message, content);
});
messageEditorDraft.addEventListener('input', () => messageEditorDraft.setCustomValidity(''));
messageEditor.addEventListener('close', () => {
  messageEditorDraft.setCustomValidity('');
  editingMessage = undefined;
});
assistantDialog.addEventListener('close', () => {
  if (activeRequest?.surface === 'assistant-' && !activeRequest.committing) activeRequest.controller.abort();
});
for (const field of [draft, surgeryDraft, assistantDraft]) {
  field.addEventListener('input', renderControls);
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      field.form.requestSubmit();
    }
  });
}
get('delete-case').addEventListener('click', () => {
  if (!current || activeRequest || !window.confirm(`删除「${caseTitle(current)}」及其全部接诊记录？此操作无法撤销。`)) return;
  runRequest('', '正在删除病例…', async signal => {
    beginSave(signal, '正在删除病例…');
    await store.remove(current.id, current.revision);
    await showLibrary();
  });
});
get('retry-case').addEventListener('click', () => {
  if (!store || !current || activeRequest) return;
  const { settings, dossier, history, profile, opening } = current;
  runRequest('', '正在复制病例…', async signal => {
    const record = createCase(settings, dossier, opening ?? history[0]?.content ?? '', profile);
    beginSave(signal, '正在复制病例…');
    enterCase(await store.add(record));
  });
});

async function loadConfig(name) {
  const response = await fetch(`./config/${name}.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`无法读取 config/${name}.json（HTTP ${response.status}）。`);
  return response.json().catch(() => {
    throw new Error(`config/${name}.json 格式有误，请检查 JSON 语法。`);
  });
}

function resizeForKeyboard() {
  const viewport = window.visualViewport;
  const style = document.documentElement.style;
  if (viewport.scale !== 1) {
    for (const name of ['height', 'top', 'bottom']) style.removeProperty(`--viewport-${name}`);
    return;
  }
  style.setProperty('--viewport-height', `${viewport.height}px`);
  style.setProperty('--viewport-top', `${viewport.offsetTop}px`);
  style.setProperty('--viewport-bottom', `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`);
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', resizeForKeyboard);
  window.visualViewport.addEventListener('scroll', resizeForKeyboard);
  resizeForKeyboard();
}

renderControls();
await Promise.all([
  openCaseStore().then(async repository => {
    store = repository;
    renderControls();
    await loadLibrary();
  }).catch(() => {
    get('library-empty').hidden = true;
    libraryError('无法打开本机存储。请确认浏览器允许此网站保存数据后刷新重试。');
  }),
  Promise.all(['preset', 'worldbook'].map(loadConfig)).then(([preset, worldbook]) => {
    if (!Array.isArray(preset?.messages) || !preset.tasks?.case || !preset.tasks?.help || !preset.tasks?.surgery ||
        !preset.tasks?.command ||
        !Array.isArray(worldbook?.entries)) {
      throw new Error('配置结构有误，请检查预设和世界书文件。');
    }
    config = { preset, worldbook };
    feedback('create-');
  }).catch(error => {
    configError = error.message;
    feedback('create-', configError, true);
    if (current) feedback('', configError, true);
  })
]);
