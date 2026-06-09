// Wave 4b LLM step. Gemini Flash turns the grid's date-grouped OCR text into clean
// structured events - merging multi-line entries, fixing OCR typos, dropping
// non-events. Free-tier key in Script Property GEMINI_API_KEY (server-side only,
// never sent to the client). Dates come from our grid; the model is told NOT to
// move events across dates. Throws on any failure so run_photo_ocr can fall back
// to the regex assembler.

var GEMINI_ENDPOINT_BASE_ = 'https://generativelanguage.googleapis.com/v1beta/models/';
var GEMINI_MODEL_DEFAULT_ = 'gemini-2.5-flash';

function geminiApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}

function geminiModel_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || GEMINI_MODEL_DEFAULT_;
}

// dateText: { 'yyyy-MM-dd': ['line', ...] }. Returns
// [{day, date, title, start_time, end_time, location, confidence}]. Throws on
// missing key / transport / quota / unparseable response.
function structureWithGemini_(dateText, month, year) {
  const key = geminiApiKey_();
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const dates = Object.keys(dateText).filter((d) => dateText[d] && dateText[d].length).sort();
  if (!dates.length) return [];

  const blocks = dates.map((d) =>
    d + ':\n' + dateText[d].map((t) => '  - ' + t).join('\n')).join('\n\n');

  const prompt = [
    'You are cleaning up handwritten notes that OCR pulled off a family wall calendar.',
    'Below are raw OCR text lines, grouped by the exact date each was written on.',
    'Return the real plan items as structured events. Rules:',
    '- Merge lines that belong to ONE entry (handwriting often wraps across 2-3 lines).',
    '- A single date may list SEVERAL separate events - return each as its own record.',
    '  Do not merge unrelated activities into one event.',
    '- Fix only CLEAR OCR misreads (e.g. "peson"->"person", "llam"->"11am", reordered',
    '  words like "Photos Openstage"->"Openstage Photos"). Do NOT guess or "correct"',
    '  an ambiguous word - keep it exactly as written (it may be a child\'s spelling).',
    '- Keep each event on the date its lines were listed under. NEVER move an event to a different date.',
    '- start_time / end_time: 24-hour "HH:mm" when a time is written, else "".',
    '- title: the cleaned description with the time text removed.',
    '- Omit anything that is not a real plan item (stray marks, lone junk tokens, leftover holiday text).',
    '',
    'Raw notes by date:',
    blocks,
  ].join('\n');

  const schema = {
    type: 'OBJECT',
    properties: {
      events: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            date: { type: 'STRING' },
            title: { type: 'STRING' },
            start_time: { type: 'STRING' },
            end_time: { type: 'STRING' },
          },
          required: ['date', 'title'],
        },
      },
    },
    required: ['events'],
  };

  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  };

  const url = GEMINI_ENDPOINT_BASE_ + geminiModel_() + ':generateContent?key=' + encodeURIComponent(key);
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code < 200 || code >= 300) throw new Error('Gemini ' + code + ': ' + body.substring(0, 300));

  const json = JSON.parse(body);
  const cand = json.candidates && json.candidates[0];
  const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
  const text = part && part.text;
  if (!text) throw new Error('Gemini returned no content: ' + body.substring(0, 200));

  const parsed = JSON.parse(text); // JSON mode -> bare JSON, no fence to strip
  const valid = {};
  dates.forEach((d) => { valid[d] = true; });
  return (parsed.events || [])
    .filter((e) => e && e.date && e.title && valid[e.date]) // ignore any hallucinated date
    .map((e) => ({
      day: parseInt(String(e.date).slice(8), 10) || 0,
      date: e.date,
      title: String(e.title).trim(),
      start_time: normalizeHHmm_(e.start_time),
      end_time: normalizeHHmm_(e.end_time),
      location: '',
      raw: '',
      confidence: 'ok',
    }))
    .filter((e) => e.title)
    .sort((a, b) => (a.date === b.date
      ? String(a.start_time).localeCompare(String(b.start_time))
      : a.date.localeCompare(b.date)));
}

// Accept only well-formed 24h HH:mm; anything else becomes '' (untimed).
function normalizeHHmm_(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (h > 23 || mn > 59) return '';
  return String(h).padStart(2, '0') + ':' + m[2];
}
