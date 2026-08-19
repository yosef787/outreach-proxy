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
 * not matter and extra columns are left alone. Any heading this file knows
 * about but the sheet does not is appended on the first run — "Updated At"
 * (which is what lets two people sync without overwriting each other), plus
 * "Start Time", "End Time", "Alert (days before)" and "Alert Email".
 */

var SHARED_KEY = '';            // e.g. 'masdr-2026'; leave '' for no key

/* ── optional: email reminders ─────────────────────────────────────────
 * Leave REMIND_TO empty and nothing happens. To turn it on:
 *   1. Put one or more addresses in REMIND_TO.
 *   2. In Apps Script: Triggers ▸ Add trigger ▸ sendReminders ▸
 *      Time-driven ▸ Day timer ▸ 7am-8am.
 * It then mails a short digest of anything overdue or falling due inside
 * REMIND_DAYS, and stays quiet on days when there is nothing to say.
 *
 * The same daily trigger also sends the per-activity alerts set on the page
 * ("email these people a week before this is due") and the reminders that
 * carry their own address. Those work whether or not REMIND_TO is set — but
 * they still need the sendReminders trigger to exist.
 */
var REMIND_TO   = '';           // 'me@masdr.com, colleague@masdr.com'
var REMIND_DAYS = 14;
var SHEET_NAME = 'Work Plan';
var LISTS_NAME = 'Lists';
var REM_NAME   = 'Reminders';   // created automatically the first time reminders sync

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
  /* optional, added automatically the first time a page that uses them syncs */
  ['startTime',  'Start Time'],
  ['endTime',    'End Time'],
  ['alertLead',  'Alert (days before)'],
  ['alertTo',    'Alert Email'],
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
    if (body.reminders || body.remDeleted) mergeReminders_(body.reminders || [], body.remDeleted || []);
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

  /* Any heading this file knows about but the sheet does not gets appended.
     Existing columns are never moved, so hand-made layouts survive.

     A sheet trimmed to exactly its used columns has no room on the right,
     and writing past the last column throws — so widen the grid first.
     Only "Updated At" is load-bearing (it is what makes two people syncing
     safe); if any of the optional headings cannot be added, carry on
     without them rather than failing the whole sync. */
  var added = 0;
  var col = v[hdr].length;
  while (col > 0 && String(v[hdr][col - 1] || '') === '') col--;
  for (var f = 0; f < FIELDS.length; f++) {
    var key = FIELDS[f][0];
    if (map[key] !== undefined) continue;
    try {
      widenTo_(sh, col + 1);
      sh.getRange(hdr + 1, col + 1).setValue(FIELDS[f][1]).setFontWeight('bold');
      map[key] = col;
      col++; added++;
    } catch (err) {
      if (key === 'updatedAt') throw err;
      /* an optional column the sheet has no room for: it simply will not
         round-trip, which is better than refusing to sync at all */
    }
  }
  if (added) {
    SpreadsheetApp.flush();
    v = sh.getDataRange().getValues();
  }
  return { ss: ss, sh: sh, hdr: hdr, map: map, v: v, tz: ss.getSpreadsheetTimeZone() };
}

/* Grids are a fixed size. Make sure column `n` and row `n` exist before
   anything writes to them. */
function widenTo_(sh, n) {
  var max = sh.getMaxColumns();
  if (n > max) sh.insertColumnsAfter(max, n - max);
}
function deepenTo_(sh, n) {
  var max = sh.getMaxRows();
  if (n > max) sh.insertRowsAfter(max, n - max);
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
/* A time is stored as text ("09:00"), but Sheets may hand it back as a Date. */
function asTime_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'HH:mm');
  /* the leading apostrophe that keeps Sheets from typing it as a time is
     normally stripped on read, but tolerate it either way */
  var s = String(v == null ? '' : v).trim().replace(/^'/, '');
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
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
    reminders: readRemindersSafe_(),
    title: x.ss.getName(),
    syncedAt: new Date().toISOString()
  };
}

function readRemindersSafe_() {
  try { return readReminders_(); } catch (e) { return null; }
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
    startTime:  asTime_(g('startTime'), tz),
    endTime:    asTime_(g('endTime'), tz),
    alertLead:  String(g('alertLead') == null ? '' : g('alertLead')).trim(),
    alertTo:    String(g('alertTo') || '').trim(),
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

/* ── reminders ────────────────────────────────────────────────────── */

var REM_FIELDS = [
  ['id',        'Reminder ID'],
  ['text',      'Reminder'],
  ['notes',     'Details'],
  ['repeat',    'Repeat'],
  ['day',       'Day'],
  ['date',      'Date'],
  ['until',     'Until'],
  ['link',      'Linked activity'],
  ['always',    'Always show'],
  ['email',     'Email'],
  ['addr',      'Email address'],
  ['updatedAt', 'Updated At']
];

/* The tab is made on first use, so it does not matter whether it exists. */
function remCtx_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(REM_NAME);
  if (!sh) {
    sh = ss.insertSheet(REM_NAME);
    sh.getRange(1, 1, 1, REM_FIELDS.length)
      .setValues([REM_FIELDS.map(function (f) { return f[1]; })])
      .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#4F206E');
    sh.setFrozenRows(1);
    SpreadsheetApp.flush();
  }
  var v = sh.getDataRange().getValues();
  var hdr = -1;
  for (var r = 0; r < v.length && r < 20 && hdr < 0; r++) {
    for (var c = 0; c < v[r].length; c++) {
      if (norm_(v[r][c]) === 'reminderid' || norm_(v[r][c]) === 'reminder') { hdr = r; break; }
    }
  }
  if (hdr < 0) throw new Error('The "' + REM_NAME + '" tab needs a "Reminder ID" heading.');

  var map = {};
  for (var c2 = 0; c2 < v[hdr].length; c2++) {
    var n = norm_(v[hdr][c2]);
    for (var i = 0; i < REM_FIELDS.length; i++) {
      if (norm_(REM_FIELDS[i][1]) === n) map[REM_FIELDS[i][0]] = c2;
    }
  }
  /* add any heading the tab is missing, so a hand-made tab still works */
  for (var j = 0; j < REM_FIELDS.length; j++) {
    if (map[REM_FIELDS[j][0]] === undefined) {
      var col = v[hdr].length;
      while (col > 0 && String(v[hdr][col - 1] || '') === '') col--;
      widenTo_(sh, col + 1);
      sh.getRange(hdr + 1, col + 1).setValue(REM_FIELDS[j][1]);
      SpreadsheetApp.flush();
      map[REM_FIELDS[j][0]] = col;
      v = sh.getDataRange().getValues();
    }
  }
  return { sh: sh, hdr: hdr, map: map, v: v, tz: ss.getSpreadsheetTimeZone() };
}

function readReminders_() {
  var x = remCtx_(), out = [];
  for (var r = x.hdr + 1; r < x.v.length; r++) {
    var id = String(x.v[r][x.map.id] == null ? '' : x.v[r][x.map.id]).trim();
    if (!id) continue;
    var row = x.v[r];
    out.push({
      id: id,
      text: String(row[x.map.text] || ''),
      notes: String(row[x.map.notes] || ''),
      repeat: String(row[x.map.repeat] || 'weekly'),
      day: String(row[x.map.day] == null ? '' : row[x.map.day]).trim(),
      date: asDate_(row[x.map.date], x.tz),
      until: asDate_(row[x.map.until], x.tz),
      link: String(row[x.map.link] || ''),
      always: row[x.map.always] === true || String(row[x.map.always]).toUpperCase() === 'TRUE',
      email: row[x.map.email] === true || String(row[x.map.email]).toUpperCase() === 'TRUE',
      addr: String(row[x.map.addr] || ''),
      updatedAt: asIso_(row[x.map.updatedAt])
    });
  }
  return out;
}

function mergeReminders_(list, deleted) {
  var x = remCtx_();
  var idx = {};
  for (var r = x.hdr + 1; r < x.v.length; r++) {
    var id = String(x.v[r][x.map.id] == null ? '' : x.v[r][x.map.id]).trim();
    if (id) idx[id] = { row: r + 1, updatedAt: asIso_(x.v[r][x.map.updatedAt]) };
  }
  var kill = [];
  (deleted || []).forEach(function (d2) {
    var e = idx[String(d2.id || '').trim()];
    if (e && String(e.updatedAt || '') <= String(d2.at || '')) kill.push(e.row);
  });
  if (kill.length) {
    kill.sort(function (a, b) { return b - a; });
    for (var k = 0; k < kill.length; k++) x.sh.deleteRow(kill[k]);
    SpreadsheetApp.flush();
    x = remCtx_();
    idx = {};
    for (var r2 = x.hdr + 1; r2 < x.v.length; r2++) {
      var id2 = String(x.v[r2][x.map.id] == null ? '' : x.v[r2][x.map.id]).trim();
      if (id2) idx[id2] = { row: r2 + 1, updatedAt: asIso_(x.v[r2][x.map.updatedAt]) };
    }
  }
  var width = Math.max(x.v[x.hdr].length, x.sh.getLastColumn());
  var appendAt = x.sh.getLastRow() + 1;
  (list || []).forEach(function (r3) {
    var id3 = String(r3.id || '').trim();
    if (!id3) return;
    var cur = idx[id3];
    if (cur) {
      if (String(r3.updatedAt || '') > String(cur.updatedAt || '')) writeRem_(x, cur.row, r3, width);
    } else if (String(r3.updatedAt || '')) {
      writeRem_(x, appendAt, r3, width);
      idx[id3] = { row: appendAt, updatedAt: r3.updatedAt };
      appendAt++;
    }
  });
  SpreadsheetApp.flush();
}

function writeRem_(x, rowNum, r, width) {
  deepenTo_(x.sh, rowNum);
  widenTo_(x.sh, width);
  var rng = x.sh.getRange(rowNum, 1, 1, width);
  var vals = rng.getValues()[0];
  for (var i = 0; i < REM_FIELDS.length; i++) {
    var k = REM_FIELDS[i][0];
    if (x.map[k] === undefined) continue;
    var val = r[k];
    if (k === 'date' || k === 'until') val = toCell_('start', val);
    if (k === 'always' || k === 'email') val = !!val;
    if (k === 'day') val = "'" + remDayList_(r).join(',');   // leading quote keeps "1,15" as text
    vals[x.map[k]] = val == null ? '' : val;
  }
  rng.setValues([vals]);
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
  deepenTo_(x.sh, rowNum);
  widenTo_(x.sh, width);
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
  /* a leading apostrophe keeps Sheets from reading "09:00" as a time value */
  if (k === 'startTime' || k === 'endTime') {
    var t = String(val == null ? '' : val).trim();
    return t ? "'" + t : '';
  }
  return val == null ? '' : val;
}


/* ── email digest ─────────────────────────────────────────────────── */

function ymd_(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
function parseYmd_(s) {
  if (!s) return null;
  var p = String(s).slice(0, 10).split('-');
  if (p.length !== 3) return null;
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return isNaN(d) ? null : d;
}
function lastDayOfMonth_(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }

/* Does this reminder fire on this date? Same rules as the page. */
/* The Day column holds one day or several, e.g. "0,3" for Sunday and
   Wednesday. Older rows carrying a single number still read correctly. */
function remDayList_(r) {
  var raw = r.days !== undefined && r.days !== null && r.days !== '' ? r.days : r.day;
  return String(raw == null ? '' : raw).replace(/^'/, '').split(',')
    .map(function (n) { return parseInt(n, 10); })
    .filter(function (n) { return !isNaN(n); });
}

/* "7,1" -> [7, 1]. One number still reads correctly. */
function leadList_(r) {
  return String(r.alertLead == null ? '' : r.alertLead).replace(/^'/, '').split(',')
    .map(function (n) { return parseInt(n, 10); })
    .filter(function (n) { return !isNaN(n) && n >= 0; });
}

function remFiresOn_(r, date, rowsById) {
  var end = parseYmd_(r.until);
  if (!end && r.link && rowsById[r.link]) end = parseYmd_(rowsById[r.link].end);
  if (end && date > end) return false;
  if (r.link && rowsById[r.link] && rowsById[r.link].status === 'Complete') return false;

  if (r.repeat === 'once') {
    var one = parseYmd_(r.date);
    return !!one && ymd_(one) === ymd_(date);
  }
  var days = remDayList_(r);
  if (!days.length) return false;
  if (r.repeat === 'weekly') return days.indexOf(date.getDay()) >= 0;
  var last = lastDayOfMonth_(date);
  var doms = days.map(function (n) { return Math.min(n || 1, last); });
  if (r.repeat === 'monthly') return doms.indexOf(date.getDate()) >= 0;
  if (r.repeat === 'quarterly') return date.getMonth() % 3 === 0 && doms.indexOf(date.getDate()) >= 0;
  return false;
}

/* What today's email would contain. Returns { deadlines, reminders } with
   nothing sent — handy for checking before you switch the trigger on. */
function previewReminders() {
  var out = collect_();
  Logger.log('Overdue: ' + out.overdue.length + '   Due within ' + REMIND_DAYS + ' days: ' + out.soon.length +
             '   Reminders firing today: ' + out.rem.length);
  Logger.log(digestBody_(out) || '(nothing to send today)');
  return out;
}

function collect_() {
  var rows = readAll_().rows;
  var rems = readRemindersSafe_() || [];
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var horizon = new Date(today.getTime() + REMIND_DAYS * 86400000);

  var byId = {};
  rows.forEach(function (r) { byId[r.id] = r; });

  var overdue = [], soon = [];
  rows.forEach(function (r) {
    if (r.status === 'Complete' || !r.end) return;
    var due = parseYmd_(r.end);
    if (!due) return;
    if (due < today) overdue.push({ r: r, due: due });
    else if (due <= horizon) soon.push({ r: r, due: due });
  });
  var by = function (a, b) { return a.due - b.due; };
  overdue.sort(by); soon.sort(by);

  var rem = rems.filter(function (x) { return x.email && remFiresOn_(x, today, byId); });

  /* Activities carrying their own alert: "email these people N days before
     it is due". Fires on exactly that morning, and never once it is done. */
  var alerts = [];
  rows.forEach(function (r) {
    if (r.status === 'Complete' || !r.alertTo || r.alertLead === '') return;
    var due = parseYmd_(r.end);
    if (!due) return;
    /* an activity can ask for several — "a week before" and again "on the day" */
    leadList_(r).forEach(function (lead) {
      var fire = new Date(due.getTime() - lead * 86400000);
      if (ymd_(fire) === ymd_(today)) alerts.push({ r: r, due: due, lead: lead });
    });
  });
  return { today: today, overdue: overdue, soon: soon, rem: rem, alerts: alerts };
}

function digestBody_(out) {
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var line = function (x) {
    var days = Math.round((x.due - out.today) / 86400000);
    var when = days < 0 ? Math.abs(days) + ' days late' : days === 0 ? 'today' : 'in ' + days + ' days';
    return '• ' + x.r.id + ' — ' + x.r.activity +
           '  (' + Utilities.formatDate(x.due, tz, 'dd-MMM-yyyy') + ', ' + when + ')';
  };
  var body = [];
  if (out.rem.length) body.push('TODAY', out.rem.map(function (r) { return '• ' + r.text; }).join('\n'), '');
  if (out.alerts && out.alerts.length) body.push('COMING UP', out.alerts.map(alertLine_).join('\n'), '');
  if (out.overdue.length) body.push('OVERDUE', out.overdue.map(line).join('\n'), '');
  if (out.soon.length) body.push('DUE WITHIN ' + REMIND_DAYS + ' DAYS', out.soon.map(line).join('\n'), '');
  if (!body.length) return '';
  body.push('— MASDR Compliance Calendar');
  return body.join('\n');
}

function alertLine_(x) {
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var when = x.lead === 0 ? 'today' : x.lead === 1 ? 'tomorrow' : 'in ' + x.lead + ' days';
  return '• ' + x.r.id + ' — ' + x.r.activity + '  (due ' +
         Utilities.formatDate(x.due, tz, 'dd-MMM-yyyy') + ', ' + when +
         (x.r.startTime ? ' at ' + x.r.startTime : '') + ')' +
         (x.r.notes ? '\n    ' + x.r.notes : '');
}

/* Sends one mail to REMIND_TO, plus a short one to any reminder or activity
   alert that carries its own address. Silent on days with nothing to say. */
function sendReminders() {
  var out = collect_();

  if (REMIND_TO) {
    var mine = {
      today: out.today, overdue: out.overdue, soon: out.soon,
      rem: out.rem.filter(function (r) { return !r.addr || r.addr === REMIND_TO; }),
      alerts: out.alerts.filter(function (a) { return a.r.alertTo === REMIND_TO; })
    };
    var body = digestBody_(mine);
    if (body) {
      MailApp.sendEmail({
        to: REMIND_TO,
        subject: 'Compliance calendar — ' +
          (mine.overdue.length ? mine.overdue.length + ' overdue, ' : '') +
          mine.soon.length + ' due soon' +
          (mine.rem.length ? ', ' + mine.rem.length + ' reminder(s)' : '') +
          (mine.alerts.length ? ', ' + mine.alerts.length + ' alert(s)' : ''),
        body: body
      });
    }
  }

  /* one mail per address, carrying both its reminders and its activity alerts */
  var others = {};
  var bucket = function (addr) {
    return (others[addr] = others[addr] || { rem: [], alerts: [] });
  };
  out.rem.forEach(function (r) {
    if (!r.addr || r.addr === REMIND_TO) return;
    bucket(r.addr).rem.push(r);
  });
  out.alerts.forEach(function (a) {
    if (!a.r.alertTo || a.r.alertTo === REMIND_TO) return;
    bucket(a.r.alertTo).alerts.push(a);
  });
  for (var addr in others) {
    var o = others[addr];
    var lines = [];
    if (o.rem.length) lines.push(o.rem.map(function (r) { return '• ' + r.text; }).join('\n'));
    if (o.alerts.length) lines.push('COMING UP', o.alerts.map(alertLine_).join('\n'));
    var first = o.rem.length ? o.rem[0].text : o.alerts[0].r.id + ' — ' + o.alerts[0].r.activity;
    var more = o.rem.length + o.alerts.length - 1;
    MailApp.sendEmail({
      to: addr,
      subject: 'Reminder — ' + first + (more > 0 ? ' (+' + more + ')' : ''),
      body: lines.join('\n') + '\n\n— MASDR Compliance Calendar'
    });
  }
}

/* Always sends, even on a quiet day, so you can prove delivery works.
   Run it once from the Apps Script editor. */
function sendTestEmail() {
  var to = REMIND_TO;
  if (!to) throw new Error('Set REMIND_TO at the top of this file first.');
  var out = collect_();
  var body = digestBody_(out);
  MailApp.sendEmail({
    to: to,
    subject: '[TEST] Compliance calendar reminder',
    body: 'This is a test of the compliance calendar reminder email.\n\n' +
          (body || 'Nothing is overdue, nothing falls due within ' + REMIND_DAYS +
                   ' days, and no reminder fires today — so the daily email would stay silent.') +
          '\n\nQuota left today: ' + MailApp.getRemainingDailyQuota() + ' emails.'
  });
  Logger.log('Test email sent to ' + to);
}

/* ── email digest ─────────────────────────────────────────────────── */

