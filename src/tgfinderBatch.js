// Shared TG Finder plumbing used by both the in-app search routes (server.js)
// and the agent-payable x402 endpoint, so there is exactly one place that knows
// how to talk to TG Finder and one place that shapes its results.

// TG Finder's ApiBatch → the trimmed shape we store and serve.
// (tgfinder/src/lib/api/serialize.ts: { status, credits_used, results: [{domain, status, result: ApiDomainResult|null, …}] })
export function summarizeBatch(body) {
  const isTerminal = ['completed', 'failed'].includes(body?.status);
  const resultSummary = isTerminal && Array.isArray(body.results)
    ? body.results.filter(entry => entry.result).map(entry => ({
        company_name: entry.result.company_name,
        // Project-level links (raw — the client validates them before rendering). Telegram prefers the channel TG Finder
        // actually resolved over the link scraped off the website.
        project_x:        entry.result.project_x?.handle || entry.result.social_links?.twitter || null,
        website:          entry.result.social_links?.website || null,
        telegram_channel: entry.result.telegram_channel?.username || entry.result.social_links?.telegram || null,
        team_members: (entry.result.team_members || []).map(m => ({
          display_name: m.display_name, role: m.role, telegram_username: m.telegram_username, confidence: m.confidence,
          // Every link TG Finder found for the person. Members are discovered via their X profile, so x_handle is
          // normally set — except CSV-imported ones (no x_url), where x_handle just echoes the Telegram username.
          x_handle: m.x_url ? (m.x_handle || null) : null,
          website: m.website || null,
        })),
      }))
    : null;
  return { isTerminal, resultSummary };
}

// Starts a TG Finder batch. Returns { ok, status, body } — never throws on HTTP errors,
// only on network failure/timeouts (callers already wrap this in try/catch).
export async function createBatch(domains, { apiKey, apiBase }) {
  const r = await fetch(`${apiBase}/batches`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ domains }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

// Re-checks a still-running batch with TG Finder and persists progress/result onto the
// tg_finder_searches row. Returns { status, progress, result, error }; on a transient
// TG Finder error it returns the row's current status so the caller's client just retries.
export async function refreshSearchRow(supabase, row, { apiKey, apiBase }) {
  const r = await fetch(`${apiBase}/batches/${row.tgfinder_batch_id}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) return { status: row.status, progress: null, result: null, error: null };
  const body = await r.json();
  const { isTerminal, resultSummary } = summarizeBatch(body);

  await supabase.from('tg_finder_searches').update({
    status: body.status,
    result_summary: resultSummary,
    credits_charged: body.credits_used || 0,
    completed_at: isTerminal ? new Date().toISOString() : null,
    error: body.error?.message || null,
  }).eq('id', row.id);

  return { status: body.status, progress: body.progress || null, result: resultSummary, error: body.error?.message || null };
}
