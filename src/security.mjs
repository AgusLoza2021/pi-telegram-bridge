// Security primitives for the Pi Telegram bridge.
// Authorization is exact BOTH numeric user AND chat; redaction is fail-safe;
// chunking is unicode/grapheme safe; the rate limiter is a sliding window.

const REDACTED = '[REDACTED]';

// Safe exact normalization: integers within the safe range, or canonical
// signed nonzero decimal strings without leading zeros. Anything else
// (zero, leading zeros, unsafe magnitudes, malformed text) -> null.
function normalizeTelegramId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value === 0) return null;
    return String(value);
  }
  if (typeof value === 'string' && /^-?[1-9][0-9]{0,19}$/.test(value)) return value;
  return null;
}

/**
 * Exact allowlist check: the sender must match the configured numeric user
 * AND chat. Missing entries on either side fail closed.
 */
export function authorize({ userId, chatId }, config) {
  const expectedUser = normalizeTelegramId(config?.telegram?.allowedUserId);
  const expectedChat = normalizeTelegramId(config?.telegram?.allowedChatId);
  const actualUser = normalizeTelegramId(userId);
  const actualChat = normalizeTelegramId(chatId);
  if (!expectedUser || !expectedChat || !actualUser || !actualChat) {
    return { allowed: false, reason: 'not_authorized' };
  }
  if (actualUser === expectedUser && actualChat === expectedChat) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'not_authorized' };
}

// General secret shapes: bot tokens, bearer headers, key/token/password
// assignments. Ordered so each pattern applies to text the previous one left.
const GENERAL_PATTERNS = Object.freeze([
  // Telegram bot tokens: <bot id>:<35+ secret chars>
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,
  // Authorization-style headers (whole line value).
  /^(?:authorization|x-api-key|x-telegram-bot-api-secret-token)\s*:\s*\S.*$/gim,
  // Bearer credentials.
  /\bBearer\s+\S+/gi,
  // key/token/password assignments with separators.
  /\b(?:api[_-]?key|secret|token|password)\s*[=:]\s*\S+/gi,
]);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace known secrets (exact occurrences) and general secret-shaped
 * substrings with [REDACTED]. Empty/whitespace secrets are ignored.
 */
export function redact(text, knownSecrets = []) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const secret of knownSecrets) {
    if (typeof secret !== 'string' || secret.trim().length === 0) continue;
    out = out.split(secret).join(REDACTED);
  }
  for (const pattern of GENERAL_PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Keep the assignment/label prefix readable where practical.
      const label = match.match(/^\s*[A-Za-z_ -]{2,20}\s*[=:]\s*/);
      if (label) return `${label[0]}${REDACTED}`;
      const header = match.match(/^(?:authorization|x-api-key|x-telegram-bot-api-secret-token)\s*:\s*/i);
      if (header) return `${header[0]}${REDACTED}`;
      const bearer = match.match(/^Bearer\s+/i);
      if (bearer) return `${bearer[0]}${REDACTED}`;
      return REDACTED;
    });
  }
  return out;
}

/**
 * Split text into chunks of at most maxLen UTF-16 code units — the unit
 * Telegram itself counts, conservative for emoji — never splitting a
 * grapheme cluster when it fits, preferring breaks at newlines then
 * spaces. A grapheme longer than maxLen is split by whole code points as
 * a fallback (never into lone surrogates). Joining the chunks restores
 * the original text exactly.
 */
export function chunkMessage(text, maxLen) {
  // Minimum 2: a chunk must always be able to hold one whole surrogate
  // pair; maxLen 1 would force lone surrogates for astral input.
  if (!Number.isInteger(maxLen) || maxLen < 2) {
    throw new RangeError('maxLen must be an integer >= 2');
  }
  if (typeof text !== 'string' || text.length === 0) return [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const graphemes = Array.from(segmenter.segment(text), (s) => s.segment);

  const chunks = [];
  let current = '';
  for (const grapheme of graphemes) {
    if (grapheme.length > maxLen) {
      // Absolute limit: split the oversized grapheme by whole code points
      // (for..of iterates code points, so surrogate pairs stay intact).
      if (current.length > 0) {
        chunks.push(current);
        current = '';
      }
      let piece = '';
      for (const codePoint of grapheme) {
        if (piece.length + codePoint.length > maxLen) {
          chunks.push(piece);
          piece = '';
        }
        piece += codePoint;
      }
      if (piece.length > 0) chunks.push(piece);
      continue;
    }
    if (current.length + grapheme.length > maxLen) {
      // Prefer breaking after the last newline, then space, in the chunk.
      // Break characters are BMP-only, so slices never split surrogates.
      let cut = -1;
      for (let i = current.length - 1; i >= 0; i--) {
        const ch = current[i];
        if (ch === '\n') {
          cut = i + 1;
          break;
        }
        if (ch === ' ' || ch === '\t') {
          cut = i + 1;
          break;
        }
      }
      if (cut > 0) {
        chunks.push(current.slice(0, cut));
        current = current.slice(cut);
        if (current.length + grapheme.length > maxLen) {
          chunks.push(current);
          current = '';
        }
      } else {
        chunks.push(current);
        current = '';
      }
    }
    current += grapheme;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Sliding-window rate limiter keyed by arbitrary string keys.
 * take(key, now) -> { allowed, retryAfterMs }.
 */
export function createRateLimiter({ max, windowMs }) {
  if (!Number.isInteger(max) || max <= 0) {
    throw new RangeError('max must be a positive integer');
  }
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new RangeError('windowMs must be a positive integer');
  }
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  return {
    take(key, now = Date.now()) {
      const list = hits.get(key) ?? [];
      const cutoff = now - windowMs;
      while (list.length > 0 && list[0] <= cutoff) list.shift();
      if (list.length >= max) {
        return { allowed: false, retryAfterMs: list[0] + windowMs - now };
      }
      list.push(now);
      hits.set(key, list);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}
