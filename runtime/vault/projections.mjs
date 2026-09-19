function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function safeHref(value) {
  const href = String(value).trim();
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

export function renderMarkdown(markdown, options = {}) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  const suppressedHeading = normalizeHeading(options.suppressLeadingHeading);
  let hasVisibleContent = false;
  let inCode = false;
  let code = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(' ').trim();
    if (text) output.push(`<p>${inlineMarkdown(text)}</p>`);
    paragraph = [];
  };
  const listLine = (line) => {
    const match = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    return match ? { indent: match[1].replace(/\t/g, '    ').length, ordered: /\d+\./.test(match[2]), text: match[3] } : null;
  };
  const renderList = (start, indent, ordered) => {
    const items = [];
    let index = start;
    while (index < lines.length) {
      const entry = listLine(lines[index]);
      if (!entry || entry.indent < indent || (entry.indent === indent && entry.ordered !== ordered)) break;
      if (entry.indent > indent) {
        if (!items.length) break;
        const nested = renderList(index, entry.indent, entry.ordered);
        items[items.length - 1].nested.push(nested.html);
        index = nested.index;
        continue;
      }
      items.push({ text: entry.text, nested: [] });
      index += 1;
    }
    const tag = ordered ? 'ol' : 'ul';
    return { index, html: `<${tag}>${items.map((item) => `<li>${inlineMarkdown(item.text)}${item.nested.join('')}</li>`).join('')}</${tag}>` };
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line)) {
      if (inCode) { output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = []; inCode = false; }
      else { flushParagraph(); inCode = true; }
    } else if (inCode) code.push(line);
    else if (/^#{1,6}\s/.test(line)) {
      flushParagraph();
      const match = line.match(/^(#{1,6})\s+(.*)$/);
      if (!hasVisibleContent && suppressedHeading && normalizeHeading(match[2]) === suppressedHeading) {
        hasVisibleContent = true;
        continue;
      }
      output.push(`<h${match[1].length}>${inlineMarkdown(match[2])}</h${match[1].length}>`);
      hasVisibleContent = true;
    }
    else if (listLine(line)) {
      flushParagraph();
      const entry = listLine(line);
      const rendered = renderList(index, entry.indent, entry.ordered);
      output.push(rendered.html);
      hasVisibleContent = true;
      index = rendered.index - 1;
    }
    else if (!line.trim()) flushParagraph();
    else { paragraph.push(line); hasVisibleContent = true; }
  }
  if (inCode) output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushParagraph();
  return output.join('\n');
}

function normalizeHeading(value) {
  return String(value || '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function inlineMarkdown(text) {
  let value = escapeHtml(text);
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safe = safeHref(href);
    return safe ? `<a href="${escapeHtml(safe)}" rel="noreferrer noopener">${label}</a>` : label;
  });
  value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return value;
}

function firstHeading(body) {
  const heading = String(body || '').match(/^#{1,6}\s+(.+?)\s*$/m);
  return heading?.[1]?.trim() || '';
}

function humanizeFilename(value) {
  const filename = String(value || '').split(/[\\/]/).pop() || '';
  return filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Untitled note';
}

function notePreview(body) {
  const plain = String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+.*$/gm, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 170 ? `${plain.slice(0, 167).trimEnd()}...` : plain;
}

function sessionContent(body) {
  return String(body || '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:Update ID|Base state revision|Session ID)\s*:/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sessionSource(body, id, revision) {
  const text = String(body || '');
  const value = (label) => text.split(/\r?\n/)
    .find((line) => new RegExp(`^\\s*${label}\\s*:`, 'i').test(line))
    ?.replace(new RegExp(`^\\s*${label}\\s*:\\s*`, 'i'), '')
    .replace(/^`|`$/g, '').trim() || '';
  return { sessionId: id || '', updateId: value('Update ID'), baseRevision: value('Base state revision'), revision: revision || '' };
}

export function resolveNoteTitle(note) {
  const index = note?.index && typeof note.index === 'object' ? note.index : {};
  const explicit = typeof index.title === 'string' ? index.title.trim() : '';
  if (explicit) return explicit;
  const heading = firstHeading(note?.body);
  if (heading) return heading;
  return humanizeFilename(index.filename || index.path || index.kind || note?.id);
}

export function resolveNotePreview(body) {
  return notePreview(body);
}

export function countUnknownStateFields(state) {
  const known = new Set(['schemaVersion', 'documentType', 'vaultId', 'id', 'title', 'goal', 'targetCapability', 'scope', 'nonGoals', 'roadmap', 'currentFocus', 'knownGaps', 'unassessed', 'misconceptions', 'nextStep', 'nextStepReason', 'nextStepTargets', 'concepts', 'evidence', 'notes', 'sessions', 'appliedUpdates']);
  return Object.keys(state).filter((key) => !known.has(key));
}

export function projectTopic(topic) {
  const state = topic?.state && typeof topic.state === 'object' && !Array.isArray(topic.state) ? topic.state : {};
  const conceptsSource = state.concepts && typeof state.concepts === 'object' && !Array.isArray(state.concepts) ? state.concepts : {};
  const listValue = (item) => {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
    for (const key of ['summary', 'description', 'text', 'name', 'id']) {
      if (typeof item[key] === 'string' && item[key].trim()) return item[key].trim();
    }
    return '';
  };
  const stringList = (value) => Array.isArray(value) ? value.map(listValue).filter(Boolean) : [];
  const projectEvidenceList = (entries, conceptName = '') => (Array.isArray(entries) ? entries : [])
    .filter((evidence) => evidence && typeof evidence === 'object' && !Array.isArray(evidence))
    .map((evidence) => ({
      id: typeof evidence.id === 'string' ? evidence.id : '',
      concept: conceptName || (typeof evidence.concept === 'string' ? evidence.concept : ''),
      type: typeof evidence.type === 'string' ? evidence.type : '',
      result: typeof evidence.result === 'string' ? evidence.result : '',
      assistance: typeof evidence.assistance === 'string' ? evidence.assistance : '',
      summary: typeof evidence.summary === 'string' ? evidence.summary : '',
      observedAt: typeof evidence.observedAt === 'string' ? evidence.observedAt : '',
      sessionId: typeof evidence.sessionId === 'string' ? evidence.sessionId : '',
    }));
  const concepts = Object.values(conceptsSource)
    .filter((concept) => concept && typeof concept === 'object' && !Array.isArray(concept))
    .map((concept) => {
      const name = typeof concept.name === 'string' && concept.name.trim() ? concept.name.trim() : (typeof concept.id === 'string' && concept.id ? concept.id : 'Unnamed concept');
      return {
        id: typeof concept.id === 'string' ? concept.id : '', name, status: typeof concept.status === 'string' && concept.status.trim() ? concept.status : 'unclassified',
        openQuestion: concept.openQuestion === true, evidence: projectEvidenceList(concept.evidence, name),
        evidenceCount: Array.isArray(concept.evidence) ? concept.evidence.filter((evidence) => evidence && typeof evidence === 'object' && !Array.isArray(evidence)).length : 0,
      };
    });
  const evidence = [...concepts.flatMap((concept) => concept.evidence), ...projectEvidenceList(state.evidence)];
  return {
    id: topic?.id || '',
    title: typeof state.title === 'string' && state.title.trim() ? state.title : (topic?.id || 'Untitled topic'),
    stateRevision: topic?.stateRevision || '',
    state: {
      goal: typeof state.goal === 'string' ? state.goal : '', targetCapability: typeof state.targetCapability === 'string' ? state.targetCapability : '', currentFocus: typeof state.currentFocus === 'string' ? state.currentFocus : '',
      knownGaps: stringList(state.knownGaps), unassessed: stringList(state.unassessed),
      nextStep: typeof state.nextStep === 'string' ? state.nextStep : '', nextStepReason: typeof state.nextStepReason === 'string' ? state.nextStepReason : '', nextStepTargets: stringList(state.nextStepTargets),
      misconceptions: stringList(state.misconceptions),
    },
    concepts,
    evidence,
    unknownFields: countUnknownStateFields(state),
    roadmap: Array.isArray(state.roadmap) ? state.roadmap.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : null,
    notes: Array.isArray(topic?.notes) ? topic.notes.map((note) => {
      const title = resolveNoteTitle(note);
      return { id: note.id, title, preview: resolveNotePreview(note.body), index: note.index, revision: note.revision, html: renderMarkdown(note.body, { suppressLeadingHeading: title }) };
    }) : [],
    sessions: Array.isArray(topic?.sessions) ? topic.sessions.map((session) => {
      const content = sessionContent(session.body);
      const title = firstHeading(content) || 'Historical checkpoint';
      return { id: session.id, title, preview: resolveNotePreview(content), index: session.index, revision: session.revision, source: sessionSource(session.body, session.id, session.revision), html: renderMarkdown(content) };
    }) : [],
    source: { stateRevision: topic?.stateRevision || '', manifestRevision: topic?.manifestRevision || '' },
  };
}
