import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowsCaseSpecies, bracketCommand, buildMessages, parseCase, parseCommandStage, parseTurn, publicPreview,
  requestCompletion, requestModels
} from '../docs/chat.mjs';

test('模型列表和对话请求使用同一 API 路径、鉴权方式和所选模型', async () => {
  const api = {
    baseUrl: 'https://example.test/proxy/v1/chat/completions/?api-version=example',
    apiKey: ' example-token ',
    auth: 'mj-api-secret'
  };
  const models = await requestModels(api, async (url, options) => {
    assert.equal(url, 'https://example.test/proxy/v1/models?api-version=example');
    assert.equal(options.method, 'GET');
    assert.deepEqual(options.headers, { 'mj-api-secret': 'example-token' });
    return Response.json({ data: [{ id: 'first' }, { id: 'selected' }, { id: 'first' }, {}] });
  });
  assert.deepEqual(models, ['first', 'selected']);
  await requestCompletion({ ...api, model: models[1] }, [], async (url, options) => {
    assert.equal(url, 'https://example.test/proxy/v1/chat/completions?api-version=example');
    assert.equal(options.headers['mj-api-secret'], 'example-token');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(JSON.parse(options.body).model, 'selected');
    return Response.json({ choices: [{ message: { content: '你好' } }] });
  });
});

test('获取模型时区分无可用模型、令牌错误和无效地址', async () => {
  const api = { baseUrl: 'https://example.test/v1/', apiKey: 'example-token' };
  await assert.rejects(requestModels(api, async (url, options) => {
    assert.equal(url, 'https://example.test/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer example-token');
    return Response.json({ data: [] });
  }), /没有返回可选模型/);
  await assert.rejects(requestModels(api, async () => new Response(null, { status: 401 })), /HTTP 401.*Token/);
  await assert.rejects(requestModels({ ...api, baseUrl: 'https://user@example.test' }), /有效的 API 地址/);
});

const preset = {
  messages: [
    { role: 'system', content: '预设系统' },
    { role: 'user', content: '预设医生', stages: ['consultation'] },
    { role: 'assistant', content: '预设家长', stages: ['consultation'] },
    { role: 'system', content: '关闭项', enabled: false }
  ],
  tasks: { consultation: '本轮问诊', case: '创建病例', review: '开始复盘' }
};

test('世界书按阶段和关键词选择，并插入所配置的角色和位置', () => {
  const worldbook = {
    scanDepth: 2,
    maxChars: 100,
    entries: [
      { title: '常驻', content: '系统常驻', always: true, position: 'system' },
      { title: '尿检', content: '尿检知识', keys: ['尿检'], position: 'depth', depth: 1, role: 'assistant' },
      { title: '复盘', content: '只在复盘', always: true, stages: ['review'] },
      { title: '旧消息', content: '扫描范围外', keys: ['咳嗽'] },
      { title: '末尾', content: '近端知识', keys: ['尿检'], position: 'afterHistory' }
    ]
  };
  const history = [
    { role: 'user', content: '它有没有咳嗽？' },
    { role: 'assistant', content: '没有。' },
    { role: 'user', content: '开尿检' }
  ];
  const messages = buildMessages({ preset, worldbook, history, stage: 'consultation', dossier: { diagnosis: '固定答案' } });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /预设系统.*系统常驻.*固定答案.*本轮问诊/s);
  assert.deepEqual(messages.slice(1).map(({ role, content }) => [role, content]), [
    ['user', '预设医生'], ['assistant', '预设家长'], ['user', '它有没有咳嗽？'],
    ['assistant', '没有。'], ['assistant', '【世界书·尿检】\n尿检知识'],
    ['system', '【世界书·末尾】\n近端知识'], ['user', '开尿检']
  ]);
});

test('流式预览解码可见字段，隐藏病例底稿与后续元数据', () => {
  assert.deepEqual(publicPreview('```json\n{"opening":"医生，\\u5b', 'opening'), { text: '医生，', complete: false });
  assert.deepEqual(publicPreview('{"opening":"医生，\\u5b83吐了\\n第二次","dossier":{"diagnosis":"隐藏"}}', 'opening'), { text: '医生，它吐了\n第二次', complete: true });
  assert.deepEqual(publicPreview('{"dossier":{"opening":"藏在底稿里的内容"}}', 'opening'), { text: '', complete: false });
  assert.deepEqual(publicPreview('{"reply":"医生，您看？","results":[{"content":"结果"}]}', 'reply'), { text: '医生，您看？', complete: true });
});

test('流式请求逐块解码正文，跳过思考内容，并拒绝中断的流', async () => {
  const api = { baseUrl: 'https://example.test/v1', model: 'model' };
  const encoder = new TextEncoder();
  const payload = encoder.encode(
    'data: {"choices":[{"delta":{"reasoning_content":"内部思考"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"content":"医生"}}]}\n\n' +
    'data: [DONE]\n\n'
  );
  const chunks = [];
  const text = await requestCompletion(api, [], async (url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < payload.length; i += 2) controller.enqueue(payload.slice(i, i + 2));
        controller.close();
      }
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  }, { onText: content => chunks.push(content) });
  assert.equal(text, '你好医生');
  assert.deepEqual(chunks, ['你好', '你好医生']);

  await assert.rejects(requestCompletion(api, [], async () =>
    new Response('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' }
    }), { onText() {} }), /中断/);
});

test('检查结果只归档本轮实际返回的有效项目', () => {
  const turn = parseTurn(JSON.stringify({
    reply: '医生，我看到了。',
    results: [
      { type: 'physical', name: '体温', content: '38.5 °C' },
      { type: 'test', name: '血常规', content: '   ' },
      { type: 'test', name: '腹部超声', content: '未见游离液体' }
    ]
  }));
  assert.deepEqual(turn.results, [
    { type: 'physical', name: '体温', content: '38.5 °C' },
    { type: 'test', name: '腹部超声', content: '未见游离液体' }
  ]);
});

test('检查报告解析表格和客观描述，并保留旧报告格式', () => {
  const { results } = parseTurn(JSON.stringify({ reply: '结果出来了。', results: [
    { type: 'test', name: '血常规', rows: [
      { label: '白细胞', value: 19.2, unit: '×10⁹/L', reference: '5–18', flag: 'high' },
      { label: '细胞形态', value: '未见异常' },
      { label: '空结果', value: null }
    ] },
    { type: 'test', name: '腹部超声', sections: [{ title: '所见', text: '未见游离液体。' }] },
    { type: 'physical', name: '触诊', content: '腹部柔软。' }
  ] }));
  assert.deepEqual(results, [
    { type: 'test', name: '血常规', rows: [
      { label: '白细胞', value: '19.2', unit: '×10⁹/L', reference: '5–18', flag: 'high' },
      { label: '细胞形态', value: '未见异常', unit: '', reference: '', flag: '' }
    ] },
    { type: 'test', name: '腹部超声', sections: [{ title: '所见', text: '未见游离液体。' }] },
    { type: 'physical', name: '触诊', content: '腹部柔软。' }
  ]);
});

test('完整的【】命令按原文交给 AI，不限制表达方式', () => {
  assert.equal(bracketCommand('【测试一下手术的流程】'), '测试一下手术的流程');
  assert.equal(bracketCommand(' 【用【已有结果】\n试试后面的环节】 '), '用【已有结果】\n试试后面的环节');
  for (const text of ['【 】', '【甲】【乙】', '【没关闭', '家长问【要手术吗】', '测试一下手术的流程']) {
    assert.equal(bracketCommand(text), undefined);
  }
});

test('AI 的分流结果只接受应用支持的流程', () => {
  for (const stage of ['consultation', 'surgery', 'review']) {
    assert.equal(parseCommandStage(JSON.stringify({ stage })), stage);
  }
  assert.throws(() => parseCommandStage('{"stage":"debug"}'), /命令/);
  assert.throws(() => parseCommandStage('建议打开手术页面。'), /命令/);
});

test('非犬猫病例必须引用用户手动设定的物种', () => {
  assert.equal(allowsCaseSpecies({}, '犬', ''), true);
  assert.equal(allowsCaseSpecies({ freeform: '完全随机' }, '家兔', '兔子'), false);
  assert.equal(allowsCaseSpecies({ scopeDetail: '兔子 + 食欲不振' }, '兔子', '兔子'), true);
  assert.equal(allowsCaseSpecies({ scopeDetail: '兔子 + 食欲不振' }, '蜥蜴', '兔子'), false);
  assert.equal(allowsCaseSpecies({ freeform: '想练兔子病例' }, '家兔', ''), false);
});

test('生成病例时通过本次设定匹配世界书，复盘条目保持阶段隔离', () => {
  const worldbook = {
    entries: [
      { title: '猫', keys: ['猫'], content: '猫科病例参考' },
      { title: '复盘', always: true, stages: ['review'], content: '复盘参考' }
    ]
  };
  const input = [{ role: 'user', content: '猫 + 急诊' }];
  assert.match(buildMessages({ preset, worldbook, stage: 'case', history: input })[0].content, /猫科病例参考/);
  assert.doesNotMatch(buildMessages({ preset, worldbook, stage: 'case', history: input })[0].content, /复盘参考|预设家长/);
  assert.match(buildMessages({ preset, worldbook, stage: 'review', history: input })[0].content, /复盘参考/);
});

test('病例底稿与家长开场分开解析', () => {
  assert.throws(() => parseCase('{"opening":"缺少底稿"}'), /病例/);
  assert.deepEqual(parseCase('{"clarification":"请指定范围"}'), { clarification: '请指定范围' });
  const result = parseCase('{"dossier":{"diagnosis":"保密"},"opening":"医生，它今天没吃饭。","options":{"treatment":false,"turnLimit":1,"diagnosis":"替换"}}');
  assert.equal(result.dossier.diagnosis, '保密');
  assert.equal(result.opening, '医生，它今天没吃饭。');
  assert.deepEqual(result.options, { treatment: false, turnLimit: 1 });
  assert.deepEqual(parseTurn('```json\n{"reply":"医生，怎么办？","phase":"treatment","metaAttempt":false}\n```'), {
    reply: '医生，怎么办？', phase: 'treatment', metaAttempt: false
  });
});

test('助手只有确认给过练习提示才计入提示次数', () => {
  assert.equal(parseTurn('{"reply":"先确认症状频率。","hintGiven":true}').hintGiven, true);
  assert.equal(parseTurn('{"reply":"报告在检查结果页签。","hintGiven":false}').hintGiven, undefined);
  assert.equal(parseTurn('{"reply":"报告在检查结果页签。","hintGiven":"true"}').hintGiven, undefined);
});

test('请求使用 Chat Completions 格式并读取助手文本', async () => {
  const messages = [{ role: 'user', content: '你好' }];
  const response = await requestCompletion({
    baseUrl: 'https://example.test/v1/', apiKey: 'example', model: 'my-model',
    parameters: { temperature: 0.6, stream: true }
  }, messages, async (url, options) => {
    assert.equal(url, 'https://example.test/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer example');
    assert.deepEqual(JSON.parse(options.body), { temperature: 0.6, stream: false, model: 'my-model', messages });
    return Response.json({ choices: [{ message: { content: '回复' } }] });
  });
  assert.equal(response, '回复');
  await assert.rejects(requestCompletion({
    baseUrl: 'https://example.test/v1/chat/completions', model: 'my-model'
  }, messages, async (url) => {
    assert.equal(url, 'https://example.test/v1/chat/completions');
    return new Response('{}', { status: 401 });
  }), /401/);
});
