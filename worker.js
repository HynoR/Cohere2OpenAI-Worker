export default {
  async fetch(req, env, ctx) {
    const { headers, method, url } = req;
    const search = new URL(url).searchParams;

    if (method === "OPTIONS") {
      return new Response("", {
        headers: {
          'Access-Control-Allow-Origin': '*',
          "Access-Control-Allow-Headers": '*'
        },
        status: 204
      });
    }

    if (!headers.get('authorization')) {
      return new Response("403 Auth Required", {
        headers: {
          'Access-Control-Allow-Origin': '*',
          "Access-Control-Allow-Headers": '*'
        },
        status: 403
      });
    }

    let body;
    try {
      body = await req.json();
    } catch (e) {
      body = {
        "messages": [{ "role": "user", "content": search.get('q') || "hello" }],
        "temperature": 0.5,
        "presence_penalty": 0,
        "frequency_penalty": 0,
        "top_p": 1,
        stream: true
      };
    }

    const data = prepareData(body, search);

    //console.log(data)

    const resp = await fetch('https://api.cohere.ai/v1/chat', {
      method: "POST",
      body: JSON.stringify(data),
      headers: {
        'content-type': 'application/json',
        "Authorization": headers.get('authorization') || `bearer ${search.get('key')}`
      }
    });

    if (resp.status !== 200) return resp;

    const created = Date.now() / 1000 | 0;

    if (!data.stream) {
      return handleNonStreamResponse(resp, data, created);
    }

    return handleStreamResponse(resp, data, created);
  },
};

function prepareData(body, search) {
  const data = {
    chat_history: [],
    message: '',
    stream: body.stream === true,
    model: search.get('model') || "command-r"
  };

  body.messages.forEach((msg, i) => {
    if (i < body.messages.length - 1) {
      data.chat_history.push({
        "role": msg.role === "assistant" ? "CHATBOT" : msg.role.toUpperCase(),
        "message": msg.content
      });
    } else {
      data.message = msg.content;
    }
  });

  if ((body.model + "").startsWith("net-")) data.connectors = [{ "id": "web-search" }];
  if ((body.model + "").startsWith("tools-")) data.tools = [{ name: "internet_search" }, { name: "calculator" }, { name: "python_interpreter" }];

  Object.keys(body).forEach(key => {
    if (!/^(model|messages|stream)/i.test(key)) data[key] = body[key];
  });

  if (/^(net-|tools-)?command/.test(body.model)) {
    data.model = body.model.replace(/^(net-|tools-)/, "");
  }

  return data;
}

async function handleNonStreamResponse(resp, data, created) {
  let ddd;
  try {
    ddd = await resp.json();
  } catch (e) {
    ddd = { error: e.message };
  }

  return new Response(JSON.stringify({
    "id": "chatcmpl-QXlha2FBbmROaXhpZUFyZUF3ZXNvbWUK",
    "object": "chat.completion",
    "created": created,
    "model": data.model,
    "choices": [{
      "index": 0,
      "message": {
        "role": "assistant",
        "content": ddd.text || ddd.error
      },
      "logprobs": null,
      "finish_reason": "stop"
    }],
    "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
    "system_fingerprint": null
  }), {
    headers: {
      'Access-Control-Allow-Origin': '*',
      "Access-Control-Allow-Headers": '*',
      'Content-Type': 'application/json; charset=UTF-8'
    },
    status: resp.status
  });
}

function handleStreamResponse(resp, data, created) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  processStream(resp.body, writer, data, created);

  return new Response(readable, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      "Access-Control-Allow-Headers": '*',
      'Content-Type': 'text/event-stream; charset=UTF-8'
    },
    status: resp.status
  });
}

async function processStream(body, writer, data, created) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { stream: true });
  const encoder = new TextEncoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const messages = buffer.split('\n');
      buffer = messages.pop();

      for (const message of messages) {
        if (!message) continue;
        try {
          const msg = JSON.parse(message);
          await processMessage(msg, writer, encoder, data, created);
        } catch (e) {
          console.error('Error processing message:', e);
        }
      }
    }
  } finally {
    await writer.close();
  }
}

async function processMessage(msg, writer, encoder, data, created) {
  if (msg.event_type === 'tool-calls-generation') return;

  if (msg.event_type === 'search-results' && msg.search_results[0]?.search_query?.text) {
    const tools = JSON.parse(msg.search_results[0].search_query.text);
    let content = JSON.stringify(tools.parameters)
    if (tools.tool_name==='python_interpreter'){
      tools.tool_name = 'python'
      content = tools.parameters.code
    }else if (tools.tool_name==='internet_search'){
      tools.tool_name = 'txt'
      content = "Internet Search:" + tools.parameters.query
    }else if (tools.tool_name==='calculator'){
      content = "Calc:" + tools.parameters.expression
    }
    msg.text = `\n\`\`\`${tools.tool_name}\n${content}\n\`\`\`\n`;
  }

  if (msg.text) {
    const chunk = {
      "id": "chatcmpl-QXlha2FBbmROaXhpZUFyZUF3ZXNvbWUK",
      "object": "chat.completion.chunk",
      "created": created,
      "model": data.model,
      "choices": [{
        "index": 0,
        "delta": { "role": "assistant", "content": msg.text },
        "finish_reason": null
      }]
    };
    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }

  if (msg.is_finished) {
    const finalChunk = {
      "id": "chatcmpl-QXlha2FBbmROaXhpZUFyZUF3ZXNvbWUK",
      "object": "chat.completion.chunk",
      "created": created,
      "model": data.model,
      "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }]
    };
    await writer.write(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
  }
}

