import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.DATABASE_ID || '5c87a7f3e3ff4a5fb96bc77c0871fd7e';
const API_KEY      = process.env.API_KEY;

app.use(cors());
app.use(express.json());

// Auth middleware — applied to all routes except health check
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // no key set = open (shouldn't happen in prod)
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

// Health check (no auth — used to verify the proxy is reachable)
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Outreach Tracker proxy running' }));

// All data routes require API key
app.use('/entries', requireApiKey);

// GET all entries (paginated — fetches all results)
app.get('/entries', async (req, res) => {
  try {
    let allResults = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const body = { page_size: 100 };
      if (startCursor) body.start_cursor = startCursor;

      const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: notionHeaders(),
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);

      allResults = allResults.concat(data.results);
      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    const entries = allResults.map(page => ({
      notionId: page.id,
      firm:     page.properties['Firm']?.title?.[0]?.plain_text || '',
      partner:  page.properties['Partner']?.rich_text?.[0]?.plain_text || '',
      page:     page.properties['Page']?.select?.name === 'Other' ? 'other' : page.properties['Page']?.select?.name === 'Targets' ? 'targets' : 'law',
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

// POST create entry
app.post('/entries', async (req, res) => {
  try {
    const e = req.body;
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify(buildNotionPage(e))
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json({ notionId: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update entry
app.patch('/entries/:id', async (req, res) => {
  try {
    const e = req.body;
    const response = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH',
      headers: notionHeaders(),
      body: JSON.stringify({ properties: buildNotionPage(e).properties })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE endpoint disabled — deletions are local only
// app.delete('/entries/:id', ...) removed for safety

function buildNotionPage(e) {
  const props = {
    'Firm':    { title: [{ text: { content: e.firm || '' } }] },
    'Partner': { rich_text: [{ text: { content: e.partner || '' } }] },
    'Page':    { select: { name: e.page === 'other' ? 'Other' : e.page === 'targets' ? 'Targets' : 'Law Firms' } },
    'Status':  { select: { name: statusToLabel(e.status) } },
    'Priority':{ select: { name: capitalize(e.priority || 'medium') } },
    'Notes':   { rich_text: [{ text: { content: e.notes || '' } }] }
  };
  if (e.date)     props['Date Contacted'] = { date: { start: e.date } };
  if (e.followup) props['Follow-up Due']  = { date: { start: e.followup } };
  return { parent: { database_id: DATABASE_ID }, properties: props };
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
