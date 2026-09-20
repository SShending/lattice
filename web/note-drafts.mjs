export function createNoteDraftState(topic, note, noteId) {
  const index = note?.index || {};
  return {
    topicId: topic.id,
    noteId: note?.id || noteId,
    body: note?.body || '',
    title: typeof index.title === 'string' ? index.title : '',
    kind: typeof index.kind === 'string' ? index.kind : '',
    claimStatus: typeof index.claimStatus === 'string' ? index.claimStatus : '',
    sources: Array.isArray(index.sources) ? structuredClone(index.sources) : [],
    expectedRevision: note?.revision ?? null,
    expectedStateRevision: topic.source.stateRevision,
    dirty: false,
    status: note ? 'saved' : 'draft',
    editing: !note,
    version: 0,
    inFlight: null,
    failedVersion: null,
    message: '',
    error: '',
    latest: null,
  };
}

export function reconcileNoteDraftState(draft, topic, note) {
  const noteRevision = note?.revision ?? null;
  if (!draft.dirty && draft.status !== 'conflict' && !draft.inFlight) {
    if (note) {
      const index = note.index || {};
      draft.body = note.body || '';
      draft.title = typeof index.title === 'string' ? index.title : '';
      draft.kind = typeof index.kind === 'string' ? index.kind : '';
      draft.claimStatus = typeof index.claimStatus === 'string' ? index.claimStatus : '';
      draft.sources = Array.isArray(index.sources) ? structuredClone(index.sources) : [];
    }
    draft.expectedRevision = noteRevision;
    draft.expectedStateRevision = topic.source.stateRevision;
    draft.latest = null;
  } else if (draft.expectedRevision !== noteRevision || draft.expectedStateRevision !== topic.source.stateRevision) {
    draft.status = 'conflict';
    draft.error = 'A newer committed version arrived while this draft was open.';
    draft.latest = note ? structuredClone(note) : null;
  }
  return draft;
}
