module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed',
      message: 'Only POST requests are accepted at this endpoint.'
    });
  }

  const apiKey = process.env.CROWLLM_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'CROWLLM_API_KEY is not set. Add it as an environment variable in Vercel.'
    });
  }

  const body = req.body || {};
  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: 'Bad request',
      message: 'A non-empty "messages" array is required.'
    });
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object' || typeof m.role !== 'string' || typeof m.content !== 'string') {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Every message must have a string "role" and string "content".'
      });
    }
    if (!['system', 'user', 'assistant'].includes(m.role)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Message role must be "system", "user", or "assistant".'
      });
    }
  }

  const ALLOWED_MODELS = ['kimi-k2-7-code', 'glm-5.2-thinking', 'deepseek-v4-pro-thinking', 'mimo-v2-5', 'minimax-m3'];
  const requestedModel = typeof body.model === 'string' ? body.model : 'mimo-v2-5';
  const model = ALLOWED_MODELS.includes(requestedModel) ? requestedModel : 'mimo-v2-5';

  const MAX_RETRIES = 3;
  const RETRY_DELAYS_MS = [1000, 2000, 4000];

  function isContextLengthError(status, text) {
    if (status === 413) return true;
    if (status !== 400) return false;
    const lower = (text || '').toLowerCase();
    return lower.indexOf('context length') !== -1
        || lower.indexOf('maximum context') !== -1
        || lower.indexOf('too many tokens') !== -1
        || lower.indexOf('reduce the length') !== -1;
  }

  function trimMessages(msgs) {
    if (msgs.length <= 2) return msgs;
    const keepSystem = msgs[0] && msgs[0].role === 'system' ? 1 : 0;
    const tail = msgs.slice(keepSystem + Math.floor((msgs.length - keepSystem) / 2));
    return msgs.slice(0, keepSystem).concat(tail);
  }

  async function attemptChat(currentMessages) {
    return await fetch('https://crowllm.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: currentMessages,
        stream: true
      })
    });
  }

  try {
    let upstream = null;
    let attempts = 0;
    let lastStatus = 0;
    let lastBody = '';
    let currentMessages = messages;
    let trimmedOnce = false;

    outer: for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      attempts = attempt + 1;
      upstream = await attemptChat(currentMessages);
      lastStatus = upstream.status;
      if (upstream.ok) break;
      lastBody = await upstream.text();
      if (upstream.status === 429 && attempt < MAX_RETRIES) {
        await new Promise(function(r) { setTimeout(r, RETRY_DELAYS_MS[attempt]); });
        continue;
      }
      if (!trimmedOnce && isContextLengthError(upstream.status, lastBody)) {
        const next = trimMessages(currentMessages);
        if (next.length < currentMessages.length) {
          currentMessages = next;
          trimmedOnce = true;
          continue outer;
        }
      }
      break;
    }

    if (!upstream || !upstream.ok) {
      return res.status(lastStatus || 502).json({
        error: 'Upstream error',
        message: lastBody
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Milo-Retry-Attempts', String(attempts - 1));
    if (trimmedOnce) res.setHeader('X-Milo-Context-Trimmed', '1');

    try {
      const reader = upstream.body.getReader();
      let done = false;
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (result.value) {
          try { res.write(Buffer.from(result.value)); } catch (_) {}
          if (res.flush) { try { res.flush(); } catch (_) {} }
        }
      }
    } catch (streamErr) {
      console.error('Error streaming upstream response:', streamErr);
      if (!res.headersSent) {
        return res.status(500).json({
          error: 'Stream interrupted',
          message: streamErr.message
        });
      }
    }
    res.end();
  } catch (error) {
    console.error('Error in /api/chat:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};
