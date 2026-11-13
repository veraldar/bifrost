/** Push subscription registry: the client POSTs its PushSubscription after
 *  granting notification permission; GET exposes the VAPID public key. */
import { NextResponse } from 'next/server';
import { addSub, publicKey, removeSub } from '@/lib/push';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ publicKey: publicKey() });
}

export async function POST(req: Request) {
  try {
    const sub = await req.json();
    await addSub(sub);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { endpoint } = await req.json();
    if (endpoint) await removeSub(endpoint);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
