// Cloud Vision OCR. We call the REST endpoint directly (no Advanced Service for
// Vision in Apps Script) using the deployer's own OAuth token via ScriptApp.
// The linked GCP project must have Vision API enabled and the cloud-vision
// scope must be in appsscript.json. No service account / JSON key needed.

const VISION_ENDPOINT_ = 'https://vision.googleapis.com/v1/images:annotate';

// Run DOCUMENT_TEXT_DETECTION on a Drive image. Returns
// { text, words } where text is the flat OCR string and words is
// [{t, x, y, w, h}] (one per detected token, x/y = bounding-box centroid in
// image pixels) so the grid parser can reconstruct the calendar layout.
// Throws on transport / auth / quota errors so the caller surfaces a real
// failure rather than empty output.
function runVisionOcrOnDriveFile_(driveFileId) {
  const base64 = readDriveFileAsBase64_(driveFileId);
  const payload = {
    requests: [{
      image: { content: base64 },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      // imageContext: language hints could go here once we know what the paper
      // calendar's handwriting looks like to Vision in practice.
    }]
  };
  const res = UrlFetchApp.fetch(VISION_ENDPOINT_, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Vision API ' + code + ': ' + body.substring(0, 500));
  }
  const json = JSON.parse(body);
  const annot = json.responses && json.responses[0];
  if (annot && annot.error) {
    throw new Error('Vision error: ' + (annot.error.message || JSON.stringify(annot.error)));
  }
  const text = (annot && annot.fullTextAnnotation && annot.fullTextAnnotation.text) || '';
  return { text: text, words: extractVisionWords_(annot) };
}

// Flatten Vision's textAnnotations (index 0 is the whole-image block; 1.. are
// individual tokens) into {t, x, y, w, h} with x/y as the bbox centroid. Vision
// omits a vertex coordinate when it is 0, so default missing x/y to 0.
function extractVisionWords_(annot) {
  const out = [];
  const anns = (annot && annot.textAnnotations) || [];
  for (let i = 1; i < anns.length; i++) {
    const a = anns[i];
    const verts = (a.boundingPoly && a.boundingPoly.vertices) || [];
    if (!verts.length) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    verts.forEach((v) => {
      const x = v.x || 0, y = v.y || 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
    out.push({
      t: a.description || '',
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      w: maxX - minX,
      h: maxY - minY,
    });
  }
  return out;
}
