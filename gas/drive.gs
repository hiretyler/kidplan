// Drive bridge. Paper-calendar photos live under the family Drive folder
// identified by PHOTO_DRIVE_FOLDER_ID (script property; Settings tab fallback).

// Resolve the configured photo archive folder. Script property wins.
function getPhotoFolderId_() {
  let id = PropertiesService.getScriptProperties().getProperty('PHOTO_DRIVE_FOLDER_ID');
  if (!id) {
    const row = getRowByKey_('Settings', 'key', 'photo_drive_folder_id');
    if (row) id = row.value;
  }
  if (!id) throw new Error('PHOTO_DRIVE_FOLDER_ID not configured');
  return id;
}

// Decode the base64 payload, build a Blob, drop it in the archive folder.
// Returns the new Drive file id. Caller writes the Photos row.
function uploadPhotoToDrive_(base64, mimeType, filename) {
  if (!base64) throw new Error('base64 image is required');
  const folder = DriveApp.getFolderById(getPhotoFolderId_());
  const bytes = Utilities.base64Decode(base64);
  const blob = Utilities.newBlob(bytes, mimeType || 'image/jpeg', filename || defaultPhotoName_());
  const file = folder.createFile(blob);
  return file.getId();
}

// Read a Drive file as base64 for re-upload to Vision. Cheaper than re-encoding
// the original upload because we already paid the cost; this path is for OCR-only.
function readDriveFileAsBase64_(fileId) {
  const blob = DriveApp.getFileById(fileId).getBlob();
  return Utilities.base64Encode(blob.getBytes());
}

// Datestamped fallback filename so the archive folder stays grep-able.
function defaultPhotoName_() {
  return 'paper-calendar-' + Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd-HHmmss') + '.jpg';
}
