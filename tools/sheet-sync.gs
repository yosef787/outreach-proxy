/**
 * MASDR Compliance Calendar — Google Sheet sync endpoint.
 *
 * SETUP (once, by the owner of the sheet)
 *  1. Open the Google Sheet ▸ Extensions ▸ Apps Script.
 *  2. Delete whatever is there and paste this whole file in. Save.
 *  3. Optional but recommended: set SHARED_KEY below to any phrase.
 *  4. Deploy ▸ New deployment ▸ type "Web app".
 *       Execute as:      Me
 *       Who has access:  Anyone          <- must be "Anyone", not "Anyone with a Google account"
 *  5. Authorise when prompted, then copy the /exec URL.
 *  6. Paste that URL (and the key) into the calendar page under Sync.
 *
 * After changing this file you must Deploy ▸ Manage deployments ▸ Edit ▸
 * Version: New version, or the web app keeps serving the old code.
 *
 * The sheet needs a tab named "Work Plan" with a header row containing
 * "Activity ID". Columns are matched by their heading, so their order does
 * not matter and extra columns are left alone. An "Updated At" column is
 * added automatically the first time this runs — it is what lets two people
 * sync without overwriting each other.
 */

var SHARED_KEY = '';            // e.g. 'masdr-2026'; leave '' for no key

/* ── optional: email reminders ─────────────────────────────────────────
 * Leave REMIND_TO empty and nothing happens. To turn it on:
 *   1. Put one or more addresses in REMIND_TO.
 *   2. In Apps Script: Triggers ▸ Add trigger ▸ sendReminders ▸
 *      Time-driven ▸ Day timer ▸ 7am-8am.
 * It then mails a short digest of anything overdue or falling due inside
 * REMIND_DAYS, and stays quiet on days when there is nothing to say.
 */
var REMIND_TO   = '';           // 'me@masdr.com, colleague@masdr.com'
var REMIND_DAYS = 14;
var SHEET_NAME = 'Work Plan';
var LISTS_NAME = 'Lists';

var FIELDS = [
  ['id',         'Activity ID'],
  ['activity',   'Activity / Deliverable'],
  ['type',       'Type'],
  ['owner',      'Owner'],
  ['department', 'Department'],
  ['frequency',  'Frequency'],
  ['start',      'Start Date'],
  ['end',        'End / Due Date'],
  ['duration',   'Duration (days)'],
  ['status',     'Status'],
  ['progress',   'Progress %'],
  ['reviewer',   'Reviewer / Approver'],
  ['approval',   'Approval Status'],
  ['notes',      'Notes'],
  ['updatedAt',  'Updated At']
];

/* ── entry points ─────────────────────────────────────────────────── */

function doGet(e) {
  try {
    if (!keyOk_(e && e.parameter ? e.parameter.key : '')) return json_({ ok: false, error: 'Wrong sync key.' });
    return json_(readAll_());
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (err) {
    return json_({ ok: false, error: 'The sheet is busy with another sync. Try again in a moment.' });
  }
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!keyOk_(body.key)) return json_({ ok: false, error: 'Wrong sync key.' });
    merge_(body.rows || [], body.deleted || []);
    return json_(readAll_());
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function keyOk_(k) { return !SHARED_KEY || String(k || '') === SHARED_KEY; }

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ── sheet access ─────────────────────────────────────────────────── */

function norm_(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[\s ]/g, '').replace(/[–—]/g, '-');
}

function ctx_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  var v = sh.getDataRange().getValues();

  var hdr = -1;
  for (var r = 0; r < v.length && r < 40 && hdr < 0; r++) {
    for (var c = 0; c < v[r].length; c++) {
      if (norm_(v[r][c]) === 'activityid') { hdr = r; break; }
    }
  }
  if (hdr < 0) throw new Error('No "Activity ID" heading found on the "' + sh.getName() + '" sheet.');

  var map = {};
  for (var c2 = 0; c2 < v[hdr].length; c2++) {
    var n = norm_(v[hdr][c2]);
    for (var i = 0; i < FIELDS.length; i++) {
      if (norm_(FIELDS[i][1]) === n) map[FIELDS[i][0]] = c2;
    }
  }
  if (map.id === undefined) throw new Error('Could not map the "Activity ID" column.');

  if (map.updatedAt === undefined) {
    var col = v[hdr].length;
    while (col > 0 && String(v[hdr][col - 1] || '') === '') col--;
    sh.getRange(hdr + 1, col + 1).setValue('Updated At');
    SpreadsheetApp.flush();
    map.updatedAt = col;
    v = sh.getDataRange().getValues();
  }
  return { ss: ss, sh: sh, hdr: hdr, map: map, v: v, tz: ss.getSpreadsheetTimeZone() };
}

function asDate_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = String(v == null ? '' : v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}
function asIso_(v) {
  if (v instanceof Date) return v.toISOString();
  return String(v == null ? '' : v).trim();
}
function asProgress_(v) {
  var n = Number(v);
  if (!isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

function readAll_() {
  var x = ctx_(), rows = [];
  for (var r = x.hdr + 1; r < x.v.length; r++) {
    var id = String(x.v[r][x.map.id] == null ? '' : x.v[r][x.map.id]).trim();
    if (!id) continue;
    rows.push(rowFrom_(x.v[r], x.map, x.tz));
  }
  return {
    ok: true,
    rows: rows,
    lists: readLists_(),
    title: x.ss.getName(),
    syncedAt: new Date().toISOString()
  };
}

function rowFrom_(row, map, tz) {
  function g(k) { return map[k] === undefined ? '' : row[map[k]]; }
  return {
    id:         String(g('id')).trim(),
    activity:   String(g('activity') || ''),
    type:       String(g('type') || ''),
    owner:      String(g('owner') || ''),
    department: String(g('department') || ''),
    frequency:  String(g('frequency') || ''),
    start:      asDate_(g('start'), tz),
    end:        asDate_(g('end'), tz),
    duration:   Number(g('duration')) || 0,
    status:     String(g('status') || 'Not Started'),
    progress:   asProgress_(g('progress')),
    reviewer:   String(g('reviewer') || ''),
    approval:   String(g('approval') || ''),
    notes:      String(g('notes') || ''),
    updatedAt:  asIso_(g('updatedAt'))
  };
}

function readLists_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(LISTS_NAME);
  if (!sh) return null;
  var v = sh.getDataRange().getValues();
  var hdr = -1;
  for (var r = 0; r < v.length && r < 20 && hdr < 0; r++) {
    for (var c = 0; c < v[r].length; c++) {
      if (norm_(v[r][c]) === 'activitytype') { hdr = r; break; }
    }
  }
  if (hdr < 0) return null;
  var out = {};
  for (var c2 = 0; c2 < v[hdr].length; c2++) {
    var name = String(v[hdr][c2] || '').trim();
    if (!name) continue;
    var vals = [];
    for (var r2 = hdr + 1; r2 < v.length; r2++) {
      var cell = String(v[r2][c2] == null ? '' : v[r2][c2]).trim();
      if (cell) vals.push(cell);
    }
    if (vals.length) out[name] = vals;
  }
  return out;
}

/* ── merge ────────────────────────────────────────────────────────── */

function indexRows_(x) {
  var idx = {};
  for (var r = x.hdr + 1; r < x.v.length; r++) {
    var id = String(x.v[r][x.map.id] == null ? '' : x.v[r][x.map.id]).trim();
    if (id) idx[id] = { row: r + 1, updatedAt: asIso_(x.v[r][x.map.updatedAt]) };
  }
  return idx;
}

function merge_(rows, deleted) {
  var x = ctx_();
  var idx = indexRows_(x);

  /* deletions: only if the sheet row has not been touched since the delete */
  var kill = [];
  for (var i = 0; i < deleted.length; i++) {
    var e = idx[String(deleted[i].id || '').trim()];
    if (e && String(e.updatedAt || '') <= String(deleted[i].at || '')) kill.push(e.row);
  }
  if (kill.length) {
    kill.sort(function (a, b) { return b - a; });
    for (var k = 0; k < kill.length; k++) x.sh.deleteRow(kill[k]);
    SpreadsheetApp.flush();
    x = ctx_();
    idx = indexRows_(x);
  }

  /* upserts: newest wins, per row */
  var width = Math.max(x.v[x.hdr].length, x.sh.getLastColumn());
  var appendAt = x.sh.getLastRow() + 1;
  for (var j = 0; j < rows.length; j++) {
    var a = rows[j];
    var id = String(a.id || '').trim();
    if (!id) continue;
    var cur = idx[id];
    if (cur) {
      if (String(a.updatedAt || '') > String(cur.updatedAt || '')) {
        writeRow_(x, cur.row, a, width);
      }
    } else if (String(a.updatedAt || '')) {
      /* Only rows the sender actually created or edited are added. An
         untouched row that is missing here was deleted by someone else,
         and pushing it back would resurrect it. */
      writeRow_(x, appendAt, a, width);
      idx[id] = { row: appendAt, updatedAt: a.updatedAt };
      appendAt++;
    }
  }
  SpreadsheetApp.flush();
}

function writeRow_(x, rowNum, a, width) {
  var rng = x.sh.getRange(rowNum, 1, 1, width);
  var vals = rng.getValues()[0];
  for (var i = 0; i < FIELDS.length; i++) {
    var k = FIELDS[i][0];
    if (x.map[k] === undefined) continue;
    vals[x.map[k]] = toCell_(k, a[k]);
  }
  rng.setValues([vals]);
}

function toCell_(k, val) {
  if (k === 'start' || k === 'end') {
    var s = String(val == null ? '' : val).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
    var p = s.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  if (k === 'progress' || k === 'duration') return Number(val) || 0;
  return val == null ? '' : val;
}


/* ── email digest ─────────────────────────────────────────────────── */

function sendReminders() {
  if (!REMIND_TO) return;
  var rows = readAll_().rows;
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var horizon = new Date(today.getTime() + REMIND_DAYS * 86400000);

  var overdue = [], soon = [];
  rows.forEach(function (r) {
    if (r.status === 'Complete' || !r.end) return;
    var due = new Date(r.end + 'T00:00:00');
    if (due < today) overdue.push({ r: r, due: due });
    else if (due <= horizon) soon.push({ r: r, due: due });
  });
  if (!overdue.length && !soon.length) return;

  var by = function (a, b) { return a.due - b.due; };
  overdue.sort(by); soon.sort(by);

  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var line = function (x) {
    var days = Math.round((x.due - today) / 86400000);
    var when = days < 0 ? Math.abs(days) + ' days late'
             : days === 0 ? 'today'
             : 'in ' + days + ' days';
    return '• ' + x.r.id + ' — ' + x.r.activity +
           '  (' + Utilities.formatDate(x.due, tz, 'dd-MMM-yyyy') + ', ' + when + ')';
  };

  var body = [];
  if (overdue.length) body.push('OVERDUE', overdue.map(line).join('\n'), '');
  if (soon.length) body.push('DUE WITHIN ' + REMIND_DAYS + ' DAYS', soon.map(line).join('\n'), '');
  body.push('— MASDR Compliance Calendar');

  MailApp.sendEmail({
    to: REMIND_TO,
    subject: 'Compliance calendar — ' + (overdue.length ? overdue.length + ' overdue, ' : '') +
             soon.length + ' due soon',
    body: body.join('\n')
  });
}
