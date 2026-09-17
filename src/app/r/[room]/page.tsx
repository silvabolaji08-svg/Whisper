import { redirect } from "next/navigation";

import ChatRoom from "@/components/ChatRoom";
import { currentUser } from "@/lib/auth/session";
import { normalizeRoom } from "@/lib/types";
import { serverSocketPath } from "@/lib/realtime/protocol";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ room: string }>;
}) {
  const { room } = await params;
  const slug = normalizeRoom(decodeURIComponent(room));

  // Send anything that is not already a clean slug back through the join screen
  // (or to its normalized form) so one room never splits across two URLs.
  if (!slug) redirect("/");
  if (slug !== room) redirect(`/r/${slug}`);

  // Bounce to sign-in, remembering the room so the link still works after.
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/r/${slug}`)}`);

  return (
    <ChatRoom
      room={slug}
      displayName={user.displayName}
      socketPath={serverSocketPath()}
    />
  );
}
