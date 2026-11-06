export async function applyDshHistory(ctx, config, original, require) {
  const { Readable, Writable } = await import('node:stream');
  const { pathToFileURL } = await import('node:url');
  const { ndJsonStream } = await import(pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href);
  const transport = config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  const writer = transport.writable.getWriter();
  const initialize = new Set();
  const loads = new Map();
  let resumeSupported = false;
  let nativeLoadSupported = false;

  async function content(block) {
    if (block.type === 'text') return block.text ? { type: 'text', text: block.text } : undefined;
    if (block.type !== 'image') return undefined;
    const attachments = ctx.get('attachments');
    if (!attachments) throw new Error('Cannot replay DSH image without the attachment store');
    const stored = await attachments.readImage(block.attachment);
    return { type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: stored.ref.mediaType };
  }

  async function replay(sessionId) {
    const handle = await ctx.sessionPersistence.open(sessionId, 'read');
    let events;
    try { ({ events } = await handle.read()); }
    finally { await handle.close(); }
    const { interruptedTurnClosers } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href);
    events = [...events, ...interruptedTurnClosers(events)];
    const emit = update => writer.write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    for (const event of events) {
      if (event.type === 'user/message' && event.data.source?.kind === 'user') {
        for (const block of event.data.content) {
          const converted = await content(block);
          if (converted) await emit({ sessionUpdate: 'user_message_chunk', messageId: event.data.id, content: converted });
        }
      } else if (event.type === 'assistant/message') {
        const message = event.data.message;
        for (const block of message.content) {
          if (block.type === 'reasoning') {
            if (block.text) await emit({ sessionUpdate: 'agent_thought_chunk', messageId: message.id, content: { type: 'text', text: block.text } });
          } else {
            const converted = await content(block);
            if (converted) await emit({ sessionUpdate: 'agent_message_chunk', messageId: message.id, content: converted });
          }
        }
      } else if (event.type === 'tool/call') {
        let rawInput;
        try { rawInput = JSON.parse(event.data.arguments); }
        catch { rawInput = event.data.arguments; }
        await emit({ sessionUpdate: 'tool_call', toolCallId: event.data.callId, title: event.data.name, kind: 'other', status: 'in_progress', rawInput });
      } else if (event.type === 'tool/result') {
        const message = event.data.message;
        const blocks = [];
        for (const block of message.content) {
          const converted = await content(block);
          if (converted) blocks.push({ type: 'content', content: converted });
        }
        await emit({ sessionUpdate: 'tool_call_update', toolCallId: message.toolCallId,
          status: message.isError === true ? 'failed' : 'completed', content: blocks });
      }
    }
  }

  const readable = transport.readable.pipeThrough(new TransformStream({
    transform(frame, controller) {
      if (frame.method === 'initialize') initialize.add(frame.id);
      if (frame.method === 'session/load' && resumeSupported && !nativeLoadSupported) {
        loads.set(frame.id, frame.params.sessionId);
        controller.enqueue({ ...frame, method: 'session/resume' });
      } else controller.enqueue(frame);
    },
  }));
  const writable = new WritableStream({
    async write(frame) {
      if (initialize.delete(frame.id) && frame.result) {
        const capabilities = frame.result.agentCapabilities;
        resumeSupported = capabilities?.sessionCapabilities?.resume !== undefined;
        nativeLoadSupported = capabilities?.loadSession === true;
        if (resumeSupported && !nativeLoadSupported) {
          frame = { ...frame, result: { ...frame.result, agentCapabilities: { ...capabilities, loadSession: true } } };
        }
      }
      const sessionId = loads.get(frame.id);
      if (sessionId !== undefined && ('result' in frame || 'error' in frame)) {
        loads.delete(frame.id);
        if ('result' in frame) {
          try { await replay(sessionId); }
          catch (error) {
            ctx.logger.warn(`paseo-dsh: history replay failed: ${String(error)}`);
            await writer.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'Unable to replay persisted DSH session history' } });
            return;
          }
        }
      }
      await writer.write(frame);
    },
    close: () => writer.close(),
    abort: reason => writer.abort(reason),
  });
  return original.apply(ctx, { ...config, stream: { readable, writable } });
}
