module.exports = async function handler(req, res) {
  // Only allow POST requests from the chat UI.
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

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: 'Bad request',
      message: 'A non-empty "messages" array is required.'
    });
  }

  try {
    const upstream = await fetch('https://crowllm.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
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

    // Stream the upstream response back to the browser as Server-Sent Events.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // The fetch body is a Web ReadableStream; read it and write it to the response.
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
