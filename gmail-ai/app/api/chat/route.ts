import { NextRequest, NextResponse } from 'next/server';
import { chatWithEmails } from '@/lib/rag';
import { type ChatMessage } from '@/lib/ai';

// POST /api/chat
// Body: { query: string; history: ChatMessage[]; userId?: string; gmailAccountId?: string }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { query, history = [], userId, gmailAccountId } = body;

    if (!query?.trim()) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    // Set up SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const chatHistory: ChatMessage[] = history.map(
            (m: { role: string; content: string }) => ({
              role: m.role as 'user' | 'model',
              content: m.content,
            })
          );

          for await (const chunk of chatWithEmails(query, chatHistory, gmailAccountId)) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          console.error('Chat stream error:', err);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: 'Stream error: ' + String(err) })}\n\n`
            )
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    console.error('Chat route error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
