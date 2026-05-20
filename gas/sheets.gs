// Sheet access. Single chokepoint via openSheet_ - all reads/writes route through here.
// Shape adapted from ~/vault/Patterns/multi-tenant-apps-script-runtime.md (single-tenant variant).

const getSheetId_ = () => {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID script property not set');
  return id;
};

// The chokepoint. Add caching, validation, or audit logging here.
const openSheet_ = () => SpreadsheetApp.openById(getSheetId_());

const getRows_ = (_tabName) => { throw new Error('Not implemented in Wave 1'); };
const upsertRow_ = (_tabName, _keyColumn, _row) => { throw new Error('Not implemented in Wave 1'); };
const deleteRow_ = (_tabName, _keyColumn, _keyValue) => { throw new Error('Not implemented in Wave 1'); };

// Wave 2 will populate Days/PlanItems/Library/Tags/Photos/Settings tabs and headers.
const setup_seedSheet_ = () => { throw new Error('Not implemented in Wave 1'); };
