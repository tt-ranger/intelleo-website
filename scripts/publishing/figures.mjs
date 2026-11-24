/**
 * In-article figures: typed specs from the writer, validated here, drawn as
 * SVG and encoded as WebP. Figures that carry numbers or dates must quote the
 * source passage that states them, like the claim ledger.
 */
import sharp from 'sharp';

export const FIGURE_KINDS = ['flow', 'decision', 'comparison', 'timeline', 'quadrant', 'chart', 'stat'];
const SOURCED = new Set(['timeline', 'chart', 'stat']);
export const WIDTH = 1200;

const C = {
  bg: '#0E1320', panel: '#121828', panel2: '#18203A', line: '#2A3552',
  text: '#E8ECF4', muted: '#8A93AB', copper: '#E0935A', bright: '#F2B07C',
};
const FONT = 'DejaVu Sans, sans-serif';

const clean = (value = '') => String(value).replace(/\s+/g, ' ').trim();
const xml = (value) => clean(value).replace(/[<>&"']/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/** Greedy word wrap by an approximate character budget for the given pixel width. */
export function wrap(text, width, size, maxLines = 3) {
  const limit = Math.max(6, Math.floor(width / (size * 0.56)));
  const lines = [];
  let line = '';
  for (const word of clean(text).split(' ')) {
    if (line && line.length + 1 + word.length > limit) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\s*\S*$/, '')}…`;
  }
  return lines;
}

/** Multi-line <text> block. `anchor` is start|middle; y is the first baseline unless `center` is set. */
function textBlock(text, { x, y, width, size = 20, color = C.text, weight = 'normal', anchor = 'start', maxLines = 3, center = false }) {
  const lines = wrap(text, width, size, maxLines);
  const lead = size * 1.28;
  const top = center ? y - ((lines.length - 1) * lead) / 2 + size * 0.35 : y;
  const spans = lines.map((line, i) => `<tspan x="${x}" y="${(top + i * lead).toFixed(1)}">${xml(line)}</tspan>`).join('');
  return `<text font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${spans}</text>`;
}

const len = (value, min, max) => clean(value).length >= min && clean(value).length <= max;

function fail(index, message) {
  throw new Error(`Figure ${index + 1}: ${message}`);
}

function checkQuote(item, sources, index) {
  const source = sources.find(({ id }) => id === item.sourceId);
  const quote = clean(item.excerpt);
  if (!source || quote.length < 12 || !source.excerpts.some((line) => clean(line).includes(quote))) {
    fail(index, 'each sourced value needs a source ID and an exact quote from that source.');
  }
  return quote;
}

function numbersIn(quote) {
  return (quote.replace(/(?<=\d),(?=\d)/g, '').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** Validate figure specs against their kind's rules. Throws a message the writer can act on. */
export function validateFigures(figures, sources) {
  if (!Array.isArray(figures) || figures.length < 1 || figures.length > 3) {
    throw new Error('Supply one to three figures.');
  }
  if (new Set(figures.map(({ kind }) => kind)).size !== figures.length) {
    throw new Error('Use a different kind for each figure.');
  }
  figures.forEach((figure, index) => {
    const { kind, items = [], columns = [], axes = {} } = figure;
    if (!FIGURE_KINDS.includes(kind)) fail(index, `kind must be one of ${FIGURE_KINDS.join(', ')}.`);
    if (!len(figure.title, 4, 80)) fail(index, 'title must be 4–80 characters.');
    if (!len(figure.caption, 20, 220)) fail(index, 'caption must be 20–220 characters.');
    if (!len(figure.alt, 12, 200)) fail(index, 'alt text must be 12–200 characters.');
    const count = (min, max) => {
      if (items.length < min || items.length > max) fail(index, `${kind} needs ${min === max ? min : `${min}–${max}`} items.`);
    };
    const labels = (min, max) => items.forEach((item) => {
      if (!len(item.label, min, max)) fail(index, `${kind} item labels must be ${min}–${max} characters.`);
    });
    const details = (min, max) => items.forEach((item) => {
      if (!len(item.detail, min, max)) fail(index, `${kind} item details must be ${min}–${max} characters.`);
    });
    switch (kind) {
      case 'flow': count(2, 5); labels(3, 40); details(0, 90); break;
      case 'decision': count(2, 4); labels(6, 70); details(3, 70); break;
      case 'comparison':
        if (columns.length < 2 || columns.length > 4 || columns.some((column) => !len(column, 1, 24))) {
          fail(index, 'comparison needs 2–4 column headings of 1–24 characters.');
        }
        count(2, 6); labels(2, 28);
        items.forEach((item) => {
          if (item.cells?.length !== columns.length || item.cells.some((cell) => !len(cell, 1, 48))) {
            fail(index, 'each comparison row needs one 1–48 character cell per column.');
          }
        });
        break;
      case 'timeline': count(2, 6); labels(3, 20); details(4, 70); break;
      case 'quadrant':
        count(4, 4); labels(2, 28); details(0, 80);
        if (!len(axes.x, 3, 40) || !len(axes.y, 3, 40)) fail(index, 'quadrant needs x and y axis labels of 3–40 characters.');
        break;
      case 'chart':
        count(2, 5); labels(3, 40);
        if (!len(figure.units, 1, 18)) fail(index, 'chart needs one common unit of 1–18 characters.');
        break;
      case 'stat':
        count(1, 1); labels(6, 80); details(0, 120);
        if (clean(figure.units).length > 18) fail(index, 'stat units must be at most 18 characters.');
        break;
      default: break;
    }
    if (SOURCED.has(kind)) {
      for (const item of items) {
        const quote = checkQuote(item, sources, index);
        if ((kind === 'chart' || kind === 'stat')
            && (!Number.isFinite(item.value) || item.value < 0 || !numbersIn(quote).includes(item.value))) {
          fail(index, 'each value must appear in its quoted passage.');
        }
      }
    }
  });
}

const formatValue = (value) => (Number.isInteger(value) ? value.toLocaleString('en-US') : String(value));
/** "45 minutes", but "10%" and "3×": symbol units attach without a space. */
export const withUnits = (value, units) => {
  const unit = clean(units);
  return `${formatValue(value)}${unit && /^[^a-z0-9]{1,2}$/i.test(unit) ? unit : unit ? ` ${unit}` : ''}`;
};

function frame(title, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
  <rect width="${WIDTH}" height="${height}" rx="18" fill="${C.bg}"/>
  <g font-family="${FONT}">
    <rect x="64" y="52" width="40" height="4" rx="2" fill="${C.copper}"/>
    ${textBlock(title, { x: 64, y: 98, width: WIDTH - 128, size: 30, weight: 'bold', maxLines: 2 })}
    ${body}
  </g></svg>`;
}

function arrow(x1, y1, x2, y2) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = (sign) => `${(x2 - 12 * Math.cos(angle + sign * 0.45)).toFixed(1)},${(y2 - 12 * Math.sin(angle + sign * 0.45)).toFixed(1)}`;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.copper}" stroke-width="3"/>
    <polygon points="${x2},${y2} ${head(1)} ${head(-1)}" fill="${C.copper}"/>`;
}

const RENDER = {
  flow({ title, items }) {
    const n = items.length;
    const gap = 44;
    const width = (WIDTH - 128 - gap * (n - 1)) / n;
    const top = 170;
    const height = 250;
    const cells = items.map((item, i) => {
      const x = 64 + i * (width + gap);
      return `${i ? arrow(x - gap + 6, top + height / 2, x - 6, top + height / 2) : ''}
        <rect x="${x}" y="${top}" width="${width}" height="${height}" rx="14" fill="${C.panel}" stroke="${C.line}"/>
        <text x="${x + 22}" y="${top + 40}" font-size="16" fill="${C.copper}" font-weight="bold">${String(i + 1).padStart(2, '0')}</text>
        ${textBlock(item.label, { x: x + 22, y: top + 80, width: width - 44, size: n > 3 ? 19 : 22, weight: 'bold', maxLines: 3 })}
        ${textBlock(item.detail, { x: x + 22, y: top + 170, width: width - 44, size: n > 3 ? 15 : 17, color: C.muted, maxLines: 4 })}`;
    });
    return frame(title, 480, cells.join(''));
  },

  decision({ title, items }) {
    const row = 104;
    const top = 160;
    const rows = items.map((item, i) => {
      const y = top + i * row;
      return `<rect x="64" y="${y}" width="560" height="${row - 22}" rx="12" fill="${C.panel}" stroke="${C.line}"/>
        <text x="88" y="${y + 33}" font-size="14" fill="${C.copper}" font-weight="bold">IF</text>
        ${textBlock(item.label, { x: 120, y: y + (row - 22) / 2, width: 480, size: 19, center: true, maxLines: 2 })}
        ${arrow(636, y + (row - 22) / 2, 690, y + (row - 22) / 2)}
        <rect x="700" y="${y}" width="436" height="${row - 22}" rx="12" fill="${C.panel2}" stroke="${C.copper}"/>
        ${textBlock(item.detail, { x: 724, y: y + (row - 22) / 2, width: 390, size: 19, weight: 'bold', center: true, maxLines: 2 })}`;
    });
    return frame(title, top + items.length * row + 40, rows.join(''));
  },

  comparison({ title, columns, items }) {
    const labelWidth = 250;
    const colWidth = (WIDTH - 128 - labelWidth) / columns.length;
    const top = 160;
    const head = 60;
    const row = 82;
    const header = columns.map((column, c) => {
      const x = 64 + labelWidth + c * colWidth;
      return `<rect x="${x + 4}" y="${top}" width="${colWidth - 8}" height="${head - 8}" rx="10" fill="${C.panel2}"/>
        ${textBlock(column, { x: x + colWidth / 2, y: top + (head - 8) / 2, width: colWidth - 24, size: 18, weight: 'bold', color: C.bright, anchor: 'middle', center: true, maxLines: 1 })}`;
    });
    const rows = items.map((item, r) => {
      const y = top + head + r * row;
      const cells = item.cells.map((cell, c) => {
        const x = 64 + labelWidth + c * colWidth;
        return textBlock(cell, { x: x + colWidth / 2, y: y + row / 2, width: colWidth - 28, size: 16, anchor: 'middle', center: true, maxLines: 2 });
      });
      return `<rect x="64" y="${y}" width="${WIDTH - 128}" height="${row}" fill="${r % 2 ? C.bg : C.panel}"/>
        ${textBlock(item.label, { x: 84, y: y + row / 2, width: labelWidth - 30, size: 17, weight: 'bold', center: true, maxLines: 2 })}
        ${cells.join('')}`;
    });
    return frame(title, top + head + items.length * row + 48, header.join('') + rows.join(''));
  },

  timeline({ title, items }) {
    const n = items.length;
    const y = 240;
    // Inset the first and last marks by half a label so their text stays inside the frame.
    const width = Math.min((WIDTH - 128) / n - 16, 260);
    const first = 64 + width / 2;
    const step = (WIDTH - 128 - width) / Math.max(n - 1, 1);
    const marks = items.map((item, i) => {
      const x = first + i * step;
      return `<circle cx="${x}" cy="${y}" r="11" fill="${C.copper}" stroke="${C.bg}" stroke-width="4"/>
        ${textBlock(item.label, { x, y: y - 36, width, size: 18, weight: 'bold', color: C.bright, anchor: 'middle', maxLines: 1 })}
        ${textBlock(item.detail, { x, y: y + 50, width, size: 16, anchor: 'middle', maxLines: 4 })}`;
    });
    return frame(title, 420, `<line x1="64" y1="${y}" x2="${WIDTH - 64}" y2="${y}" stroke="${C.line}" stroke-width="4"/>${marks.join('')}`);
  },

  quadrant({ title, items, axes }) {
    const left = 140;
    const top = 160;
    const size = 470;
    const w = (WIDTH - left - 64) / 2;
    const cells = items.map((item, i) => {
      const x = left + (i % 2) * w;
      const y = top + Math.floor(i / 2) * size / 2;
      const highlight = i === 1;
      return `<rect x="${x + 6}" y="${y + 6}" width="${w - 12}" height="${size / 2 - 12}" rx="14" fill="${highlight ? C.panel2 : C.panel}" stroke="${highlight ? C.copper : C.line}"/>
        ${textBlock(item.label, { x: x + 34, y: y + 58, width: w - 68, size: 22, weight: 'bold', color: highlight ? C.bright : C.text, maxLines: 2 })}
        ${textBlock(item.detail, { x: x + 34, y: y + 120, width: w - 68, size: 17, color: C.muted, maxLines: 3 })}`;
    });
    const axisY = `<g transform="translate(96 ${top + size / 2}) rotate(-90)">${textBlock(`${axes.y} →`, { x: 0, y: 0, width: size, size: 16, color: C.muted, anchor: 'middle', maxLines: 1 })}</g>`;
    const axisX = textBlock(`${axes.x} →`, { x: left + w, y: top + size + 40, width: 2 * w, size: 16, color: C.muted, anchor: 'middle', maxLines: 1 });
    return frame(title, top + size + 70, cells.join('') + axisY + axisX);
  },

  chart({ title, items, units }) {
    const max = Math.max(1, ...items.map(({ value }) => value));
    const top = 170;
    const row = 84;
    const barX = 470;
    const barW = 520;
    const bars = items.map((item, i) => {
      const y = top + i * row;
      return `${textBlock(item.label, { x: 64, y: y + 26, width: 380, size: 18, center: true, maxLines: 2 })}
        <rect x="${barX}" y="${y}" width="${barW}" height="48" rx="8" fill="${C.panel}"/>
        <rect x="${barX}" y="${y}" width="${Math.max(4, (barW * item.value) / max).toFixed(1)}" height="48" rx="8" fill="${C.copper}"/>
        <text x="${barX + barW + 18}" y="${y + 32}" font-size="19" fill="${C.text}" font-weight="bold">${xml(withUnits(item.value, units))}</text>`;
    });
    return frame(title, top + items.length * row + 40, bars.join(''));
  },

  stat({ title, items: [item], units }) {
    const big = withUnits(item.value, units);
    const size = big.length > 12 ? 92 : 128;
    return frame(title, 470, `
      <text x="64" y="${170 + size}" font-size="${size}" font-weight="bold" fill="${C.copper}">${xml(big)}</text>
      ${textBlock(item.label, { x: 64, y: 340, width: WIDTH - 128, size: 24, weight: 'bold', maxLines: 2 })}
      ${textBlock(item.detail, { x: 64, y: 400, width: WIDTH - 128, size: 18, color: C.muted, maxLines: 2 })}`);
  },
};

export function figureSvg(figure) {
  return RENDER[figure.kind](figure);
}

export async function renderFigure(figure) {
  return sharp(Buffer.from(figureSvg(figure))).webp({ quality: 88 }).toBuffer();
}

/**
 * Deterministic 1200×630 title card: the hero when no illustration is
 * available. Accent and pattern vary by cluster and slug so cards differ.
 */
const CLUSTER_ACCENT = { ai: '#E0935A', ml: '#7CC4B8', data: '#8FA8F2', 'software-for-ai': '#E3C26B', geo: '#C79BE8' };

export async function renderTitleCard({ title, label, cluster, seed }) {
  const accent = CLUSTER_ACCENT[cluster] ?? C.copper;
  let state = [...seed].reduce((hash, ch) => (hash * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const rings = Array.from({ length: 5 }, (_, i) =>
    `<circle cx="${900 + random() * 220}" cy="${100 + random() * 430}" r="${60 + i * 46 + random() * 30}" fill="none" stroke="${accent}" stroke-opacity="${(0.08 + random() * 0.18).toFixed(2)}" stroke-width="${2 + Math.floor(random() * 3)}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <rect width="1200" height="630" fill="#0B0F1A"/>${rings}
    <g font-family="${FONT}">
      <rect x="80" y="96" width="48" height="5" rx="2" fill="${accent}"/>
      <text x="80" y="150" font-size="22" fill="${accent}" letter-spacing="3">${xml(label.toUpperCase())}</text>
      ${textBlock(title, { x: 80, y: 250, width: 760, size: 52, weight: 'bold', maxLines: 4 })}
      <text x="80" y="560" font-size="20" fill="${C.muted}">Intelleo Editorial</text>
    </g></svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 86 }).toBuffer();
}
