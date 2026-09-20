import { createNoteDraftState, reconcileNoteDraftState } from './note-drafts.mjs';

const app = document.querySelector('#app');
const select = document.querySelector('#topic-select');
const connection = document.querySelector('#connection');
const nav = document.querySelector('#nav');

let topics = [];
let activeTopic = localStorage.getItem('lattice.activeTopic') || '';
let selectedNoteId = '';
let selectedRoadmapId = '';
const selectedNoteByTopic = new Map();
const noteDrafts = new Map();
let renderedTopic = null;
let notesRefreshTimer = null;
let notesRefreshInFlight = false;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const list = (values, empty = 'Nothing recorded in the vault.') => Array.isArray(values) && values.length
  ? `<ul class="plain-list">${values.map((value) => `<li>${esc(value)}</li>`).join('')}</ul>`
  : `<p class="empty-copy">${esc(empty)}</p>`;

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || 'Request failed');
  return data;
}

async function putJson(url, value) {
  const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message || data.error || 'Request failed');
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

function formatDate(value) {
  if (!value) return 'No recorded activity';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function setActiveTopic(id, view = location.hash.slice(1) || 'study') {
  if (view === 'topics') view = 'study';
  const previous = noteDrafts.get(draftKey(activeTopic, selectedNoteId));
  if (previous?.dirty) previous.editing = false;
  activeTopic = id;
  selectedNoteId = selectedNoteByTopic.get(id) || '';
  selectedRoadmapId = '';
  localStorage.setItem('lattice.activeTopic', activeTopic);
  select.value = activeTopic;
  if (location.hash !== `#${view}`) location.hash = `#${view}`;
  render();
}

function setTopics(data) {
  topics = Array.isArray(data.topics) ? data.topics : [];
  if (!topics.some((topic) => topic.id === activeTopic && topic.status !== 'invalid')) {
    activeTopic = topics.find((topic) => topic.status !== 'invalid')?.id || '';
  }
  localStorage.setItem('lattice.activeTopic', activeTopic);
  select.innerHTML = topics.map((topic) => `<option value="${esc(topic.id)}" ${topic.id === activeTopic ? 'selected' : ''}${topic.status === 'invalid' ? ' disabled' : ''}>${esc(topic.title)}${topic.status === 'invalid' ? ' (invalid)' : ''}</option>`).join('');
  select.disabled = !topics.some((topic) => topic.status !== 'invalid');
}

async function loadTopic() {
  return activeTopic ? getJson(`/api/topics/${encodeURIComponent(activeTopic)}`) : null;
}

function sourceLine(topic, label = 'Committed source') {
  return `<details class="source-details"><summary>Source details</summary><div class="source-line"><span>${esc(label)}</span><code>state.json ${esc(topic.source.stateRevision)}</code></div></details>`;
}

function randomId(prefix) {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${value}`.slice(0, 120);
}

function draftKey(topicId, noteId) { return `${topicId}/${noteId}`; }

function createDraft(topic, note, requestedNoteId = '') {
  const noteId = note?.id || requestedNoteId || randomId('note');
  return {
    ...createNoteDraftState(topic, note, noteId),
    operationId: randomId('note-op'),
    updateId: randomId('note-update'),
  };
}

function rotateRequestIds(draft) {
  draft.operationId = randomId('note-op');
  draft.updateId = randomId('note-update');
}

function draftFor(topic, note) {
  const noteId = note?.id || selectedNoteId;
  const key = draftKey(topic.id, noteId);
  let draft = noteDrafts.get(key);
  if (!draft) {
    draft = createDraft(topic, note, noteId);
    noteDrafts.set(key, draft);
  }
  return reconcileNoteDraftState(draft, topic, note);
}

function topicSignature(topic) {
  if (!topic) return '';
  return `${topic.source?.stateRevision || ''}|${topic.notes.map((note) => `${note.id}:${note.revision}`).join('|')}`;
}

function stopNotesRefresh() {
  if (notesRefreshTimer !== null) window.clearInterval(notesRefreshTimer);
  notesRefreshTimer = null;
}

function startNotesRefresh() {
  stopNotesRefresh();
  if ((location.hash.slice(1) || 'study') !== 'notes') return;
  notesRefreshTimer = window.setInterval(() => { refreshNotes().catch(() => {}); }, 5000);
}

async function refreshNotes() {
  if (notesRefreshInFlight || (location.hash.slice(1) || 'study') !== 'notes' || !activeTopic || document.visibilityState === 'hidden') return;
  notesRefreshInFlight = true;
  try {
    const latest = await loadTopic();
    if (!latest || topicSignature(latest) === topicSignature(renderedTopic)) return;
    paint('notes', latest);
  } finally {
    notesRefreshInFlight = false;
  }
}

function draftStatusLabel(draft) {
  if (draft.inFlight && draft.version === draft.inFlight.version) return 'Saving...';
  if (draft.status === 'saved' && !draft.dirty) return 'Saved';
  if (draft.status === 'conflict') return 'Conflict';
  if (draft.status === 'error') return 'Save failed';
  return 'Unsaved draft';
}

function readableLabel(value) {
  const labels = { working_model: 'Working model', learning_note: 'Learning note', confirmed: 'Confirmed' };
  const normalized = String(value || 'note');
  return labels[normalized] || normalized.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function roadmapProgress(roadmap) {
  const items = Array.isArray(roadmap) ? roadmap : [];
  const demonstrated = items.filter((item) => roadmapCategory(item.status) === 'completed').length;
  return { demonstrated, total: items.length, label: `${demonstrated}/${items.length} milestones demonstrated` };
}

function explicitTopicComplete(topic) {
  const focus = String(topic?.state?.currentFocus || '').trim();
  const title = String(topic?.title || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Boolean(title && new RegExp(`^${title}\\s+(?:is\\s+)?complete(?:[.!]|\\s|$)`, 'i').test(focus));
}

function pageHeader(topic, section, title, description = '') {
  return `<header class="page-header"><div class="eyebrow">${esc(section)}</div><div class="page-header-row"><div><h1>${esc(title)}</h1>${description ? `<p class="page-description">${esc(description)}</p>` : ''}</div></div></header>`;
}

function emptyState(title, body, tone = '') {
  return `<section class="empty-state ${tone}"><span class="empty-mark">--</span><h2>${esc(title)}</h2><p>${esc(body)}</p></section>`;
}

function roadmapCategory(status) {
  const normalized = String(status || '').toLowerCase();
  if (['demonstrated', 'completed', 'complete', 'done'].includes(normalized)) return 'completed';
  if (['active', 'current', 'in-progress', 'in_progress'].includes(normalized)) return 'current';
  if (['planned', 'upcoming'].includes(normalized)) return 'upcoming';
  return 'other';
}

function roadmapSummaryLabel(summary) {
  if (!summary) return 'No roadmap recorded';
  const parts = [`${summary.count} ${summary.count === 1 ? 'item' : 'items'}`];
  if (summary.completed) parts.push(`${summary.completed} completed`);
  if (summary.current) parts.push(`${summary.current} current`);
  if (summary.upcoming) parts.push(`${summary.upcoming} upcoming`);
  return parts.join(' / ');
}

function renderStudy(topic) {
  const sessions = topic.sessions.slice().reverse();
  const roadmap = Array.isArray(topic.roadmap) ? topic.roadmap : [];
  const currentRoadmap = roadmap.find((item) => roadmapCategory(item.status) === 'current');
  const establishedCount = topic.concepts.filter((concept) => ['demonstrated', 'completed'].includes(String(concept.status).toLowerCase())).length;
  const summary = topics.find((item) => item.id === topic.id)?.roadmapSummary;
  const progress = roadmapProgress(roadmap);
  const complete = explicitTopicComplete(topic);
  const nextReason = topic.state.nextStepReason || 'No reason has been recorded for this objective.';
  const checkpointMarkup = sessions.length ? `<div class="checkpoint-list">${sessions.map((session) => `<details class="checkpoint-entry"><summary><span class="checkpoint-summary-line"><span class="checkpoint-title">${esc(session.title || 'Historical checkpoint')}</span><span class="checkpoint-date">${esc(formatDate(session.index?.createdAt))}</span></span><span class="checkpoint-heading"><strong>Historical checkpoint</strong></span>${session.preview ? `<span class="checkpoint-preview">${esc(session.preview)}</span>` : ''}</summary><div class="checkpoint-expanded"><div class="markdown checkpoint-markdown">${session.html}</div><details class="source-details checkpoint-source-details"><summary>Source details</summary><div class="source-line"><span>Session</span><code>${esc(session.source?.sessionId || session.id)}</code>${session.source?.updateId ? `<span>Update</span><code>${esc(session.source.updateId)}</code>` : ''}${session.source?.baseRevision ? `<span>Base revision</span><code>${esc(session.source.baseRevision)}</code>` : ''}<span>Body revision</span><code>${esc(session.source?.revision || session.revision || '')}</code></div></details></div></details>`).join('')}</div>` : '<p class="empty-copy">No historical checkpoints have been recorded for this topic.</p>';
  return `${pageHeader(topic, 'STUDY', topic.title, topic.state.goal || 'Continue building understanding from the committed learner model.')}<div class="study-layout">
    <div class="study-main">
      <section class="tutor-stage" aria-label="Tutor workspace"><div class="stage-topline"><span class="stage-status"><span class="status-dot status-dot-muted"></span> Tutor workspace</span><span class="stage-phase">Browsing only</span></div><div class="stage-content"><strong>Codex unavailable</strong><span>Browse the learning record below. Study interaction is not available in Phase 1.</span></div></section>
      <section class="study-signals">${complete ? `<div class="completion-banner"><span class="completion-mark" aria-hidden="true">&#10003;</span><div><strong>Topic complete</strong><span>${esc(progress.label)}</span></div></div>` : `<div class="study-signal"><span class="section-kicker">Current focus</span><p class="signal-copy">${esc(topic.state.currentFocus || 'No current focus recorded.')}</p></div>`}<div class="study-signal"><span class="section-kicker">Next objective</span><p class="signal-copy">${esc(topic.state.nextStep || 'No next objective recorded.')}</p><details class="assessment-details"><summary>Why this is next</summary><p>${esc(nextReason)}</p></details></div><a class="text-link" href="#understanding">Read understanding <span aria-hidden="true">-&gt;</span></a></section>
      <section class="checkpoint-section"><div class="section-heading"><div><span class="section-kicker">Historical record</span><h2>Checkpoints</h2></div><span class="section-count">${sessions.length} recorded</span></div>${checkpointMarkup}</section>
    </div>
    <aside class="study-aside"><section class="signal-panel"><div class="section-heading"><div><span class="section-kicker">Current assessment</span><h2>Learning profile</h2></div><a class="quiet-link" href="#understanding">Details</a></div><div class="signal-list"><div><span>Established</span><strong>${establishedCount} concepts</strong></div><div><span>Uncertainty</span><strong>${topic.state.unassessed.length} open items</strong></div></div></section><section class="path-preview"><div class="section-heading"><div><span class="section-kicker">Roadmap</span><h2>${esc(progress.label)}</h2></div></div>${currentRoadmap ? `<div class="path-current"><span class="path-node current"></span><div><strong>${esc(currentRoadmap.title || currentRoadmap.id)}</strong><span>${esc(currentRoadmap.status || 'current')}</span></div></div>` : complete ? '<p class="complete-copy">Every recorded milestone is demonstrated.</p>' : '<p class="empty-copy">No current milestone is explicitly recorded.</p>'}<div class="path-count">${esc(roadmapSummaryLabel(summary))}</div><a class="quiet-link path-preview-link" href="#roadmap">Open path <span aria-hidden="true">-&gt;</span></a></section><section class="library-preview"><span class="section-kicker">Notes</span><strong>${topic.notes.length} ${topic.notes.length === 1 ? 'note' : 'notes'}</strong><a class="text-link" href="#notes">Browse notes <span aria-hidden="true">-&gt;</span></a></section>${sourceLine(topic)}</aside>
  </div>`;
}

function renderRoadmap(topic) {
  const roadmap = topic.roadmap;
  if (!roadmap?.length) return `${pageHeader(topic, 'ROADMAP', 'Learning path', 'A read-only projection of the roadmap recorded for this topic.')}${emptyState('No roadmap recorded', 'This topic has no roadmap field in its authoritative state. Nothing has been inferred.')}${sourceLine(topic)}`;
  if (!selectedRoadmapId || !roadmap.some((item) => item.id === selectedRoadmapId)) selectedRoadmapId = roadmap.find((item) => roadmapCategory(item.status) === 'current')?.id || roadmap[0]?.id || '';
  const selected = roadmap.find((item) => item.id === selectedRoadmapId) || roadmap[0];
  const nextTargets = topic.state.nextStepTargets || [];
  const progress = roadmapProgress(roadmap);
  return `${pageHeader(topic, 'ROADMAP', 'Learning path', 'Milestones and status are shown exactly as recorded in the vault.')}<div class="roadmap-progress"><strong>${esc(progress.label)}</strong><span>${esc(roadmap.length - progress.demonstrated)} not demonstrated</span></div><div class="roadmap-layout"><ol class="learning-path">${roadmap.map((item, index) => { const category = roadmapCategory(item.status); const related = nextTargets.includes(item.id); return `<li class="path-item ${category} ${item.id === selectedRoadmapId ? 'selected' : ''}"><button class="path-button" data-roadmap="${esc(item.id)}" aria-current="${item.id === selectedRoadmapId ? 'true' : 'false'}" aria-controls="roadmap-detail"><span class="path-index">${String(index + 1).padStart(2, '0')}</span><span class="path-node ${category}"></span><span class="path-copy"><strong>${esc(item.title || item.id || 'Unnamed milestone')}</strong><small>${esc(item.status || 'unclassified')}${related ? ' / next objective' : ''}</small></span></button></li>`; }).join('')}</ol><section class="roadmap-detail ${roadmapCategory(selected.status)}" id="roadmap-detail" tabindex="-1"><div class="detail-header"><span class="section-kicker">Selected milestone</span><div class="detail-status ${roadmapCategory(selected.status)}"><span class="status-dot"></span>${esc(selected.status || 'unclassified')}</div></div><h2>${esc(selected.title || selected.id || 'Unnamed milestone')}</h2><p>${esc(selected.targetCapability || 'No target capability recorded.')}</p>${nextTargets.includes(selected.id) ? '<div class="detail-callout"><strong>This milestone is named by the current next-objective record.</strong><span>The relationship comes directly from state.nextStepTargets.</span></div>' : '<p class="empty-copy detail-empty">No additional evidence or note relationship is recorded for this milestone.</p>'}</section></div>${sourceLine(topic)}`;
}

function renderUnderstanding(topic) {
  const state = topic.state;
  const established = topic.concepts.filter((concept) => ['demonstrated', 'completed'].includes(String(concept.status).toLowerCase()));
  const conceptQuestions = topic.concepts.filter((concept) => concept.openQuestion).map((concept) => concept.name);
  const uncertainty = [...state.unassessed, ...conceptQuestions.filter((item) => !state.unassessed.includes(item))];
  const evidence = Array.isArray(topic.evidence) ? topic.evidence.filter((item) => item.summary || item.result) : [];
  const evidenceMarkup = evidence.length ? `<ul class="evidence-list">${evidence.map((item) => `<li><div><strong>${esc(item.concept || 'Learning evidence')}</strong><small>${esc(readableLabel(item.type || 'evidence'))}${item.observedAt ? ` - ${esc(formatDate(item.observedAt))}` : ''}</small></div><p>${esc(item.summary || `${item.result || 'Recorded'} evidence`)}</p></li>`).join('')}</ul>` : '';
  const progress = roadmapProgress(topic.roadmap);
  const currentFocus = explicitTopicComplete(topic) ? '' : `<section class="state-focus compact-focus"><span class="section-kicker">Current focus</span><p>${esc(state.currentFocus || 'No current focus recorded.')}</p></section>`;
  return `${pageHeader(topic, 'UNDERSTANDING', 'How Lattice understands you', 'Read-only, based on the committed learner model.')}<div class="state-layout"><section class="understanding-summary"><div><span class="section-kicker">Established</span><strong>${established.length}</strong><span>concepts</span></div><div><span class="section-kicker">Uncertain</span><strong>${uncertainty.length}</strong><span>items</span></div><div><span class="section-kicker">Roadmap</span><strong>${progress.demonstrated}/${progress.total}</strong><span>demonstrated</span></div></section>${currentFocus}<section class="state-section established"><div class="state-section-heading"><div><span class="section-kicker">Established understanding</span><h2>What appears well understood</h2></div><span class="section-count">${established.length} ${established.length === 1 ? 'concept' : 'concepts'}</span></div>${established.length ? `<ul class="concept-list">${established.map((concept) => `<li><span class="concept-check" aria-hidden="true">&#10003;</span><span class="concept-copy"><strong>${esc(concept.name)}</strong><small>${concept.evidenceCount} evidence ${concept.evidenceCount === 1 ? 'record' : 'records'}</small></span></li>`).join('')}</ul>` : '<p class="empty-copy compact-empty">No demonstrated concepts recorded.</p>'}</section><section class="state-section uncertain"><div class="state-section-heading"><div><span class="section-kicker">Still uncertain</span><h2>What remains unclear</h2></div><span class="section-count">${uncertainty.length} ${uncertainty.length === 1 ? 'item' : 'items'}</span></div>${uncertainty.length ? list(uncertainty) : '<p class="empty-copy compact-empty">No open uncertainty recorded.</p>'}</section>${state.misconceptions.length ? `<section class="state-section misconceptions"><div class="state-section-heading"><div><span class="section-kicker">Misconceptions</span><h2>Corrections to revisit</h2></div></div>${list(state.misconceptions)}</section>` : ''}<section class="state-section next-objective"><div><span class="section-kicker">Next objective</span><p class="objective-copy">${esc(state.nextStep || 'No next objective recorded.')}</p><details class="assessment-details"><summary>Why this is next</summary><p>${esc(state.nextStepReason || 'No reason has been recorded for this objective.')}</p></details></div><a class="text-link" href="#roadmap">See roadmap <span aria-hidden="true">-&gt;</span></a></section>${evidence.length ? `<details class="evidence-details"><summary>Supporting evidence <span>${evidence.length} records</span></summary>${evidenceMarkup}</details>` : '<p class="empty-copy compact-empty">No supporting evidence recorded.</p>'}<footer class="state-footer"><span>Read-only learner model</span><details class="assessment-details"><summary>Target capability</summary><p>${esc(state.targetCapability || 'No target capability recorded.')}</p></details></footer></div>${sourceLine(topic)}`;
}

function renderNotes(topic) {
  if (!selectedNoteId) selectedNoteId = selectedNoteByTopic.get(topic.id) || topic.notes[0]?.id || randomId('note');
  selectedNoteByTopic.set(topic.id, selectedNoteId);
  const selected = topic.notes.find((note) => note.id === selectedNoteId) || null;
  const draft = draftFor(topic, selected);
  const title = selected ? selected.title : 'New note';
  const noteRows = topic.notes.map((note) => `<button class="note-index-row ${note.id === selected?.id ? 'selected' : ''}" data-note="${esc(note.id)}" aria-current="${note.id === selected?.id ? 'true' : 'false'}"><span class="note-index-title">${esc(note.title)}</span>${note.preview ? `<span class="note-index-preview">${esc(note.preview)}</span>` : ''}<span class="note-index-meta">${esc(readableLabel(note.index.claimStatus || note.index.kind || 'note'))} - ${esc(formatDate(note.index.updatedAt))}</span></button>`).join('');
  const conflictMarkup = draft.status === 'conflict' ? `<aside class="note-conflict" data-note-conflict><strong>Latest committed version is available.</strong><span>Your draft remains in the editor until you choose what to do.</span>${draft.latest ? `<details><summary>View latest</summary><div class="note-conflict-latest"><strong>${esc(resolveLatestTitle(draft.latest))}</strong><pre>${esc(draft.latest.body)}</pre></div></details>` : '<span>The note was removed from the committed vault.</span>'}<div class="note-conflict-actions"><button class="button-secondary" type="button" data-reload-latest>Reload latest</button></div></aside>` : '';
  const draftNotice = selected && draft.dirty && !draft.editing ? `<aside class="note-draft-notice" data-draft-notice><strong>Unsaved draft available.</strong><span>The document below is the committed version.</span><button class="button-secondary" type="button" data-edit-note>Continue editing</button></aside>` : '';
  const editor = `<form class="note-form" data-note-form><label>Title<input name="title" maxlength="240" value="${esc(draft.title)}" placeholder="Optional note title"></label><label>Markdown<textarea name="body" maxlength="1048576" required>${esc(draft.body)}</textarea></label><div class="note-form-meta"><label>Kind<select name="kind"><option value="" ${draft.kind ? '' : 'selected'}>Unspecified</option><option value="learning_note" ${draft.kind === 'learning_note' ? 'selected' : ''}>Learning note</option><option value="working_model" ${draft.kind === 'working_model' ? 'selected' : ''}>Working model</option></select></label><label>Claim status<select name="claimStatus"><option value="" ${draft.claimStatus ? '' : 'selected'}>Unspecified</option><option value="working_model" ${draft.claimStatus === 'working_model' ? 'selected' : ''}>Working model</option><option value="confirmed" ${draft.claimStatus === 'confirmed' ? 'selected' : ''}>Confirmed</option></select></label></div><div class="note-form-actions"><button class="button-primary" type="submit" data-save-note>Save</button><button class="button-secondary" type="button" data-cancel-note ${draft.inFlight ? 'disabled' : ''}>Cancel</button><span class="note-form-hint">Source metadata and unknown state fields are preserved.</span></div><p class="note-form-message" data-note-message>${esc(draft.error || draft.message)}</p></form>`;
  const reader = selected ? `${draftNotice}${draft.message ? `<p class="note-save-message" data-note-message>${esc(draft.message)}</p>` : ''}<div class="markdown note-markdown" data-note-markdown>${selected.html || '<p class="empty-copy">This note is empty.</p>'}</div>${draft.dirty ? '' : '<div class="note-reader-actions"><button class="button-primary" type="button" data-edit-note>Edit</button></div>'}` : editor;
  const mode = draft.editing || !selected ? editor : reader;
  return `${pageHeader(topic, 'NOTES', 'Knowledge library', 'Read committed notes or edit them with revision-aware saves.')}<div class="notes-layout"><div class="note-index"><div class="section-heading"><div><span class="section-kicker">Notes</span><h2>${topic.notes.length} ${topic.notes.length === 1 ? 'note' : 'notes'}</h2></div><div class="note-index-actions"><button class="button-secondary" data-refresh-notes type="button">Refresh</button><button class="button-secondary" data-new-note type="button">New note</button></div></div>${noteRows || '<p class="empty-copy note-index-empty">No notes yet.</p>'}</div><article class="note-reader note-editor"><div class="note-reader-top"><div><span class="section-kicker">${draft.editing ? (selected ? 'Editing note' : 'Creating note') : 'Committed note'}</span><h2>${esc(draft.editing ? (draft.title || title) : title)}</h2></div>${draft.editing || draft.dirty || draft.status === 'saved' ? `<span class="note-status ${esc(draft.status)}" data-note-status>${esc(draftStatusLabel(draft))}</span>` : ''}</div>${conflictMarkup}${mode}<details class="source-details note-source-details"><summary>Revision and provenance</summary><div class="note-source"><span>State revision</span><code>${esc(draft.expectedStateRevision)}</code><span>Note revision</span><code>${esc(draft.expectedRevision || 'new file')}</code><span>Origin</span><code>user</code></div></details></article></div>${sourceLine(topic)}`;
}

function resolveLatestTitle(note) {
  return note?.index?.title || note?.id || 'Latest note';
}

function paint(view, topic) {
  renderedTopic = topic;
  app.innerHTML = view === 'roadmap' ? renderRoadmap(topic) : view === 'notes' ? renderNotes(topic) : view === 'understanding' ? renderUnderstanding(topic) : renderStudy(topic);
  bindInteractions();
  if (view === 'notes') startNotesRefresh();
  else stopNotesRefresh();
}

async function render() {
  const view = location.hash.slice(1) || 'study';
  nav.querySelectorAll('[data-view]').forEach((link) => link.classList.toggle('active', link.dataset.view === view));
  const activeNavigation = nav.querySelector('[data-view].active');
  if (activeNavigation && nav.scrollWidth > nav.clientWidth) requestAnimationFrame(() => activeNavigation.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }));
  app.innerHTML = '<div class="loading-state"><span class="loading-line"></span><span>Loading committed vault data...</span></div>';
  try {
    if (view === 'topics') { location.hash = '#study'; return; }
    const topic = await loadTopic();
    if (!topic) {
      app.innerHTML = emptyState('No topics available', 'The configured vault has no readable topic bindings.');
      return;
    }
    paint(view, topic);
  } catch (error) {
    console.error('Lattice view projection failed', error);
    app.innerHTML = `<section class="error-state"><span class="empty-mark">!</span><h1>Projection unavailable</h1><p>The vault is ready, but this view could not be projected from its committed records.</p><p class="empty-copy">Optional or malformed data in this view was not displayed. Canonical learning data was not modified.</p></section>`;
  }
}

function bindInteractions() {
  app.querySelectorAll('[data-topic]').forEach((button) => button.addEventListener('click', () => setActiveTopic(button.dataset.topic)));
  app.querySelectorAll('[data-roadmap]').forEach((button) => button.addEventListener('click', async () => {
    selectedRoadmapId = button.dataset.roadmap;
    await render();
    if (matchMedia('(max-width: 820px)').matches) {
      const detail = document.querySelector('#roadmap-detail');
      detail?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      detail?.focus({ preventScroll: true });
    }
  }));
  app.querySelectorAll('[data-note]').forEach((button) => button.addEventListener('click', () => {
    const previous = noteDrafts.get(draftKey(activeTopic, selectedNoteId));
    if (previous?.dirty) previous.editing = false;
    selectedNoteId = button.dataset.note;
    selectedNoteByTopic.set(activeTopic, selectedNoteId);
    render();
  }));
  app.querySelector('[data-new-note]')?.addEventListener('click', () => {
    const previous = noteDrafts.get(draftKey(activeTopic, selectedNoteId));
    if (previous?.dirty) previous.editing = false;
    selectedNoteId = randomId('note');
    selectedNoteByTopic.set(activeTopic, selectedNoteId);
    noteDrafts.delete(draftKey(activeTopic, selectedNoteId));
    render();
  });
  app.querySelector('[data-refresh-notes]')?.addEventListener('click', () => { refreshNotes().catch(() => {}); });
  app.querySelectorAll('[data-edit-note]').forEach((button) => button.addEventListener('click', () => {
    const draft = noteDrafts.get(draftKey(activeTopic, selectedNoteId));
    if (!draft) return;
    draft.editing = true;
    draft.message = '';
    render();
  }));
  const form = app.querySelector('[data-note-form]');
  const cancelDraft = () => {
    const draft = noteDrafts.get(draftKey(activeTopic, selectedNoteId));
    if (!draft) return;
    if (draft.dirty && !window.confirm('Discard this unsaved draft?')) return;
    const wasNew = !renderedTopic?.notes.some((note) => note.id === selectedNoteId);
    noteDrafts.delete(draftKey(activeTopic, selectedNoteId));
    if (wasNew) {
      selectedNoteId = renderedTopic?.notes[0]?.id || '';
      selectedNoteByTopic.set(activeTopic, selectedNoteId);
    }
    render();
  };
  app.querySelector('[data-cancel-note]')?.addEventListener('click', cancelDraft);
  app.querySelector('[data-reload-latest]')?.addEventListener('click', () => {
    const draft = noteDrafts.get(draftKey(activeTopic, selectedNoteId));
    const latest = draft?.latest;
    if (latest) noteDrafts.set(draftKey(activeTopic, selectedNoteId), createDraft(renderedTopic, latest));
    else noteDrafts.delete(draftKey(activeTopic, selectedNoteId));
    render();
  });
  if (!form) return;
  const topicId = activeTopic;
  const noteId = selectedNoteId;
  const key = draftKey(topicId, noteId);
  const updateDraft = () => {
    const current = noteDrafts.get(key);
    if (!current) return;
    if (current.failedVersion !== null) {
      rotateRequestIds(current);
      current.failedVersion = null;
    }
    current.title = form.elements.title.value;
    current.body = form.elements.body.value;
    current.kind = form.elements.kind.value;
    current.claimStatus = form.elements.claimStatus.value;
    current.version += 1;
    current.dirty = true;
    if (current.status !== 'conflict') current.status = 'draft';
    current.error = '';
    current.message = '';
    const status = app.querySelector('[data-note-status]');
    if (status) { status.textContent = draftStatusLabel(current); status.className = `note-status ${current.status}`; }
    const message = app.querySelector('[data-note-message]');
    if (message) message.textContent = '';
  };
  form.querySelectorAll('input, textarea, select').forEach((field) => field.addEventListener('input', updateDraft));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const draft = noteDrafts.get(key);
    if (!draft || draft.inFlight) return;
    if (!draft.body.trim()) {
      draft.status = 'error';
      draft.error = 'Note body is required.';
      await render();
      return;
    }
    const payload = Object.freeze({
      body: draft.body,
      title: draft.title,
      kind: draft.kind,
      claimStatus: draft.claimStatus,
      sources: structuredClone(draft.sources),
      expectedRevision: draft.expectedRevision,
      expectedStateRevision: draft.expectedStateRevision,
      operationId: draft.operationId,
      updateId: draft.updateId,
    });
    const submission = { version: draft.version, payload };
    draft.inFlight = submission;
    draft.status = 'saving';
    draft.error = '';
    draft.message = '';
    await render();
    try {
      const result = await putJson(`/api/topics/${encodeURIComponent(topicId)}/notes/${encodeURIComponent(noteId)}`, payload);
      const latestTopic = await getJson(`/api/topics/${encodeURIComponent(topicId)}`);
      const committed = latestTopic.notes.find((note) => note.id === noteId);
      draft.expectedRevision = committed?.revision ?? null;
      draft.expectedStateRevision = latestTopic.source.stateRevision;
      draft.inFlight = null;
      draft.error = '';
      draft.failedVersion = null;
      rotateRequestIds(draft);
      if (draft.version === submission.version) {
        draft.status = 'saved';
        draft.dirty = false;
        draft.editing = false;
        draft.message = result.saved === true ? 'Saved to the committed vault.' : 'Save completed.';
      } else {
        draft.status = 'draft';
        draft.dirty = true;
      }
      await render();
    } catch (error) {
      draft.inFlight = null;
      if (draft.version === submission.version) draft.failedVersion = submission.version;
      else {
        draft.failedVersion = null;
        rotateRequestIds(draft);
      }
      draft.status = error.status === 409 ? 'conflict' : 'error';
      draft.error = error.message;
      await render();
    }
  });
}

select.addEventListener('change', () => setActiveTopic(select.value));
window.addEventListener('hashchange', () => {
  if ((location.hash.slice(1) || 'study') !== 'notes') {
    for (const draft of noteDrafts.values()) if (draft.dirty) draft.editing = false;
  }
  render();
});
window.addEventListener('focus', () => { refreshNotes().catch(() => {}); });
window.addEventListener('beforeunload', (event) => {
  if (![...noteDrafts.values()].some((draft) => draft.dirty)) return;
  event.preventDefault();
  event.returnValue = '';
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshNotes().catch(() => {}); });
getJson('/api/topics').then((data) => {
  setTopics(data);
  connection.innerHTML = '<span class="status-dot"></span>Vault ready';
  connection.className = 'status ready';
  render();
}).catch((error) => {
  connection.innerHTML = '<span class="status-dot"></span>Vault unavailable';
  connection.className = 'status error';
  app.innerHTML = `<section class="error-state"><span class="empty-mark">!</span><h1>Vault unavailable</h1><p>${esc(error.message)}</p></section>`;
});
