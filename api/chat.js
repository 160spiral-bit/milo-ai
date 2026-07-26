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

  const ALLOWED_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];
  const requestedModel = typeof body.model === 'string' ? body.model : 'gpt-4o-mini';
  const model = ALLOWED_MODELS.includes(requestedModel) ? requestedModel : 'gpt-4o-mini';

  try {
    const upstream = await fetch('https://crowllm.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true
      })
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({
        error: 'Upstream error',
        message: text
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = upstream.body.getReader();
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) {
        res.write(Buffer.from(result.value));
        if (res.flush) res.flush();
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
