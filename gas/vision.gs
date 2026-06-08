// Cloud Vision OCR. We call the REST endpoint directly (no Advanced Service for
// Vision in Apps Script) using the deployer's own OAuth token via ScriptApp.
// The linked GCP project must have Vision API enabled and the cloud-vision
// scope must be in appsscript.json. No service account / JSON key needed.

const VISION_ENDPOINT_ = 'https://vision.googleapis.com/v1/images:annotate';

// Run DOCUMENT_TEXT_DETECTION on a Drive image. Returns the full text annotation
// string, or '' if Vision could not extract any text. Throws on transport /
// auth / quota errors so the caller surfaces a real failure rather than ''.
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
  return (annot && annot.fullTextAnnotation && annot.fullTextAnnotation.text) || '';
}
