import type {
  AnswerChoice,
  ModuleStep,
  SectionQuiz,
  TrainingAttachment,
  TrainingModule,
  TrainingQuestion
} from './trainingTypes';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectString(obj: Record<string, unknown>, key: string, label: string): string {
  const v = obj[key];
  if (typeof v !== 'string') {
    throw new Error(`${label} must have string "${key}".`);
  }
  return v;
}

function parseAttachment(raw: unknown, path: string): TrainingAttachment {
  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object.`);
  }
  const attachmentType = raw.attachmentType;
  if (attachmentType !== 'pdf' && attachmentType !== 'link' && attachmentType !== 'video' && attachmentType !== 'audio') {
    throw new Error(`${path}.attachmentType must be pdf, link, video, or audio.`);
  }
  return {
    id: expectString(raw, 'id', path),
    title: expectString(raw, 'title', path),
    url: expectString(raw, 'url', path),
    attachmentType,
    renderInline: typeof raw.renderInline === 'boolean' ? raw.renderInline : undefined
  };
}

function parseAnswerChoice(raw: unknown, path: string): AnswerChoice {
  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object.`);
  }
  return {
    id: expectString(raw, 'id', path),
    answerText: expectString(raw, 'answerText', path),
    answerTrueFalse: Boolean(raw.answerTrueFalse),
    answerOrdinal: expectString(raw, 'answerOrdinal', path)
  };
}

function parseQuestion(raw: unknown, path: string): TrainingQuestion {
  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object.`);
  }
  const choicesRaw = raw.answerChoices;
  if (!Array.isArray(choicesRaw) || choicesRaw.length === 0) {
    throw new Error(`${path}.answerChoices must be a non-empty array.`);
  }
  const answerChoices = choicesRaw.map((c, i) => parseAnswerChoice(c, `${path}.answerChoices[${i}]`));
  const qn =
    typeof raw.questionNumber === 'number'
      ? raw.questionNumber
      : Number(raw.questionNumber);
  if (!Number.isFinite(qn) || qn < 1) {
    throw new Error(`${path}.questionNumber must be a positive number.`);
  }
  return {
    id: expectString(raw, 'id', path),
    questionNumber: qn,
    questionText: expectString(raw, 'questionText', path),
    answerText: expectString(raw, 'answerText', path),
    answerOrdinal: expectString(raw, 'answerOrdinal', path),
    answerChoices
  };
}

function parseSectionQuiz(raw: unknown, path: string): SectionQuiz {
  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object.`);
  }
  const questionsRaw = raw.questions;
  if (!Array.isArray(questionsRaw)) {
    throw new Error(`${path}.questions must be an array.`);
  }
  const questions = questionsRaw.map((q, i) => parseQuestion(q, `${path}.questions[${i}]`));
  const est =
    typeof raw.estimatedDurationMinutes === 'number'
      ? raw.estimatedDurationMinutes
      : Number(raw.estimatedDurationMinutes);
  return {
    id: expectString(raw, 'id', path),
    title: expectString(raw, 'title', path),
    sectionId: expectString(raw, 'sectionId', path),
    estimatedDurationMinutes: Number.isFinite(est) && est >= 0 ? est : 0,
    questions,
    quizTakes: []
  };
}

function parseModuleStep(raw: unknown, path: string): ModuleStep {
  if (!isRecord(raw)) {
    throw new Error(`${path} must be an object.`);
  }
  const attachmentsRaw = raw.attachments;
  const attachments = Array.isArray(attachmentsRaw)
    ? attachmentsRaw.map((a, i) => parseAttachment(a, `${path}.attachments[${i}]`))
    : [];
  const step: ModuleStep = {
    id: expectString(raw, 'id', path),
    title: expectString(raw, 'title', path),
    subtitle: typeof raw.subtitle === 'string' ? raw.subtitle : '',
    copy: typeof raw.copy === 'string' ? raw.copy : '',
    attachments
  };
  if (raw.sectionQuiz !== undefined && raw.sectionQuiz !== null) {
    step.sectionQuiz = parseSectionQuiz(raw.sectionQuiz, `${path}.sectionQuiz`);
  }
  return step;
}

/**
 * Normalizes and validates a parsed JSON object as a TrainingModule.
 */
export function parseTrainingModuleFromUnknown(parsed: unknown): TrainingModule {
  if (!isRecord(parsed)) {
    throw new Error('Root value must be a JSON object.');
  }

  const id = expectString(parsed, 'id', 'Module');
  const title = expectString(parsed, 'title', 'Module');
  const modulePurpose =
    typeof parsed.modulePurpose === 'string' ? parsed.modulePurpose : '';
  const defaultRequired = Boolean(parsed.defaultRequired);

  const attachmentsRaw = parsed.attachments;
  const attachments = Array.isArray(attachmentsRaw)
    ? attachmentsRaw.map((a, i) => parseAttachment(a, `attachments[${i}]`))
    : [];

  const moduleStepsRaw = parsed.moduleSteps;
  if (!Array.isArray(moduleStepsRaw)) {
    throw new Error('moduleSteps must be an array.');
  }
  const moduleSteps = moduleStepsRaw.map((s, i) => parseModuleStep(s, `moduleSteps[${i}]`));

  return {
    id,
    title,
    modulePurpose,
    defaultRequired,
    attachments,
    moduleSteps,
    archived: typeof parsed.archived === 'boolean' ? parsed.archived : undefined,
    archivedAt: typeof parsed.archivedAt === 'string' ? parsed.archivedAt : undefined,
    archivedBy: typeof parsed.archivedBy === 'string' ? parsed.archivedBy : undefined
  };
}

export type ParseModuleLibraryJsonResult =
  | { ok: true; modules: TrainingModule[] }
  | { ok: false; error: string };

export function isModuleLibraryParseFailure(
  r: ParseModuleLibraryJsonResult
): r is { ok: false; error: string } {
  return r.ok === false;
}

/**
 * Parses a JSON array of module objects; each entry is validated like a single-module import.
 */
export function parseModuleLibraryPaste(raw: string): ParseModuleLibraryJsonResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: 'Paste a JSON array of module objects.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (jsonErr) {
    const jsonMessage = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
    return { ok: false, error: `Invalid JSON: ${jsonMessage}` };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'Root value must be a JSON array of modules.' };
  }

  const modules: TrainingModule[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < parsed.length; index += 1) {
    try {
      const module = parseTrainingModuleFromUnknown(parsed[index]);
      if (seenIds.has(module.id)) {
        return { ok: false, error: `Duplicate module id "${module.id}" at index ${index}.` };
      }
      seenIds.add(module.id);
      modules.push(module);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Validation failed';
      return { ok: false, error: `modules[${index}]: ${message}` };
    }
  }

  return { ok: true, modules };
}

export type ParseTrainingModuleJsonResult =
  | { ok: true; module: TrainingModule; parseMethod: 'json' | 'javascript' }
  | { ok: false; error: string };

export function isTrainingModuleParseFailure(
  r: ParseTrainingModuleJsonResult
): r is { ok: false; error: string } {
  return r.ok === false;
}

function stripTrailingSemicolon(s: string): string {
  let t = s.trim();
  if (t.endsWith(';')) {
    t = t.slice(0, -1).trim();
  }
  return t;
}

/**
 * Strips common copy-paste wrappers so `{ id: 'x' }` can follow `export default` or `const m =`.
 */
export function stripModulePasteWrappers(s: string): string {
  let t = s.trim();
  if (t.startsWith('export default')) {
    t = t.slice('export default'.length).trim();
  }
  if (t.startsWith('module.exports')) {
    const eq = t.indexOf('=');
    if (eq >= 0) {
      t = t.slice(eq + 1).trim();
    }
  }
  const assignMatch = /^(const|let|var)\s+[\w$]+\s*=\s*/.exec(t);
  if (assignMatch) {
    t = t.slice(assignMatch[0].length).trim();
  }
  return stripTrailingSemicolon(t);
}

/**
 * Evaluates a JavaScript object literal/expression (single quotes, string concat, trailing commas).
 * Trusted tenant-admin paste only; do not use on untrusted input.
 */
function tryParseJavaScriptObjectExpression(source: string): unknown {
  const trimmed = stripModulePasteWrappers(source);
  const body = stripTrailingSemicolon(trimmed);
  if (!body.startsWith('{')) {
    throw new Error(
      'Expected an object starting with { (after trimming export/default/const).'
    );
  }
  const fn = new Function(`"use strict"; return (${body});`);
  const result = fn();
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Expression must evaluate to a plain object (not null or array).');
  }
  return result;
}

/**
 * Parses strict JSON first, then a JavaScript object literal, then validates TrainingModule shape.
 */
export function parseModulePasteToTrainingModule(raw: string): ParseTrainingModuleJsonResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: 'Paste a module object (JSON or JavaScript object literal).' };
  }

  let parsed: unknown;
  let parseMethod: 'json' | 'javascript';

  try {
    parsed = JSON.parse(trimmed);
    parseMethod = 'json';
  } catch (jsonErr) {
    const jsonMessage = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
    try {
      parsed = tryParseJavaScriptObjectExpression(trimmed);
      parseMethod = 'javascript';
    } catch (jsErr) {
      const jsMessage = jsErr instanceof Error ? jsErr.message : String(jsErr);
      return {
        ok: false,
        error: `Could not parse as JSON (${jsonMessage}) or as a JavaScript object (${jsMessage}).`
      };
    }
  }

  try {
    const module = parseTrainingModuleFromUnknown(parsed);
    return { ok: true, module, parseMethod };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Validation failed';
    return {
      ok: false,
      error: `Parsed as ${parseMethod === 'json' ? 'JSON' : 'JavaScript'}, but module is invalid: ${message}`
    };
  }
}

/**
 * @deprecated Use parseModulePasteToTrainingModule — same behavior, returns parseMethod when ok.
 */
export function parseTrainingModuleJson(raw: string): ParseTrainingModuleJsonResult {
  return parseModulePasteToTrainingModule(raw);
}
