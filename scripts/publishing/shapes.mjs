/**
 * Article shapes: the structural template an article follows. The planner
 * picks one per brief, avoiding shapes used in the most recent articles, so
 * consecutive articles read differently. Each shape names the figure kinds
 * that tend to suit it.
 */
export const SHAPES = Object.freeze({
  'what-changed': {
    formats: ['news'],
    structure: `Open with the change itself in two or three sentences. Then: what was announced and when; what it changes
compared with before; who should act now and who can wait; and the open questions. Keep the announcement summary short.`,
    figures: ['timeline', 'comparison', 'stat'],
  },
  comparison: {
    formats: ['analysis', 'explainer'],
    structure: `Compare two to four options a team is choosing between. Open with the decision and who faces it. Organise
sections by decision criterion rather than by option, then recommend an option for each situation.`,
    figures: ['comparison', 'quadrant', 'chart'],
  },
  'decision-guide': {
    formats: ['analysis'],
    structure: `Open with the decision and the cost of getting it wrong. Each section is one question a team should ask, in
the order they should ask it. End with a clear rule of thumb and the cases where it does not apply.`,
    figures: ['decision', 'quadrant', 'comparison'],
  },
  'myth-vs-evidence': {
    formats: ['analysis'],
    structure: `Open with a belief practitioners commonly hold. Each section takes one belief, states what the sources actually
show, and what to do instead. Close with what remains genuinely uncertain.`,
    figures: ['stat', 'chart', 'comparison'],
  },
  playbook: {
    formats: ['explainer'],
    structure: `A practical how-to. Open with the outcome and the prerequisites. Sections are ordered steps, each saying what
to do, how to tell it worked, and a common mistake. Close with a short checklist.`,
    figures: ['flow', 'decision'],
  },
  'how-it-works': {
    formats: ['explainer'],
    structure: `Explain a mechanism. Open with a concrete scenario where it matters. Build from the simplest piece to the full
picture, then cover the failure modes and how to diagnose them.`,
    figures: ['flow', 'quadrant', 'comparison'],
  },
  'field-guide': {
    formats: ['analysis', 'explainer'],
    structure: `Map a landscape: the categories of approach, where each fits, and the signals that tell a team which one it
needs. Do not list products for their own sake.`,
    figures: ['quadrant', 'comparison', 'flow'],
  },
});

export const SHAPE_NAMES = Object.keys(SHAPES);
const RECENT = 3;

/** Shapes used by the most recent automated articles, newest first. */
export function recentShapes(corpus, count = RECENT) {
  return [...corpus]
    .filter(({ data }) => data.shape)
    .sort((a, b) => new Date(b.data.publishDate) - new Date(a.data.publishDate))
    .slice(0, count)
    .map(({ data }) => data.shape);
}

/**
 * Shapes the planner may use for these formats. Recently used shapes are
 * excluded unless that would leave a format with none.
 */
export function availableShapes(formats, recent = []) {
  const allowed = SHAPE_NAMES.filter((name) => SHAPES[name].formats.some((format) => formats.includes(format)));
  const fresh = allowed.filter((name) => !recent.includes(name));
  const covers = formats.every((format) => fresh.some((name) => SHAPES[name].formats.includes(format)));
  return covers ? fresh : allowed;
}
