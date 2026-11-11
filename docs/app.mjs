import {
  allowsCaseSpecies, buildMessages, debugCommand, parseCase, parseReview, parseTurn, publicPreview, requestCompletion
} from './chat.mjs';
import {
  caseMessages, caseReview, consultationHistory, createCase, helperContext, recordReview, recordTurn, reviewNotes
} from './cases.mjs';
import { openCaseStore } from './case-store.mjs';

const get = id => document.getElementById(id);
const form = get('settings');
const draft = get('draft');
const noteDraft = get('note-draft');
const assistantDraft = get('assistant-draft');
const assistantDialog = get('assistant-dialog');
const tabs = [...document.querySelectorAll('[data-tab]')];
const reviewButtons = [...document.querySelectorAll('[data-review]')];
const phaseLabels = { consultation: '接诊中', judgment: '诊断判断', review: '已复盘' };
const resultTypes = { physical: '体格检查', test: '辅助检查' };
const reportFlags = { normal: '正常', high: '↑ 偏高', low: '↓ 偏低', abnormal: '异常' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' });
const systemTopics = [
  ['如何开始接诊？', '在病例管理页点「新建病例」，设置好后点「生成病例」。查看宠物和主人档案后，点「开始接诊」。你扮演兽医，AI 扮演宠物家长。'],
  ['检查和复盘在哪看？', '在「接诊」中输入要执行的检查，报告会进入同一病例的「检查」。点「结束接诊并复盘」后，在「复盘」查看报告和每轮备注的评价。'],
  ['病例保存在哪里？', '病例、报告、对话和复盘保存在当前浏览器。回到病例管理后，点病例即可续诊。清除站点数据会清除本机病例。']
];
let store;
let config;
let configError;
let current;
let activeRequest;
let selectedTab = 'transcript';
let systemHistory = [];

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
  draft.value = '';
  noteDraft.value = '';
  assistantDraft.value = '';
  showScreen('library');
  libraryError();
  if (store) await loadLibrary();
}

async function openCase(id) {
  if (activeRequest) return;
  try {
    const record = await store.get(id);
    if (get('library').hidden || activeRequest || assistantDialog.open) return;
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
  draft.value = '';
  noteDraft.value = '';
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
}

function renderCase() {
  get('clinic-title').textContent = caseTitle(current);
  get('session-summary').textContent = [petLine(current), phaseLabels[current.phase]].filter(Boolean).join(' · ');
  get('messages').replaceChildren();
  for (const message of caseMessages(current)) {
    const row = appendMessage('', message.role, message.content, message.type, message.note).row;
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
  }
  renderResults();
  renderProfile();
  renderReview();
  renderControls();
  if (selectedTab === 'transcript') scrollMessages('');
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
  for (const [label, value] of [['接诊轮次', current.turns], ['检查项目', current.results.length], ['助手提示', current.hints]]) {
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
    const notes = new Map(reviewNotes(current).map(item => [item.turn, item.note]));
    for (const { turn, feedback: assessment } of report.noteFeedback) {
      const evaluation = element('section', 'review-note');
      evaluation.append(element('h4', '', `第 ${turn} 轮`), element('blockquote', '', notes.get(turn)));
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
  const label = outgoing ? (surface ? '你' : '你 · 兽医') :
    surface ? (current ? '病例助手' : '系统帮助') :
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
  get(surface ? 'assistant-messages' : 'messages').append(row);
  return { row, body };
}

function scrollMessages(surface) {
  const panel = get(surface ? 'assistant-scroll' : 'transcript');
  panel.scrollTop = panel.scrollHeight;
}

function refreshPersona() {
  form.elements.persona.hidden = form.elements.difficulty.value !== '难缠家长';
}

function readSettings() {
  const data = new FormData(form);
  return {
    scopeDetail: data.get('scopeDetail').trim(),
    difficulty: data.get('difficulty'),
    persona: data.get('difficulty') === '难缠家长' ? data.get('persona') : '',
    emergency: data.has('emergency'),
    treatment: data.has('treatment'),
    comorbidity: data.has('comorbidity')
  };
}

function renderControls() {
  const busy = Boolean(activeRequest);
  const canRequest = Boolean(config && store) && !busy;
  const reviewed = current?.phase === 'review';
  const limited = current?.settings.turnLimit && current.turns >= current.settings.turnLimit;
  const showStart = selectedTab === 'profile-panel' && current?.phase === 'consultation' && current.turns === 0;
  get('new-case').disabled = !store || busy;
  get('settings-fields').disabled = busy;
  get('start').disabled = !canRequest;
  get('start-consultation').hidden = !showStart;
  get('start-consultation').disabled = busy;
  get('send').disabled = !canRequest || !current || !draft.value.trim() || reviewed;
  for (const button of reviewButtons) {
    button.hidden = reviewed;
    button.disabled = !canRequest;
  }
  get('reviewed').hidden = !reviewed;
  get('chat-form').hidden = reviewed;
  draft.placeholder = limited ? '已达到轮次上限，可以结束接诊并复盘' : '问病史、安排检查或给出诊断判断…';
  get('assistant-send').disabled = !config || busy || !assistantDraft.value.trim();
  get('delete-case').disabled = busy;
  for (const button of document.querySelectorAll('[data-library], [data-assistant], #assistant-suggestions button')) {
    button.disabled = busy;
  }
  for (const button of document.querySelectorAll('[data-stop]')) button.hidden = Boolean(activeRequest?.committing);
  get('chat-controls').hidden = selectedTab !== 'transcript';
  get('composer').hidden = selectedTab !== 'transcript' && !showStart &&
    activeRequest?.surface !== '' && get('feedback').hidden;
}

function complete(stage, history, options = {}) {
  const { preset, worldbook, api } = config;
  const isolated = stage === 'helper' || stage === 'help';
  const request = activeRequest;
  const messages = buildMessages({
    preset: isolated ? { ...preset, messages: preset.messages.filter(item => item.stages?.includes(stage)) } : preset,
    worldbook: isolated ? {} : worldbook, stage, history, ...options
  });
  return requestCompletion(api, messages, fetch, {
    signal: request.controller.signal,
    onText: text => showPartial(request, stage, text)
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
  const panel = get(request.surface ? 'assistant-scroll' : 'transcript');
  const follow = !request.preview || panel.scrollHeight - panel.scrollTop - panel.clientHeight < 64;
  if (!request.preview) {
    request.preview = appendMessage(request.surface, 'assistant', '', stage === 'consultation' ? '' : stage);
    request.preview.row.setAttribute('aria-hidden', 'true');
  }
  request.preview.body.textContent = visible;
  if (follow) scrollMessages(request.surface);
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
  const scenario = JSON.stringify(settings);
  const history = [{ role: 'user', content: `请生成一个病例并开始接诊。病例设定：${scenario}` }];
  const response = parseCase(await complete('case', history, {
    scenario, session: { defaultSpecies: Math.random() < 0.5 ? '犬' : '猫' }
  }));
  if (response.clarification) throw new Error(response.clarification);
  if (!allowsCaseSpecies(settings, response.dossier.pet?.species, response.speciesOverride)) {
    throw new Error('模型未返回符合设定的物种。请重试。');
  }
  const record = createCase(settings, response.dossier, response.opening);
  beginSave(signal);
  enterCase(await store.add(record), 'profile-panel');
}

async function nextTurn(input, note, signal) {
  const record = current;
  const history = [...consultationHistory(record), { role: 'user', content: input }];
  activeRequest.userRow = appendMessage('', 'user', input, '', note).row;
  scrollMessages('');
  const state = {
    phase: record.phase,
    settings: { ...record.settings, persona: record.dossier.persona },
    turn: record.turns + 1,
    hints: record.hints,
    metaAttempts: record.metaAttempts
  };
  const result = parseTurn(await complete('consultation', history, {
    scenario: JSON.stringify(record.settings), dossier: record.dossier, session: state
  }));
  beginSave(signal);
  current = await store.save(recordTurn(record, input, result, note));
  if (draft.value.trim() === input) draft.value = '';
  if (noteDraft.value.trim() === note) noteDraft.value = '';
  renderCase();
}

async function finishReview(signal) {
  const record = current;
  const notes = reviewNotes(record);
  const history = [...consultationHistory(record), { role: 'user', content: '请生成本次接诊的复盘报告。' }];
  const report = parseReview(await complete('review', history, {
    scenario: JSON.stringify(record.settings), dossier: record.dossier,
    session: { turn: record.turns, hints: record.hints, metaAttempts: record.metaAttempts, notes }
  }), notes);
  beginSave(signal);
  current = await store.save(recordReview(record, report));
  draft.value = '';
  noteDraft.value = '';
  renderCase();
  if (selectedTab === 'review-panel') {
    get('review-panel').scrollTop = 0;
    get('review-title').focus({ preventScroll: true });
  }
}

async function nextDebug(text, instruction, signal) {
  const record = current;
  const request = { role: 'user', content: instruction };
  activeRequest.userRow = appendMessage('', 'user', text, 'debug').row;
  scrollMessages('');
  const recentDebug = record.history.filter(message => message.type === 'debug').slice(-8)
    .map(({ role, content }) => ({ role, content: role === 'user' ? debugCommand(content) ?? content : content }));
  const result = parseTurn(await complete('debug', [...consultationHistory(record), ...recentDebug, request], {
    scenario: JSON.stringify(record.settings), dossier: record.dossier,
    session: { ...helperContext(record), settings: record.settings, configuration: { preset: config.preset, worldbook: config.worldbook } }
  }));
  beginSave(signal);
  current = await store.save({
    ...record, history: [...record.history,
      { role: 'user', content: text, type: 'debug' }, { role: 'assistant', content: result.reply, type: 'debug' }]
  });
  if (draft.value.trim() === text) draft.value = '';
  renderCase();
}

function renderAssistant() {
  get('assistant-messages').replaceChildren();
  for (const message of current?.assistantHistory ?? systemHistory) {
    appendMessage('assistant-', message.role, message.content);
  }
  scrollMessages('assistant-');
}

function showAssistant() {
  const active = Boolean(current);
  get('assistant-title').textContent = active ? '病例助手' : '系统帮助';
  get('system-guide').hidden = active;
  get('assistant-intro').textContent = active
    ? `根据「${caseTitle(current)}」的接诊记录与已出报告提供提示。`
    : '有其他使用问题，可以在下方提问。';
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
  if (!active) get('assistant-scroll').scrollTop = 0;
}

function askAssistant(text, answer) {
  if (!text || activeRequest) return;
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
    const history = [...(record?.assistantHistory ?? systemHistory), question];
    activeRequest.userRow = appendMessage('assistant-', 'user', text).row;
    scrollMessages('assistant-');
    const stage = record ? 'helper' : 'help';
    const result = parseTurn(await complete(stage, history, { session: helperContext(record) }));
    if (signal.aborted) throw signal.reason;
    const updatedHistory = [...history, { role: 'assistant', content: result.reply }];
    if (record) {
      beginSave(signal);
      current = await store.save({
        ...record, assistantHistory: updatedHistory,
        hints: record.hints + Number(record.phase !== 'review' && result.hintGiven === true)
      });
    } else {
      systemHistory = updatedHistory;
    }
    if (assistantDraft.value.trim() === text) assistantDraft.value = '';
    renderAssistant();
  });
}

get('new-case').addEventListener('click', () => {
  form.reset();
  form.querySelector('details').open = false;
  refreshPersona();
  showScreen('create');
  feedback('create-', configError || (config ? '' : '正在加载配置…'), Boolean(configError));
});
for (const button of document.querySelectorAll('[data-library]')) button.addEventListener('click', showLibrary);
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
  if (!config || !current || activeRequest) return;
  const text = draft.value.trim();
  if (!text) return;
  const instruction = debugCommand(text);
  if (instruction) {
    runRequest('', '正在处理…', signal => nextDebug(text, instruction, signal));
  } else if (current.phase !== 'review') {
    if (current.settings.turnLimit && current.turns >= current.settings.turnLimit) {
      feedback('', '已达到轮次上限。可以结束接诊并复盘。');
      return;
    }
    const note = noteDraft.value.trim();
    runRequest('', '等待家长回复…', signal => nextTurn(text, note, signal));
  }
});
function startReview() {
  if (!config || !current || current.phase === 'review' || activeRequest) return;
  const unfinished = draft.value.trim() || noteDraft.value.trim();
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
assistantDialog.addEventListener('close', () => {
  if (activeRequest?.surface === 'assistant-' && !activeRequest.committing) activeRequest.controller.abort();
});
for (const field of [draft, assistantDraft]) {
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
  Promise.all(['preset', 'worldbook', 'api'].map(loadConfig)).then(([preset, worldbook, api]) => {
    if (!Array.isArray(preset?.messages) || !preset.tasks?.case || !preset.tasks?.help ||
        !Array.isArray(worldbook?.entries) || !api || typeof api !== 'object') {
      throw new Error('配置结构有误，请检查预设、世界书和 API 文件。');
    }
    config = { preset, worldbook, api };
    feedback('create-');
  }).catch(error => {
    configError = error.message;
    feedback('create-', configError, true);
    if (current) feedback('', configError, true);
  })
]);
