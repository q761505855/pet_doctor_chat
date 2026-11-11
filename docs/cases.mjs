const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

export const caseDifficulties = ['入门', '中等', '高难'];

export function caseProfile(dossier) {
  const pet = dossier.pet ?? {};
  const owners = Array.isArray(dossier.owners) ? dossier.owners.filter(owner => owner && typeof owner === 'object') : [];
  return {
    pet: {
      name: text(pet.name), species: text(pet.species), breed: text(pet.breed), age: text(pet.age),
      sex: text(pet.sex ?? pet.gender), neutered: typeof pet.neutered === 'boolean' ?
        (pet.neutered ? '已绝育' : '未绝育') : text(pet.neutered), weight: text(pet.weight)
    },
    owners: owners.map(owner => ({
      name: text(owner.name), gender: text(owner.gender ?? owner.sex), age: text(owner.age),
      relationship: text(owner.relationship), personality: text(owner.personality)
    }))
  };
}

export function createCase(settings, dossier, opening, profile = caseProfile(dossier)) {
  if (!profile.pet.name || !profile.owners[0]?.name) {
    throw new Error('模型返回的档案不完整，缺少宠物名字或主要联系人。请重新生成。');
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  return {
    id, createdAt: now, updatedAt: now, revision: 0,
    settings, profile, dossier, opening,
    phase: 'consultation', turns: 0, hints: 0, metaAttempts: 0,
    history: [{ role: 'assistant', content: opening }], results: [], assistantHistory: []
  };
}

export function nextTurnNumber(current) {
  const lastMessageTurn = current.history.reduce((last, message) => Math.max(last, message.turn ?? 0), 0);
  const lastReportTurn = current.results.reduce((last, report) => Math.max(last, report.turn ?? 0), 0);
  return Math.max(lastMessageTurn, lastReportTurn, current.turns + (current.surgeryTurns ?? 0)) + 1;
}

export function recordTurn(current, input, result, note = '', stage = 'consultation', retry = false) {
  const surgery = stage === 'surgery';
  const turn = retry ? current.history.at(-1).turn : nextTurnNumber(current);
  const phase = !surgery && ['judgment', 'treatment'].includes(result.phase) ? 'judgment' : current.phase;
  const context = surgery ? { stage } : {};
  const thought = note.trim();
  return {
    ...current, phase,
    turns: current.turns + Number(!surgery && !retry),
    ...(surgery && !retry && { surgeryTurns: (current.surgeryTurns ?? 0) + 1 }),
    metaAttempts: current.metaAttempts + Number(result.metaAttempt === true),
    history: [...current.history,
      ...(!retry ? [{ role: 'user', content: input, turn, ...context, ...(thought && { note: thought }) }] : []),
      { role: 'assistant', content: result.reply, turn, ...context,
        ...(phase === 'judgment' && { phase }), ...(result.metaAttempt && { metaAttempt: true }) }],
    results: [...current.results.filter(item => !retry || item.turn !== turn),
      ...(result.results ?? []).map(item => ({ ...item, turn }))]
  };
}

export function recordReview(current, report) {
  return { ...current, phase: 'review', review: { ...report, createdAt: new Date().toISOString() } };
}

export function caseReview(current) {
  if (current.review) return current.review;
  const legacy = current.history.find(message => message.type === 'review');
  return legacy && { legacyText: legacy.content };
}

export function caseMessages(current) {
  // Earlier records kept the review and its synthetic trigger in the transcript.
  return current.history.filter((message, index, history) => message.type !== 'review' &&
    !(message.role === 'user' && message.content === '结束本次接诊，开始复盘。' && history[index + 1]?.type === 'review'));
}

export function rewindCase(current, message, { includeMessage = true } = {}) {
  if (current.phase === 'review') throw new Error('已复盘的病例对话只能查看。');
  const index = current.history.indexOf(message);
  const end = index + Number(includeMessage);
  const history = current.history.slice(0, end);
  const retained = new Map(history.filter(entry => entry.turn).map(entry => [entry.turn, entry.stage]));
  const surgeryTurns = [...retained.values()].filter(stage => stage === 'surgery').length;
  const lastTurn = Math.max(0, ...retained.keys());
  const results = current.results.filter(report => message.turn ? report.turn < message.turn : report.turn <= lastTurn);
  const removedAttempts = current.history.slice(end).filter(entry => entry.metaAttempt).length;
  return {
    ...current, history, results, turns: retained.size - surgeryTurns, surgeryTurns,
    metaAttempts: Math.max(0, current.metaAttempts - removedAttempts),
    phase: history.some(entry => entry.phase === 'judgment') ? 'judgment' : 'consultation'
  };
}

const formalMessages = current => caseMessages(current).filter(message => message.type !== 'debug');

export function reviewNotes(current) {
  return formalMessages(current).flatMap(({ role, content, note, turn, stage }) =>
    role === 'user' && note ? [{ turn, message: content, note, ...(stage && { stage }) }] : []);
}

export function clinicalHistory(current, targetStage) {
  const messages = formalMessages(current);
  const reportTurns = new Set(messages.filter(message => message.role === 'assistant' && message.turn)
    .map(message => message.turn));
  const history = messages.flatMap(({ role, content, turn, type, stage }) => {
    const surgery = stage === 'surgery';
    const reports = role === 'assistant' && !type && turn ? current.results
      .filter(item => item.turn === turn).map(item => `【检查报告】${JSON.stringify(item)}`) : [];
    const message = surgery ? `【手术 · 第 ${turn} 轮】${content}` : content;
    if (targetStage !== 'consultation') {
      return [{ role, content: [message, ...reports].join('\n\n') }];
    }
    if (surgery) {
      const source = role === 'user' ? '兽医在手术页的输入' : '手术现场反馈';
      return [{ role: 'system', content: [
        `【仅供模拟引擎延续病情，家长未参与这段交流】${source}：${message}`, ...reports
      ].join('\n\n') }];
    }
    return [
      { role, content },
      ...reports.map(report => ({ role: 'system', content: `【客观报告，家长所知以实际告知为准】${report}` }))
    ];
  });
  for (const report of current.results) {
    if (!reportTurns.has(report.turn)) {
      history.push({ role: 'system', content: `【已归档客观报告，家长所知以实际告知为准】${JSON.stringify(report)}` });
    }
  }
  return history;
}

export function helperContext(current) {
  if (!current) return undefined;
  const review = caseReview(current);
  return {
    profile: current.profile, phase: current.phase, turn: current.turns,
    consultation: formalMessages(current).filter(message => message.stage !== 'surgery')
      .map(({ role, content }) => ({ role, content })),
    ...(current.surgeryTurns && { surgery: formalMessages(current)
      .filter(message => message.stage === 'surgery').map(({ role, content }) => ({ role, content })) }),
    reports: current.results,
    ...(review && { review: {
      diagnosis: current.dossier.diagnosis, summary: review.legacyText, score: review.score
    } })
  };
}
