const roles = ['system', 'assistant', 'user'];

export function debugCommand(input) {
  const text = input.trim();
  if (!text.startsWith('【') || !text.endsWith('】')) return;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '【') depth++;
    if (text[index] === '】') {
      depth--;
      if (depth === 0 && index !== text.length - 1) return;
    }
  }
  if (depth === 0) return text.slice(1, -1).trim() || undefined;
}

function applies(item, stage) {
  return item.enabled !== false && (!item.stages || item.stages.includes(stage));
}

function selectEntries(worldbook, history, stage, scenario) {
  const scanDepth = worldbook.scanDepth ?? 6;
  const recent = scanDepth > 0 ? history.slice(-scanDepth) : [];
  const haystack = [scenario, ...recent.map(message => message.content)]
    .join('\n').toLowerCase();
  const entries = (worldbook.entries ?? [])
    .filter(entry => applies(entry, stage) && entry.content?.trim() &&
      (entry.always || entry.keys?.some(key => key.trim() && haystack.includes(key.trim().toLowerCase()))))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  let remaining = worldbook.maxChars ?? 6000;
  return entries.flatMap(entry => {
    const content = `【世界书·${entry.title}】\n${entry.content.trim()}`;
    if (content.length > remaining) return [];
    remaining -= content.length;
    return [{ ...entry, content }];
  });
}

export function buildMessages({ preset, worldbook, history, stage, scenario, dossier, session }) {
  const predefined = preset.messages
    .filter(item => applies(item, stage) && roles.includes(item.role) && item.content?.trim());
  const entries = selectEntries(worldbook, history, stage, scenario);
  const systemParts = [
    ...predefined.filter(item => item.role === 'system').map(item => item.content),
    ...entries.filter(item => (item.position ?? 'system') === 'system').map(item => item.content),
    dossier && `【本次病例底稿，仅模拟引擎可见】\n${JSON.stringify(dossier)}`,
    session && `【本轮模拟状态】\n${JSON.stringify(session)}`,
    preset.tasks[stage]
  ];
  const messages = [{ role: 'system', content: systemParts.filter(Boolean).join('\n\n') }];
  const examples = predefined.filter(item => item.role !== 'system');
  messages.push(...examples.map(({ role, content }) => ({ role, content })));

  // Keep the current user turn last, including for entries placed at depth zero.
  const lastIndex = Math.max(0, history.length - 1);
  const insertions = Array.from({ length: lastIndex + 1 }, () => []);
  for (const entry of entries) {
    let index;
    switch (entry.position) {
      case 'beforeHistory': index = 0; break;
      case 'afterHistory': index = lastIndex; break;
      case 'depth': index = Math.max(0, history.length - Math.max(1, Math.floor(entry.depth ?? 0))); break;
      default: continue;
    }
    insertions[index].push({ role: roles.includes(entry.role) ? entry.role : 'system', content: entry.content });
  }
  for (let index = 0; index < insertions.length; index++) {
    messages.push(...insertions[index]);
    if (history[index]) messages.push(history[index]);
  }
  return messages;
}

function readEnvelope(text, label) {
  try {
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // Avoid displaying raw model output. It may contain the concealed case.
  }
  throw new Error(`AI 返回的${label}格式无效，请重试。`);
}

export function parseCase(text) {
  const { dossier, opening, clarification, options, speciesOverride } = readEnvelope(text, '病例');
  if (!dossier && typeof clarification === 'string' && clarification.trim()) {
    return { clarification: clarification.trim() };
  }
  if (!dossier || typeof dossier.diagnosis !== 'string' || !dossier.diagnosis.trim() ||
      typeof opening !== 'string' || !opening.trim()) {
    throw new Error('AI 返回的病例资料不完整，请重试。');
  }
  const resolved = {};
  for (const key of ['emergency', 'treatment', 'comorbidity']) {
    if (typeof options?.[key] === 'boolean') resolved[key] = options[key];
  }
  if (Number.isInteger(options?.turnLimit) && options.turnLimit >= 1 && options.turnLimit <= 100) {
    resolved.turnLimit = options.turnLimit;
  }
  if (typeof options?.examLimit === 'string') resolved.examLimit = options.examLimit.slice(0, 150);
  return { dossier, opening: opening.trim(), options: resolved, speciesOverride: cleanText(speciesOverride) };
}

export function allowsCaseSpecies(settings, species, override) {
  if (species === '犬' || species === '猫') return true;
  return Boolean(cleanText(species) && cleanText(species) === override &&
    [settings.scopeDetail, settings.freeform].some(value => value?.includes(override)));
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const resultFlags = ['normal', 'high', 'low', 'abnormal'];

function normalizeReport(item) {
  const name = cleanText(item?.name);
  if (!name || !['physical', 'test'].includes(item.type)) return [];
  const rows = Array.isArray(item.rows) ? item.rows.flatMap(row => {
    const label = cleanText(row?.label);
    const value = Number.isFinite(row?.value) ? String(row.value) : cleanText(row?.value);
    if (!label || !value) return [];
    return [{
      label, value, unit: cleanText(row.unit), reference: cleanText(row.reference),
      flag: resultFlags.includes(row.flag) ? row.flag : ''
    }];
  }) : [];
  const sections = Array.isArray(item.sections) ? item.sections.flatMap(section => {
    const title = cleanText(section?.title);
    const text = cleanText(section?.text);
    return title && text ? [{ title, text }] : [];
  }) : [];
  const report = { type: item.type, name };
  if (rows.length) report.rows = rows;
  if (sections.length) report.sections = sections;
  if (rows.length || sections.length) return [report];
  const content = cleanText(item.content);
  return content ? [{ ...report, content }] : [];
}

export function parseTurn(text) {
  const { reply, phase, metaAttempt, results, hintGiven } = readEnvelope(text, '对话');
  if (typeof reply !== 'string' || !reply.trim()) throw new Error('AI 未返回对话内容，请重试。');
  const result = { reply: reply.trim(), phase, metaAttempt: metaAttempt === true };
  if (hintGiven === true) result.hintGiven = true;
  if (Array.isArray(results)) {
    result.results = results.flatMap(normalizeReport);
  }
  return result;
}

export function parseReview(text, notes = []) {
  const { summary, score, sections, noteFeedback } = readEnvelope(text, '复盘');
  const reportSections = Array.isArray(sections) ? sections.flatMap(section => {
    const title = cleanText(section?.title);
    const body = cleanText(section?.body);
    return title && body ? [{ title, body }] : [];
  }) : [];
  if (!cleanText(summary) || !Number.isFinite(score) || score < 0 || score > 100 || !reportSections.length) {
    throw new Error('AI 返回的复盘报告不完整，请重试。');
  }
  const evaluations = Array.isArray(noteFeedback) ? noteFeedback : [];
  const assessments = notes.map(({ turn }) => ({
    turn,
    feedback: cleanText(evaluations.find(item => item?.turn === turn && cleanText(item.feedback))?.feedback)
  }));
  if (assessments.some(item => !item.feedback)) throw new Error('AI 未完整评价接诊备注，请重新生成复盘。');
  return { summary: summary.trim(), score, sections: reportSections, noteFeedback: assessments };
}

export function publicPreview(text, field) {
  const prefix = text.trimStart().replace(/^\x60{3}(?:json)?\s*/i, '');
  const start = prefix.match(/^\{\s*"(opening|reply)"\s*:\s*"/);
  if (start?.[1] !== field) return { text: '', complete: false };
  // Decode only complete JSON string characters, including escapes split across chunks.
  const remainder = prefix.slice(start[0].length);
  const value = remainder.match(/^(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*/)[0];
  return {
    text: JSON.parse('"' + value + '"').replace(/[\uD800-\uDBFF]$/, ''),
    complete: remainder[value.length] === '"'
  };
}

async function readCompletionStream(body, onText) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop();
      if (done && buffer.trim()) events.push(buffer);
      for (const event of events) {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n').trim();
        if (!data) continue;
        if (data === '[DONE]') return text;
        const packet = JSON.parse(data);
        if (packet.error) throw new Error('流式回复出错，请重试。');
        const choice = packet.choices?.[0];
        if (choice?.finish_reason && choice.finish_reason !== 'stop') {
          throw new Error('模型未完整生成回复，请重试。');
        }
        if (choice?.finish_reason === 'stop') finished = true;
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta) {
          text += delta;
          onText?.(text);
        }
      }
      if (done) break;
    }
    if (!finished) throw new Error('流式连接中断，请重试。');
    return text;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function requestCompletion(api, messages, send = fetch, { onText, signal } = {}) {
  let endpoint;
  try {
    endpoint = new URL(api.baseUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error();
  } catch {
    throw new Error('请在 config/api.json 中填写有效的 API 地址。');
  }
  if (!api.model?.trim()) throw new Error('请在 config/api.json 中填写模型名称。');
  const path = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', ...api.headers };
  if (api.apiKey?.trim()) headers.Authorization = `Bearer ${api.apiKey.trim()}`;
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, api.timeoutMs ?? 90000);

  try {
    const stream = Boolean(onText) && api.stream !== false;

    let response;
    try {
      response = await send(endpoint.href, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({ ...api.parameters, model: api.model, messages, stream })
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timedOut || error.name === 'TimeoutError') throw new Error('API 请求超时，请重试。');
      throw new Error('无法连接 API。请检查接口地址及服务的跨域（CORS）设置。');
    }

    if (!response.ok) {
      const hints = {
        401: '请检查 config/api.json 中的 API Key。',
        403: '请检查令牌权限和接口的访问限制。',
        404: '请检查 API 地址和模型名。',
        429: '请检查额度或稍后重试。'
      };
      throw new Error(`API 请求失败（HTTP ${response.status}）。${hints[response.status] ?? '请重试。'}`);
    }
    let text;
    try {
      if (response.body && response.headers.get('content-type')?.includes('text/event-stream')) {
        text = await readCompletionStream(response.body, onText);
      } else {
        text = (await response.json())?.choices?.[0]?.message?.content;
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timedOut) throw new Error('API 请求超时，请重试。');
      if (error instanceof SyntaxError || error instanceof TypeError) {
        throw new Error('API 回复格式错误或连接中断，请重试。');
      }
      throw error;
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('API 未返回有效的助手消息，请检查模型与接口格式。');
    return text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
