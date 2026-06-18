import { NextRequest, NextResponse } from 'next/server';
import { getAuthUrl } from '@/lib/gmail';

// GET /api/gmail/connect — redirect to Google OAuth consent screen
export async function GET(request: NextRequest) {
  const authUrl = getAuthUrl();
  return NextResponse.redirect(authUrl);
}
