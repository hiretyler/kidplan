// HTTP router. All requests funnel through here.
// GET: action + params in query string. POST: action + params in JSON body.

const VERSION = '0.1.0';

// Unauthenticated. runningAs is the deployer (getEffectiveUser is reliable for
// execute-as-me; getActiveUser is empty on a personal-Gmail web app). tokenOk
// lets the frontend verify its stored token without exposing any data.
const ping = (params) => ({
  ok: true,
  runningAs: Session.getEffectiveUser().getEmail(),
  tokenOk: tokensMatch_(params && params.token, getApiToken_()),
  version: VERSION,
});

const list_days = (_params) => ({ ok: true, data: [] });
const upsert_day = (_params) => { throw new Error('Not implemented in Wave 1'); };
const delete_day = (_params) => { throw new Error('Not implemented in Wave 1'); };

const list_plan_items = (_params) => ({ ok: true, data: [] });
const upsert_plan_item = (_params) => { throw new Error('Not implemented in Wave 1'); };
const delete_plan_item = (_params) => { throw new Error('Not implemented in Wave 1'); };

const duplicate_day_to_range = (_params) => { throw new Error('Not implemented in Wave 1'); };

const list_library = (_params) => ({ ok: true, data: [] });
const upsert_library = (_params) => { throw new Error('Not implemented in Wave 1'); };
const delete_library = (_params) => { throw new Error('Not implemented in Wave 1'); };

const list_tags = (_params) => ({ ok: true, data: [] });
const upsert_tag = (_params) => { throw new Error('Not implemented in Wave 1'); };

const request_photo_upload = (_params) => ({ ok: true, data: { upload_url: null, session_id: null } });
const list_photos = (_params) => ({ ok: true, data: [] });
const reconcile_photo = (_params) => { throw new Error('Not implemented in Wave 1'); };

const get_settings = (_params) => ({ ok: true, data: {} });
const update_setting = (_params) => { throw new Error('Not implemented in Wave 1'); };

// Action -> handler. ping is unauthenticated; everything else is wrapped.
const ROUTES = {
  ping: ping,
  list_days: withAuth_(list_days),
  upsert_day: withAuth_(upsert_day),
  delete_day: withAuth_(delete_day),
  list_plan_items: withAuth_(list_plan_items),
  upsert_plan_item: withAuth_(upsert_plan_item),
  delete_plan_item: withAuth_(delete_plan_item),
  duplicate_day_to_range: withAuth_(duplicate_day_to_range),
  list_library: withAuth_(list_library),
  upsert_library: withAuth_(upsert_library),
  delete_library: withAuth_(delete_library),
  list_tags: withAuth_(list_tags),
  upsert_tag: withAuth_(upsert_tag),
  request_photo_upload: withAuth_(request_photo_upload),
  list_photos: withAuth_(list_photos),
  reconcile_photo: withAuth_(reconcile_photo),
  get_settings: withAuth_(get_settings),
  update_setting: withAuth_(update_setting),
};

const jsonOut_ = (obj) =>
  ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);

const dispatch_ = (action, params) => {
  try {
    const handler = ROUTES[action];
    if (!handler) return jsonOut_({ ok: false, error: 'unknown action: ' + action });
    return jsonOut_(handler(params));
  } catch (err) {
    return jsonOut_({ ok: false, error: err.message, stack: err.stack });
  }
};

function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const action = params.action;
  return dispatch_(action, params);
}

function doPost(e) {
  let body = {};
  try {
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ ok: false, error: 'invalid JSON body: ' + err.message });
  }
  const action = body.action;
  return dispatch_(action, body);
}
