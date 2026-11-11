const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

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

export function createCase(settings, dossier, opening) {
  const profile = caseProfile(dossier);
  if (!profile.pet.name || !profile.owners[0]?.name) {
    throw new Error('模型返回的档案不完整，缺少宠物名字或主要联系人。请重新生成。');
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  return {
    id, createdAt: now, updatedAt: now, revision: 0,
    settings, profile, dossier,
    phase: 'consultation', turns: 0, hints: 0, metaAttempts: 0,
    history: [{ role: 'assistant', content: opening }], results: [], assistantHistory: []
  };
}

export function recordTurn(current, input, result, note = '') {
  const turns = current.turns + 1;
  const phase = ['judgment', 'treatment'].includes(result.phase) ? 'judgment' : current.phase;
  const thought = note.trim();
  return {
    ...current, phase, turns,
    metaAttempts: current.metaAttempts + Number(result.metaAttempt === true),
    history: [...current.history,
      { role: 'user', content: input, turn: turns, ...(thought && { note: thought }) },
      { role: 'assistant', content: result.reply, turn: turns }],
    results: [...current.results, ...(result.results ?? []).map(item => ({ ...item, turn: turns }))]
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

const formalMessages = current => caseMessages(current).filter(message => message.type !== 'debug');

export function reviewNotes(current) {
  return formalMessages(current).flatMap(({ role, content, note, turn }) =>
    role === 'user' && note ? [{ turn, message: content, note }] : []);
}

export function consultationHistory(current) {
  return formalMessages(current).map(({ role, content, turn, type }) => ({
    role,
    content: role === 'assistant' && !type && turn ? [content, ...current.results
      .filter(item => item.turn === turn).map(item => `【检查报告】${JSON.stringify(item)}`)].join('\n\n') : content
  }));
}

export function helperContext(current) {
  if (!current) return undefined;
  const review = caseReview(current);
  return {
    profile: current.profile, phase: current.phase, turn: current.turns,
    consultation: formalMessages(current).map(({ role, content }) => ({ role, content })),
    reports: current.results,
    ...(review && { review: {
      diagnosis: current.dossier.diagnosis, summary: review.legacyText, score: review.score
    } })
  };
}
