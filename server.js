import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;
const NOTION_TOKEN   = process.env.NOTION_TOKEN;
const DATABASE_ID    = process.env.DATABASE_ID    || '5c87a7f3e3ff4a5fb96bc77c0871fd7e';
const TARGETS_DB_ID  = process.env.TARGETS_DB_ID  || '169617c99b5e42f09542d1aba892fdaf';
const API_KEY        = process.env.API_KEY;

app.use(cors());
app.use(express.json());

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const notionHeaders = () => ({
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28'
});

async function queryAll(databaseId) {
  let allResults = [];
  let hasMore = true;
  let startCursor = undefined;
  while (hasMore) {
    const body = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST', headers: notionHeaders(), body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || response.statusText);
    allResults = allResults.concat(data.results);
    hasMore = data.has_more;
    startCursor = data.next_cursor;
  }
  return allResults;
}

// Health check (no auth)
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Outreach Tracker proxy running' }));

// OUTREACH ENTRIES (Law Firms / Other)
app.use('/entries', requireApiKey);

app.get('/entries', async (req, res) => {
  try {
    const results = await queryAll(DATABASE_ID);
    const entries = results.map(page => ({
      notionId: page.id,
      firm:     page.properties['Firm']?.title?.[0]?.plain_text || '',
      partner:  page.properties['Partner']?.rich_text?.[0]?.plain_text || '',
      page:     page.properties['Page']?.select?.name === 'Other' ? 'other' : 'law',
      status:   statusToKey(page.properties['Status']?.select?.name),
      priority: (page.properties['Priority']?.select?.name || 'Medium').toLowerCase(),
      date:     page.properties['Date Contacted']?.date?.start || '',
      followup: page.properties['Follow-up Due']?.date?.start || '',
      notes:    page.properties['Notes']?.rich_text?.[0]?.plain_text || ''
    }));
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/entries', async (req, res) => {
  try {
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST', headers: notionHeaders(),
      body: JSON.stringify(buildEntryPage(req.body))
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json({ notionId: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/entries/:id', async (req, res) => {
  try {
    const response = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders(),
      body: JSON.stringify({ properties: buildEntryPage(req.body).properties })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildEntryPage(e) {
  const props = {
    'Firm':    { title: [{ text: { content: e.firm || '' } }] },
    'Partner': { rich_text: [{ text: { content: e.partner || '' } }] },
    'Page':    { select: { name: e.page === 'other' ? 'Other' : 'Law Firms' } },
    'Status':  { select: { name: statusToLabel(e.status) } },
    'Priority':{ select: { name: capitalize(e.priority || 'medium') } },
    'Notes':   { rich_text: [{ text: { content: e.notes || '' } }] }
  };
  if (e.date)     props['Date Contacted'] = { date: { start: e.date } };
  if (e.followup) props['Follow-up Due']  = { date: { start: e.followup } };
  return { parent: { database_id: DATABASE_ID }, properties: props };
}

// TARGET FIRMS (separate database)
app.use('/targets', requireApiKey);

app.get('/targets', async (req, res) => {
  try {
    const results = await queryAll(TARGETS_DB_ID);
    const targets = results.map(page => ({
      notionId: page.id,
      name:     page.properties['Firm']?.title?.[0]?.plain_text || '',
      notes:    page.properties['Notes']?.rich_text?.[0]?.plain_text || '',
      applied:  page.properties['Applied']?.checkbox || false
    }));
    res.json(targets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/targets', async (req, res) => {
  try {
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST', headers: notionHeaders(),
      body: JSON.stringify(buildTargetPage(req.body))
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json({ notionId: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/targets/:id', async (req, res) => {
  try {
    const response = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders(),
      body: JSON.stringify({ properties: buildTargetPage(req.body).properties })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildTargetPage(t) {
  return {
    parent: { database_id: TARGETS_DB_ID },
    properties: {
      'Firm':    { title: [{ text: { content: t.name || '' } }] },
      'Notes':   { rich_text: [{ text: { content: t.notes || '' } }] },
      'Applied': { checkbox: !!t.applied }
    }
  };
}

const STATUS_MAP = {
  'Contacted': 'contacted', 'Responded': 'responded',
  'Assessment Received': 'assessment', 'Assessment Completed': 'assessment_done',
  'Meeting Scheduled': 'meeting', 'Offered': 'offered',
  'Rejected': 'rejected', 'Follow-up': 'followup'
};
const STATUS_LABEL = Object.fromEntries(Object.entries(STATUS_MAP).map(([k,v])=>[v,k]));

function statusToKey(label)  { return STATUS_MAP[label] || 'contacted'; }
function statusToLabel(key)  { return STATUS_LABEL[key] || 'Contacted'; }
function capitalize(s)       { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
