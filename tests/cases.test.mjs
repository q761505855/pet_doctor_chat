import assert from 'node:assert/strict';
import test from 'node:test';
import {
  caseMessages, caseProfile, caseReview, consultationHistory, createCase, helperContext,
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
  assert.doesNotMatch(JSON.stringify(consultationHistory(updated)), /怀疑有发热/);
  assert.doesNotMatch(JSON.stringify(helperContext(updated)), /怀疑有发热/);
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
