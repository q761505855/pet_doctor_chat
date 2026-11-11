import assert from 'node:assert/strict';
import test from 'node:test';
import {
  caseMessages, caseProfile, caseReview, clinicalHistory, createCase, helperContext,
  recordReview, recordTurn, reviewNotes
} from '../docs/cases.mjs';
import { parseReview } from '../docs/chat.mjs';

const dossier = {
  pet: { name: '小满', species: '猫', breed: '中华田园猫', age: '3 岁' },
  owners: [{ name: '林女士', gender: '女', age: 29, personality: '谨慎' }, { name: '林先生' }],
  diagnosis: '隐藏诊断', hiddenFacts: ['隐藏病史']
};

test('病例建档归一化宠物与多位家庭成员，公开资料不带底稿', () => {
  const profile = caseProfile(dossier);
  assert.equal(profile.pet.name, '小满');
  assert.deepEqual(profile.owners.map(owner => [owner.name, owner.age]), [['林女士', '29'], ['林先生', '']]);
  assert.equal(JSON.stringify(profile).includes('隐藏'), false);
});

test('接诊结果与消息同时更新，并保持原记录可重试', () => {
  const current = createCase({ scope: '完全随机' }, dossier, '它今天不吃饭。');
  const report = { name: '体格检查', type: 'physical', content: '体温记录' };
  const updated = recordTurn(current, '做体检', { reply: '好。', results: [report] });
  assert.equal(current.history.length, 1);
  assert.deepEqual(current.results, []);
  assert.equal(updated.history.at(-1).content, '好。');
  assert.equal(updated.history.at(-1).turn, 1);
  assert.deepEqual(updated.results, [{ ...report, turn: 1 }]);
});

test('本轮备注随医生消息保存，只进入复盘的备注清单', () => {
  const current = createCase({}, dossier, '开场');
  const updated = recordTurn(current, '测体温', { reply: '好。' }, '  怀疑有发热  ');
  assert.equal(updated.history[1].note, '怀疑有发热');
  assert.deepEqual(reviewNotes(updated), [{ turn: 1, message: '测体温', note: '怀疑有发热' }]);
  assert.doesNotMatch(JSON.stringify(clinicalHistory(updated)), /怀疑有发热/);
  assert.doesNotMatch(JSON.stringify(helperContext(updated)), /怀疑有发热/);
});

test('接诊和手术按实际顺序共享报告，手术备注只在复盘可见', () => {
  const initial = createCase({}, dossier, '开场');
  const consult = recordTurn(initial, '做超声', {
    reply: '好。', results: [{ name: '术前超声' }]
  });
  const surgery = recordTurn(consult, '开始术中监测', {
    reply: '监测已开始。', results: [{ name: '术中监测' }]
  }, '考虑病情变化', 'surgery');
  const followup = recordTurn(surgery, '告知家长监测结果', { reply: '我明白了。' }, '确认理解');
  assert.equal(followup.turns, 2);
  assert.equal(followup.surgeryTurns, 1);
  const history = clinicalHistory(followup);
  assert.match(history[2].content, /术前超声/);
  assert.match(history[4].content, /手术.*第 2 轮.*监测已开始.*术中监测/s);
  assert.equal(history[5].content, '告知家长监测结果');
  assert.doesNotMatch(JSON.stringify([history, helperContext(followup)]), /考虑病情变化|确认理解/);
  assert.deepEqual(reviewNotes(followup), [
    { turn: 2, message: '开始术中监测', note: '考虑病情变化', stage: 'surgery' },
    { turn: 3, message: '告知家长监测结果', note: '确认理解' }
  ]);
  assert.equal(consult.surgeryTurns, undefined);
  assert.equal(helperContext(consult).surgery, undefined);
});

test('接诊区分内部术中记录、客观报告和家长实际听到的告知', () => {
  const initial = createCase({}, dossier, '它今天不吃饭。');
  const surgery = recordTurn(initial, '执行术中操作甲', {
    reply: '监护发现血压下降。', results: [{ name: '术中监护报告' }]
  }, '术中私下想法', 'surgery');
  const disclosure = recordTurn(surgery, '告诉家长：目前出现异常，需要继续处理。', {
    reply: '我同意先处理异常，等稳定了再谈后续方案。',
    results: [{ name: '本轮客观观察' }]
  });
  const consultation = clinicalHistory(disclosure, 'consultation');
  assert.deepEqual(consultation.map(({ role }) => role), [
    'assistant', 'system', 'system', 'user', 'assistant', 'system'
  ]);
  assert.match(consultation[1].content, /家长未参与.*兽医.*执行术中操作甲/);
  assert.match(consultation[2].content, /手术现场反馈.*血压下降.*术中监护报告/s);
  assert.match(consultation[3].content, /目前出现异常/);
  assert.match(consultation[5].content, /家长所知以实际告知为准.*本轮客观观察/);
  assert.doesNotMatch(JSON.stringify(consultation), /术中私下想法/);

  const resumed = clinicalHistory(disclosure, 'surgery');
  assert.equal(resumed[1].role, 'user');
  assert.match(resumed[2].content, /血压下降/);
  assert.match(resumed.at(-1).content, /我同意先处理异常/);
});

test('复盘单独保存，并兼容藏在旧对话中的复盘文本', () => {
  const current = createCase({}, dossier, '开场');
  const report = { summary: '完成接诊', score: 78, sections: [{ title: '诊断与鉴别', body: '依据充分。' }] };
  const reviewed = recordReview(current, report);
  assert.equal(reviewed.phase, 'review');
  assert.deepEqual(reviewed.history, current.history);
  assert.equal(caseReview(reviewed).score, 78);

  const legacy = { ...current, phase: 'review', history: [...current.history,
    { role: 'user', content: '结束本次接诊，开始复盘。' },
    { role: 'assistant', content: '## 旧版复盘', type: 'review' }
  ] };
  assert.deepEqual(caseMessages(legacy), current.history);
  assert.equal(caseReview(legacy).legacyText, '## 旧版复盘');
});

test('结构化复盘必须对每条备注给出对应评价', () => {
  const report = { summary: '完成接诊', score: 78, sections: [{ title: '诊断与鉴别', body: '依据充分。' }] };
  const notes = [{ turn: 1, note: '怀疑有发热' }];
  assert.throws(() => parseReview(JSON.stringify(report), notes), /备注/);
  report.noteFeedback = [{ turn: 1, feedback: '可先测体温验证。' }, { turn: 5, feedback: '不存在的备注。' }];
  const parsed = parseReview(JSON.stringify(report), notes);
  assert.deepEqual(parsed.noteFeedback, [report.noteFeedback[0]]);
});

test('创建病例时要求模型给出宠物名字和主要联系人', () => {
  assert.throws(() => createCase({}, { ...dossier, pet: {} }, '开场'), /档案不完整/);
  assert.throws(() => createCase({}, { ...dossier, owners: [] }, '开场'), /档案不完整/);
});

test('助手只收到打开病例的公开资料，系统帮助没有病例上下文', () => {
  const first = createCase({ scope: '完全随机' }, dossier, '它今天不吃饭。');
  first.history.push({ role: 'assistant', content: '隐藏调试输出', type: 'debug' });
  const second = createCase({}, { ...dossier, pet: { name: '豆豆' } }, '只有另一病例知道这句。');
  const context = JSON.stringify(helperContext(first));
  assert.match(context, /小满/);
  assert.doesNotMatch(context, /隐藏|豆豆|另一病例/);
  assert.match(JSON.stringify(helperContext(second)), /豆豆/);
  assert.equal(helperContext(), undefined);
});
